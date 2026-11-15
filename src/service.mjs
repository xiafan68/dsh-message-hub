/**
 * service.mjs —— 与本地 Python 服务（message-subscriptions）对话的**唯一**边界。
 *
 * 为什么不让浏览器直接打 4001：
 *   1. 写接口要 Bearer Token，token 不能进浏览器 localStorage（也没必要）；
 *   2. 4001 是 Python 服务自己的口子，跨源还要处理 CORS；
 *   3. 宿主已经鉴权过连接层，浏览器只跟 /message-hub/api 说话，边界单一。
 *
 * 为什么不在插件里直接读 SQLite：
 *   SQLite 里只有"结果"，没有采集器与配置校验。新增订阅源要走 Python 侧的
 *   validate_source_config + sync_monitors，自己写一遍必然漂移。所以本插件是
 *   **BFF**（Backend for Frontend），不复制业务。
 *
 * 失败语义（都收敛成 HubServiceError，code 稳定，上层据此给可执行提示）：
 *   service-down    连不上（服务没起 / 端口变了）
 *   service-timeout 超时
 *   unauthorized    401（没带 token）
 *   forbidden       403（token 不对）
 *   http-<status>   其它非 2xx
 */

export const DEFAULT_API_BASE = 'http://127.0.0.1:4001';
export const DEFAULT_TOKEN_FILE = '~/.config/message-subscriptions/api-token';

export class HubServiceError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'HubServiceError';
    this.code = code;
    this.status = status;
  }
}

/** 把 2xx 之外的状态折成稳定 code；detail 优先取服务端给的可读字段。 */
function errorForStatus(status, parsed, rawBody) {
  const detail = parsed && (parsed.detail ?? parsed.message ?? parsed.error);
  const text = typeof detail === 'string'
    ? detail
    : detail === undefined || detail === null
      ? String(rawBody || '').slice(0, 200)
      : JSON.stringify(detail);
  if (status === 401) return new HubServiceError(`本地服务要求鉴权（401）：${text}`, 'unauthorized', status);
  if (status === 403) return new HubServiceError(`本地服务拒绝了 token（403）：${text}`, 'forbidden', status);
  return new HubServiceError(`本地服务返回 ${status}：${text}`, `http-${status}`, status);
}

/**
 * @param {{apiBase?: string, token?: string, timeoutMs?: number, log?: (msg: string) => void}} opts
 */
export function createService({ apiBase = DEFAULT_API_BASE, token = '', timeoutMs = 8000, log = () => {} } = {}) {
  const base = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const bearer = String(token || '').trim();

  async function request(path, { method = 'GET', body, timeout = timeoutMs } = {}) {
    const url = `${base}${path}`;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const name = err && err.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new HubServiceError(
        `本地消息订阅服务不可达（${base}）：${err && err.message ? err.message : String(err)}`,
        timedOut ? 'service-timeout' : 'service-down',
      );
    }

    const raw = await response.text();
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
    }
    if (!response.ok) throw errorForStatus(response.status, parsed, raw);
    return parsed;
  }

  return {
    base,
    request,
    /** 探活：只反映服务能不能答话，不抛错（面板要按它显示灰点）。 */
    async probe() {
      try {
        const health = await request('/api/v1/health', { timeout: 2500 });
        return { ok: true, health };
      } catch (err) {
        return { ok: false, code: err && err.code, message: err && err.message };
      }
    },
    health: () => request('/api/v1/health', { timeout: 4000 }),
    overview: () => request('/api/v1/overview'),
    monitors: () => request('/api/v1/monitors'),
    createMonitor: (payload) => request('/api/v1/monitors', { method: 'POST', body: payload }),
    setMonitorEnabled: (id, enabled) => request(
      `/api/v1/monitors/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' },
    ),
    deleteMonitor: (id) => request(`/api/v1/monitors/${encodeURIComponent(id)}`, { method: 'DELETE', timeout: 10000 }),
    runMonitor: (id) => request(`/api/v1/monitors/${encodeURIComponent(id)}/run`, { method: 'POST', timeout: 60000 }),
    /**
     * 批量采集：按并发跑所有启用的源，单个源失败只记账不中断。
     * 面板「全部采集」、定时采集和 POST /feeds/run-all 都走这里，语义只有一份。
     */
    async runAll({ concurrency = 2, onProgress = () => {} } = {}) {
      const monitors = await request('/api/v1/monitors');
      const list = ((monitors && monitors.items) || []).filter((item) => item && item.enabled !== false);
      const results = [];
      let cursor = 0;
      const workers = Math.max(1, Math.min(concurrency, list.length));
      async function worker() {
        while (cursor < list.length) {
          const monitor = list[cursor++];
          const started = Date.now();
          try {
            const result = await request(`/api/v1/monitors/${encodeURIComponent(monitor.id)}/run`, {
              method: 'POST',
              timeout: 60000,
            });
            results.push({
              id: monitor.id,
              ok: true,
              status: (result && result.status) || '',
              fetched: (result && result.fetched_count) || 0,
              created: (result && result.new_count) || 0,
              ms: Date.now() - started,
            });
          } catch (err) {
            results.push({
              id: monitor.id,
              ok: false,
              code: (err && err.code) || 'error',
              error: (err && err.message) || String(err),
              ms: Date.now() - started,
            });
          }
          try { onProgress(results.length, list.length, monitor.id); } catch { /* 进度回调不该影响采集 */ }
        }
      }
      await Promise.all(Array.from({ length: workers }, worker));
      const failed = results.filter((item) => !item.ok).length;
      return { total: list.length, succeeded: results.length - failed, failed, results };
    },
    feed: (params = {}) => request(`/api/v1/feed?${new URLSearchParams(cleanParams(params)).toString()}`),
    like: (id) => request(`/api/v1/feed/${encodeURIComponent(id)}/like`, { method: 'POST' }),
    unlike: (id) => request(`/api/v1/feed/${encodeURIComponent(id)}/like`, { method: 'DELETE' }),
    deleteItem: (id) => request(`/api/v1/feed/${encodeURIComponent(id)}`, { method: 'DELETE', timeout: 15000 }),
    deleteItems: (ids) => request('/api/v1/feed/delete', { method: 'POST', body: { ids }, timeout: 15000 }),
    preferences: () => request('/api/v1/preferences'),
    // PUT 是整份覆盖：服务端会去空白、去重，并回传归一化后的列表
    setPreferences: (directions) => request('/api/v1/preferences', { method: 'PUT', body: { directions } }),
    curations: ({ kind = '', limit = 20 } = {}) => request(`/api/v1/curations?${new URLSearchParams(cleanParams({ kind, limit })).toString()}`),
    curation: (id) => request(`/api/v1/curations/${encodeURIComponent(id)}`),
    runs: (limit = 20) => request(`/api/v1/runs?${new URLSearchParams({ limit: String(limit) }).toString()}`),
  };
}

/** 去掉 undefined/null/空串，避免把 "undefined" 当查询值发出去。 */
export function cleanParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  }
  return out;
}

/**
 * 选中态寄存处：面板选中什么，模型就能读到什么。
 *
 * 为什么要按 sessionId 分开：同一个 DSH 里可能有多个会话，A 会话在看 anthropic-news，
 * B 会话不该被 A 的选中污染。没有 sessionId（面板还没拿到会话作用域）时落进
 * `_global`，读取方优先取自己会话的，没有就退回全局最近一次。
 */
export function openSelectionStore({ ttlMs = 6 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const bySession = new Map();

  function put(sessionId, selection) {
    const key = sessionId || '_global';
    if (selection === null || selection === undefined) {
      bySession.delete(key);
      return null;
    }
    const record = { selection, at: now() };
    bySession.set(key, record);
    return record;
  }

  function fresh(record) {
    return record && now() - record.at <= ttlMs ? record : null;
  }

  function get(sessionId) {
    const own = fresh(bySession.get(sessionId || '_global'));
    if (own) return { ...own, scope: sessionId ? 'session' : 'global' };
    // 退回全局最近一次：面板可能还没拿到 sessionId（用户还没在对话里发过消息）。
    const global = fresh(bySession.get('_global'));
    if (global) return { ...global, scope: 'global' };
    let newest = null;
    for (const record of bySession.values()) {
      const ok = fresh(record);
      if (ok && (!newest || ok.at > newest.at)) newest = ok;
    }
    return newest ? { ...newest, scope: 'other-session' } : null;
  }

  return {
    put,
    get,
    clear: (sessionId) => bySession.delete(sessionId || '_global'),
    size: () => bySession.size,
    _internals: { bySession },
  };
}