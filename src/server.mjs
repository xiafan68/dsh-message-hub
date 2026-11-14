/**
 * server.mjs —— 面板与模型共用的 BFF 路由（宿主侧，零框架依赖）。
 *
 * 全部挂在 `/message-hub/api` 前缀下，不与宿主或别的插件抢路径：
 *
 *   GET    /status                     本地服务健康 + 选中态摘要（面板首屏）
 *   POST   /service/start              拉起内置引擎（首次会先建 venv、装依赖）
 *   GET    /overview                   计数 / 活跃源 / 最近运行
 *   GET    /feeds                      订阅源列表（含状态、间隔、条目数）
 *   POST   /feeds                      新增订阅源（写）
 *   POST   /feeds/<id>/enable|disable  启停（写）
 *   POST   /feeds/<id>/run             立刻采一次（写，慢，60s 超时）
 *   DELETE /feeds/<id>                 删除（软删，写）
 *   GET    /items                      条目流（?q=&source_id=&liked=&from_date=&to_date=&limit=&offset=）
 *   POST   /items/<id>/like|unlike     收藏（写）
 *   GET    /selection                  当前选中（?session=<id>）
 *   POST   /selection                  面板上报选中 {"sessionId": "...", "selection": {...}}
 *   DELETE /selection                  清空选中
 *   GET    /preferences                关注方向
 *
 * 写操作一律要求同源 Origin（浏览器链路由 DSH 连接层鉴权，这里只挡跨站）。
 */

export const ROUTE_PREFIX = '/message-hub/api';

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let exceeded = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      if (!exceeded) chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) {
        reject(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  // 非浏览器客户端（curl / 测试）没有 Origin：DSH 连接层已经鉴权，放行。
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 服务错误 → 可执行的 HTTP 回应。前端据此显示「服务没起」而不是一片红。 */
function sendServiceError(res, err) {
  const code = err && err.code ? err.code : 'error';
  const status = code === 'service-down' || code === 'service-timeout' ? 503
    : code === 'unauthorized' ? 401
      : code === 'forbidden' ? 403
        : 502;
  sendJson(res, status, {
    ok: false,
    code,
    message: String(err && err.message ? err.message : err),
    hint: code === 'service-down'
      ? '本机引擎没在跑：执行 POST /message-hub/api/service/start（首次会自动准备 venv 与依赖），或查看 runtimeDir 下的 service.log'
      : undefined,
  });
}

/**
 * @param {{
 *   service: ReturnType<typeof import('./service.mjs').createService>,
 *   selection: ReturnType<typeof import('./service.mjs').openSelectionStore>,
 *   ensureStarted?: () => Promise<{ok: boolean, message?: string}>,
 *   log?: (msg: string) => void,
 *   maxBodyBytes?: number,
 * }} deps
 */
export function createApi({ service, selection, ensureStarted, dataDir = '', log = () => {}, maxBodyBytes = 16_384 }) {
  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch {
      sendJson(res, 400, { ok: false, code: 'bad-url' });
      return;
    }
    const route = url.pathname;
    if (!route.startsWith(ROUTE_PREFIX)) {
      sendJson(res, 404, { ok: false, code: 'not-found' });
      return;
    }
    const tail = route.slice(ROUTE_PREFIX.length) || '/';
    const method = req.method || 'GET';
    const isWrite = method !== 'GET' && method !== 'HEAD';
    if (isWrite && !sameOrigin(req)) {
      sendJson(res, 403, { ok: false, code: 'cross-origin' });
      return;
    }

    // ---- 状态与自愈 -------------------------------------------------------
    if (method === 'GET' && (tail === '/status' || tail === '/health')) {
      const probe = await service.probe();
      sendJson(res, 200, {
        ok: true,
        service: probe.ok
          ? { ok: true, health: probe.health }
          : { ok: false, code: probe.code, message: probe.message },
        apiBase: service.base,
        // 数据目录由插件配置决定（服务启动时用 --database 指过去），这里回报给面板与排障用
        dataDir: dataDir || '',
        selection: selection.get(url.searchParams.get('session') || ''),
      });
      return;
    }

    if (method === 'POST' && tail === '/service/start') {
      if (typeof ensureStarted !== 'function') {
        sendJson(res, 200, { ok: false, code: 'no-autostart', message: '宿主未提供自动启动' });
        return;
      }
      try {
        const result = await ensureStarted();
        sendJson(res, 200, { ok: Boolean(result && result.ok), message: result && result.message });
      } catch (err) {
        sendJson(res, 500, { ok: false, code: 'start-failed', message: String(err && err.message ? err.message : err) });
      }
      return;
    }

    // ---- 选中态 -----------------------------------------------------------
    if (tail === '/selection') {
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, selection: selection.get(url.searchParams.get('session') || '') });
        return;
      }
      if (method === 'POST') {
        try {
          const raw = await readBody(req, maxBodyBytes);
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { sendJson(res, 400, { ok: false, code: 'bad-json' }); return; }
          const sessionId = parsed && typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
          const payload = parsed ? parsed.selection : null;
          selection.put(sessionId, normaliseSelection(payload));
          sendJson(res, 200, { ok: true, selection: selection.get(sessionId) });
        } catch (err) {
          if (err && err.code === 'TOO_LARGE') { sendJson(res, 413, { ok: false, code: 'too-large' }); return; }
          sendJson(res, 500, { ok: false, code: 'error', message: String(err && err.message ? err.message : err) });
        }
        return;
      }
      if (method === 'DELETE') {
        selection.clear(url.searchParams.get('session') || '');
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 405, { ok: false, code: 'method-not-allowed' });
      return;
    }

    // ---- 透传到 Python 服务 ----------------------------------------------
    try {
      if (method === 'GET' && tail === '/overview') {
        const [overview, runs] = await Promise.all([
          service.overview(),
          service.runs(5).catch(() => ({ items: [] })),
        ]);
        sendJson(res, 200, { ok: true, ...overview, recent_runs: (runs && runs.items) || [] });
        return;
      }

      if (method === 'GET' && tail === '/feeds') {
        const [monitors, overview] = await Promise.all([
          service.monitors(),
          service.overview().catch(() => null),
        ]);
        sendJson(res, 200, { ok: true, items: (monitors && monitors.items) || [], counts: overview || null });
        return;
      }

      if (method === 'POST' && tail === '/feeds') {
        const raw = await readBody(req, maxBodyBytes);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { sendJson(res, 400, { ok: false, code: 'bad-json' }); return; }
        const created = await service.createMonitor(parsed);
        sendJson(res, 201, { ok: true, monitor: created });
        return;
      }

      if (method === 'POST' && tail === '/feeds/run-all') {
        if (!service || typeof service.runAll !== 'function') {
          sendJson(res, 503, { ok: false, code: 'unsupported' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        const summary = await service.runAll({ concurrency: 2 });
        sendJson(res, 200, { ok: true, summary });
        return;
      }

      const feedAction = tail.match(/^\/feeds\/([^/]+)\/(enable|disable|run)$/);
      if (method === 'POST' && feedAction) {
        const id = decodeURIComponent(feedAction[1]);
        const action = feedAction[2];
        if (action === 'run') {
          const result = await service.runMonitor(id);
          sendJson(res, 200, { ok: true, result });
          return;
        }
        const monitor = await service.setMonitorEnabled(id, action === 'enable');
        sendJson(res, 200, { ok: true, monitor });
        return;
      }

      const feedId = tail.match(/^\/feeds\/([^/]+)$/);
      if (method === 'DELETE' && feedId) {
        await service.deleteMonitor(decodeURIComponent(feedId[1]));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && tail === '/items') {
        const feed = await service.feed({
          source_id: url.searchParams.get('source_id') || undefined,
          q: url.searchParams.get('q') || undefined,
          liked: url.searchParams.get('liked') === 'true' ? true : undefined,
          from_date: url.searchParams.get('from_date') || undefined,
          to_date: url.searchParams.get('to_date') || undefined,
          limit: url.searchParams.get('limit') || undefined,
          offset: url.searchParams.get('offset') || undefined,
        });
        sendJson(res, 200, { ok: true, ...feed });
        return;
      }

      const itemAction = tail.match(/^\/items\/([^/]+)\/(like|unlike)$/);
      if (method === 'POST' && itemAction) {
        const id = decodeURIComponent(itemAction[1]);
        const result = itemAction[2] === 'like' ? await service.like(id) : await service.unlike(id);
        sendJson(res, 200, { ok: true, item: result });
        return;
      }

      if (method === 'GET' && tail === '/preferences') {
        const prefs = await service.preferences();
        sendJson(res, 200, { ok: true, ...prefs });
        return;
      }

      // 关注偏好是"整份覆盖"语义（服务端 PUT /api/v1/preferences），不是增量打补丁
      if (method === 'PUT' && tail === '/preferences') {
        const raw = await readBody(req, maxBodyBytes);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { sendJson(res, 400, { ok: false, code: 'bad-json' }); return; }
        const directions = parsed && parsed.directions;
        if (!Array.isArray(directions) || directions.some((item) => typeof item !== 'string')) {
          sendJson(res, 400, { ok: false, code: 'bad-directions', message: 'directions 必须是字符串数组' });
          return;
        }
        const saved = await service.setPreferences(directions);
        sendJson(res, 200, { ok: true, ...saved });
        return;
      }

      // ---- 每日精选（curation_collections） ---------------------------------
      if (method === 'GET' && (tail === '/digest' || tail === '/curations')) {
        const list = await service.curations({
          kind: url.searchParams.get('kind') || undefined,
          limit: url.searchParams.get('limit') || 20,
        });
        sendJson(res, 200, { ok: true, ...list });
        return;
      }

      const digestId = tail.match(/^\/(?:digest|curations)\/([^/]+)$/);
      if (method === 'GET' && digestId) {
        const collection = await service.curation(decodeURIComponent(digestId[1]));
        if (!collection) {
          sendJson(res, 404, { ok: false, code: 'not-found', message: '没有这一期精选' });
          return;
        }
        sendJson(res, 200, { ok: true, collection });
        return;
      }

      sendJson(res, 404, { ok: false, code: 'not-found', route: tail });
    } catch (err) {
      if (err && err.code === 'TOO_LARGE') { sendJson(res, 413, { ok: false, code: 'too-large' }); return; }
      if (err && typeof err.code === 'string' && err.code.startsWith('http-')) {
        log(`上游服务报错 ${err.code}：${err.message}`);
      }
      sendServiceError(res, err);
    }
  }

  function registerWebServer(webServer) {
    return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
  }

  return { handler, registerWebServer };
}

/**
 * 选中态只收白名单字段：面板上报的是"用户在看的什么"，不是任意 payload。
 * 这样模型读到的结构永远稳定，也不会因为前端多塞字段而变胖。
 */
export function normaliseSelection(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const kind = payload.kind === 'source' ? 'source' : 'item';
  // id 可能是数字（条目 id 就是整数），统一转字符串：模型侧与前端都按字符串比对。
  const pick = (value, max = 400) => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
    return typeof value === 'string' ? value.slice(0, max) : '';
  };
  const out = {
    kind,
    id: pick(payload.id, 120),
    title: pick(payload.title, 300),
    source_id: pick(payload.source_id, 120),
    source_name: pick(payload.source_name, 160),
    url: pick(payload.url, 600),
    created_at: pick(payload.created_at, 60),
    summary: pick(payload.summary, 1200),
    liked: payload.liked === true,
  };
  if (!out.id && !out.title) return null;
  return out;
}