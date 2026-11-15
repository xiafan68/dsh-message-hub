/**
 * tools.mjs —— 让模型直接操作消息订阅的 10 个可选工具。
 *
 * 只在宿主提供 `ctx.tools` 时注册；缺服务时整个文件不会被加载。
 *
 * 设计取舍：
 *   - 每个工具返回**可读摘要文本**，不返回原始 JSON（条目列表动辄几千行，会挤爆上下文）；
 *   - 读操作 isConcurrencySafe=true；写操作（增源、启停、删除、采集、收藏）各自独立，
 *     描述里写清副作用，避免模型顺手机合；
 *   - 服务没起时不抛异常打断对话，而是返回"怎么起"的可执行提示；
 *   - `hub_selection` 是"对话感知当前面板选中"的入口：面板选中什么，模型就问得到什么。
 */

const TIMEOUT_MS = 30_000;

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function splitList(value) {
  if (!value) return undefined;
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function shortTime(value) {
  if (!value) return '—';
  const raw = String(value);
  // Python 侧是 ISO8601（带时区）：截到分钟就够对话里看
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` : raw.slice(0, 19);
}

function statusBadge(item) {
  if (item.enabled === false) return '⏸ 暂停';
  const map = { active: '✅ 正常', degraded: '⚠️ 降级', error: '❌ 失败', paused: '⏸ 暂停' };
  return map[item.status] || String(item.status || '—');
}

function serviceDownText(err) {
  return [
    '本机订阅引擎没在跑，这条操作没法完成。',
    `原因：${err && err.message ? err.message : err}`,
    '修法（任选其一）：',
    '  1. 让面板帮你拉起：POST /message-hub/api/service/start，或调 hub_service_start；',
    '  2. 首次启动会自动建 venv、装依赖（可能需要几十秒到几分钟），失败时看 runtimeDir 下的 install.log / service.log；',
    '  3. 若端口不是 4001，用 config.apiBase 指到正确的地址。',
  ].join('\n');
}

/** 把服务异常折成模型能读的一句话，而不是让对话中断。 */
function describeError(err) {
  const code = err && err.code;
  if (code === 'service-down' || code === 'service-timeout') return serviceDownText(err);
  if (code === 'unauthorized') return `服务要求鉴权（401）：配置里补 token，或把 ~/.config/message-subscriptions/api-token 建好。${err.message}`;
  if (code === 'forbidden') return `token 不对（403）：检查配置里的 token 与服务端是否一致。${err.message}`;
  return `操作失败：${err && err.message ? err.message : err}`;
}

function feedRow(item) {
  return [
    item.id,
    item.name || '',
    item.type || '',
    statusBadge(item),
    `${item.item_count ?? 0} 条`,
    item.last_run_at ? shortTime(item.last_run_at) : '未跑过',
  ].join(' | ');
}

/**
 * 解析宿主的 defineTool。
 * 与 strategy-workbench 同一套兜底：解析不到就按裸声明注册，绝不因此让 fiber 失败。
 */
function resolveDefineTool(ctx, log) {
  const candidates = ['@deepseek-ai/dsh-tools', 'dsh-tools'];
  for (const candidate of candidates) {
    try {
      const mod = ctx && typeof ctx.require === 'function' ? ctx.require(candidate) : null;
      if (mod && typeof mod.defineTool === 'function') return mod.defineTool;
    } catch {
      // 继续下一个候选
    }
  }
  log('未解析到 defineTool，改用本地编译的 parameters schema');
  return compileDeclaration;
}

/**
 * 把作者侧的属性表编译成标准 JSON Schema 对象。
 *
 * 宿主的 defineTool 会做同一件事，但它在某些安装方式下解析不到（插件不在宿主
 * 的解析路径里）：那条路径下若把属性表原样当 schema 发出去，顶层就会出现
 * `type: { type: 'string' }` 这种非法的 `type` 值，LiteLLM / OpenAI 一类严格
 * 网关会直接 400。这里做等价兜底，保证两条路径产出的 schema 一致。
 */
function compileValueSchema(spec) {
  if (!spec || typeof spec !== 'object') return {};
  const node = {};
  for (const key of ['description', 'title', 'default', 'examples']) {
    if (spec[key] !== undefined) node[key] = spec[key];
  }
  if (spec.oneOf) {
    node.oneOf = spec.oneOf.map(compileValueSchema);
    return node;
  }
  if (spec.type === 'json') return node;
  node.type = spec.type;
  if (spec.enum !== undefined) node.enum = spec.enum;
  if (spec.const !== undefined) node.const = spec.const;
  if (spec.type === 'array') node.items = compileValueSchema(spec.items || {});
  if (spec.type === 'object') {
    const map = spec.properties || {};
    const properties = {};
    for (const [key, child] of Object.entries(map)) properties[key] = compileValueSchema(child);
    node.properties = properties;
    node.additionalProperties = spec.additionalProperties !== false;
  }
  return node;
}

function compileParameters(parameters) {
  const source = parameters && typeof parameters === 'object' ? parameters : {};
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(source)) {
    properties[key] = compileValueSchema(spec);
    if (spec && spec.required === true) required.push(key);
  }
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** defineTool 不可用时的替身：只做 schema 编译，其余字段原样保留。 */
function compileDeclaration(decl) {
  if (!decl || decl.parameters === undefined) return decl;
  return { ...decl, parameters: compileParameters(decl.parameters) };
}

export function registerTools({ ctx, tools, service, selection, ensureStarted, dataDir = '', defaultLimit = 50, log = (m) => void m }) {
  const disposers = [];
  const defineTool = resolveDefineTool(ctx, log);
  // 工具服务有两种拿法：宿主显式传进来（推荐，测试也好写），或挂在 ctx.tools 上
  // （Cordis 会把服务代理到 ctx 属性）。两者都没有就该早失败，而不是等到第一个工具。
  const registry = tools || (ctx && ctx.tools);
  if (!registry || typeof registry.register !== 'function') {
    log('没有可用的 tools 服务：hub_* 工具不会注册');
    return disposers;
  }
  const register = (decl, label) => disposers.push(registry.register(defineTool(decl), `@dsh-external/dsh-message-hub: ${label}`));

  // ---- 1. 状态 ---------------------------------------------------------
  register({
    name: 'hub_status',
    description: '查看消息订阅的整体状态：本地服务是否在线、订阅源数量、条目总数、最近一次采集结果。'
      + '用户问「订阅在跑吗」「有多少条了」时先调这个；服务不通时它会给出启动方法。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    isConcurrencySafe: () => true,
    timeoutMs: TIMEOUT_MS,
    async execute() {
      const probe = await service.probe();
      if (!probe.ok) {
        const lines = [serviceDownText(probe)];
        if (typeof ensureStarted === 'function') lines.push('（也可以调 hub_service_start 让我替你拉起。）');
        return lines.join('\n');
      }
      let overview = null;
      let runs = [];
      try {
        overview = await service.overview();
        const recent = await service.runs(3);
        runs = (recent && recent.items) || [];
      } catch (err) {
        return describeError(err);
      }
      const lines = [
        `服务：在线（${service.base}）`,
        `订阅源：${overview.total_monitors ?? '—'} 个（正常 ${overview.active_monitors ?? 0} / 需处理 ${overview.attention_monitors ?? 0}）`,
        `条目：${overview.total_items ?? overview.items ?? '—'}`,
      ];
      if (dataDir) lines.push(`数据目录：${dataDir}`);
      if (runs.length > 0) {
        lines.push('最近采集：');
        for (const run of runs) {
          lines.push(`  · ${shortTime(run.started_at || run.created_at)} ${run.source_id || ''} → ${run.status || ''}${run.new_count !== undefined ? `（新增 ${run.new_count}）` : ''}`);
        }
      }
      return lines.join('\n');
    },
  }, 'hub_status');

  // ---- 2. 服务自愈 -----------------------------------------------------
  register({
    name: 'hub_service_start',
    description: '启动本机的内置订阅引擎（Python，默认 127.0.0.1:4001）。'
      + '仅当 hub_status 报引擎不可达时使用；首次启动会先建 venv 并安装依赖，可能要几十秒到几分钟，'
      + '它会等健康检查通过再返回。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    // 首次要装依赖：给足时间，否则工具会在 pip 还没跑完时被掐断
    timeoutMs: 300_000,
    async execute() {
      if (typeof ensureStarted !== 'function') return '宿主未提供自动启动（config.autoStart 为 false）：请在配置里打开 autoStart，或手动启动内置引擎（见 service/README.md）。';
      const result = await ensureStarted();
      return result.ok ? '服务已启动并通过健康检查。' : `启动未成功：${result.message}`;
    },
  }, 'hub_service_start');

  // ---- 3. 源列表 -------------------------------------------------------
  register({
    name: 'hub_feeds',
    description: '列出订阅源（RSS / 网页 / GitHub Releases），带状态、条目数与最近采集时间。'
      + '回答「我订了哪些」「哪个源坏了」用这个。',
    parameters: {
      q: { type: 'string', description: '按 id / 名称 / 标签过滤（不区分大小写）' },
      status: { type: 'string', description: '只看某种状态：active / degraded / error / paused' },
      limit: { type: 'integer', description: `返回条数，默认 30，上限 100` },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    isConcurrencySafe: () => true,
    timeoutMs: TIMEOUT_MS,
    async execute(args = {}) {
      try {
        const data = await service.monitors();
        let items = (data && data.items) || [];
        const q = String(args.q || '').trim().toLowerCase();
        const status = String(args.status || '').trim();
        if (q) {
          items = items.filter((item) => [item.id, item.name, ...(item.tags || [])]
            .filter(Boolean).some((field) => String(field).toLowerCase().includes(q)));
        }
        if (status) items = items.filter((item) => item.status === status);
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
        const shown = items.slice(0, limit);
        if (shown.length === 0) return '没有匹配的订阅源。';
        return [
          `共 ${items.length} 个源，返回 ${shown.length} 个：`,
          'id | 名称 | 类型 | 状态 | 条目 | 最近采集',
          ...shown.map(feedRow),
        ].join('\n');
      } catch (err) {
        return describeError(err);
      }
    },
  }, 'hub_feeds');

  // ---- 4. 新增源（对话里加订阅） ---------------------------------------
  register({
    name: 'hub_feed_add',
    description: '新增一个订阅源。支持三种 type：'
      + 'rss（传 url）、github_releases（传 repository=owner/name）、web_page（传 config 完整对象）。'
      + '用户说「帮我订 XX 的博客/RSS」「盯着某个仓库的 release」时用它。'
      + '新增后不会立刻抓取：要马上抓一次再调 hub_feed_control(action="run")。',
    parameters: {
      id: { type: 'string', description: '源标识（英文/数字/连字符），不传则按名称生成' },
      name: { type: 'string', description: '显示名称' },
      type: { type: 'string', description: 'rss | github_releases | web_page' },
      url: { type: 'string', description: 'rss 的 feed 地址，或 web_page 的页面地址' },
      repository: { type: 'string', description: 'github_releases 的仓库，形如 owner/name' },
      tags: { type: 'string', description: '标签，逗号分隔（例如 ai-hot,blog）' },
      interval_minutes: { type: 'integer', description: '采集间隔分钟数，默认 360' },
      config: { type: 'object', description: 'web_page 的完整配置对象（含 request/extract/detect），其它类型不用传' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    timeoutMs: TIMEOUT_MS,
    async execute(args = {}) {
      const type = String(args.type || 'rss').trim();
      const name = String(args.name || '').trim();
      const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const id = String(args.id || '').trim() || slugify(name || args.repository || args.url || '') || `feed-${Date.now()}`;
      const payload = { id, type };
      if (name) payload.name = name;
      const tags = splitList(args.tags);
      if (tags) payload.tags = tags;
      if (args.interval_minutes !== undefined) {
        const minutes = Number(args.interval_minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) return 'interval_minutes 必须是正整数（分钟）。';
        payload.poll_interval_minutes = minutes;
      }

      if (type === 'rss') {
        const url = String(args.url || '').trim();
        if (!url) return 'rss 类型需要 url（feed 地址）。';
        payload.url = url;
      } else if (type === 'github_releases') {
        const repository = String(args.repository || '').trim();
        if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) return 'github_releases 需要 repository，形如 owner/name。';
        payload.repository = repository;
      } else if (type === 'web_page') {
        if (!args.config || typeof args.config !== 'object') {
          return 'web_page 需要 config 完整对象（request.url + extract.fields + detect）。'
            + '建议先让用户在面板里配，或参考项目的 config/subscriptions.example.yaml。';
        }
        Object.assign(payload, args.config, { id, type: 'web_page' });
        if (args.url && payload.request && !payload.request.url) payload.request.url = String(args.url);
      } else {
        return `不支持的 type：${type}（只支持 rss / github_releases / web_page）`;
      }

      try {
        const created = await service.createMonitor(payload);
        const monitor = (created && created.monitor) || created || {};
        return [
          `已添加订阅源：${monitor.id || id}（${monitor.type || type}）`,
          monitor.name ? `名称：${monitor.name}` : '',
          monitor.url ? `地址：${monitor.url}` : '',
          '下一步：要立刻抓一次就说一声，我调 hub_feed_control(action="run")。',
        ].filter(Boolean).join('\n');
      } catch (err) {
        return describeError(err);
      }
    },
  }, 'hub_feed_add');

  // ---- 5. 源控制 -------------------------------------------------------
  register({
    name: 'hub_feed_control',
    description: '对一个订阅源执行动作：enable（恢复）/ disable（暂停）/ delete（删除）/ run（立刻采集一次）。'
      + 'run 会真的发网络请求，可能耗时十几秒。',
    parameters: {
      id: { type: 'string', description: '订阅源 id' },
      action: { type: 'string', description: 'enable | disable | delete | run' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    timeoutMs: 70_000,
    async execute(args = {}) {
      const id = String(args.id || '').trim();
      const action = String(args.action || '').trim();
      if (!id) return '缺少 id。';
      if (!['enable', 'disable', 'delete', 'run'].includes(action)) return 'action 只能是 enable / disable / delete / run。';
      try {
        if (action === 'run') {
          const data = await service.runMonitor(id);
          const result = (data && data.result) || data || {};
          const bits = [
            `已触发采集：${id}`,
            `状态：${result.status || '—'}`,
            result.new_count !== undefined ? `新增：${result.new_count} 条` : '',
            result.error ? `错误：${result.error}` : '',
          ].filter(Boolean);
          return bits.join('\n');
        }
        if (action === 'delete') {
          await service.deleteMonitor(id);
          return `已删除（软删）：${id}`;
        }
        const monitor = await service.setMonitorEnabled(id, action === 'enable');
        const view = (monitor && monitor.monitor) || monitor || {};
        return `${action === 'enable' ? '已恢复' : '已暂停'}：${id}（当前 ${statusBadge(view)}）`;
      } catch (err) {
        return describeError(err);
      }
    },
  }, 'hub_feed_control');

  // ---- 6. 条目流 -------------------------------------------------------
  register({
    name: 'hub_items',
    description: '查订阅条目（按来源/关键词/日期/是否收藏过滤，分页）。'
      + '回答「最近有什么新消息」「XX 源最近推了什么」用它；需要正文再对单条调 hub_item。',
    parameters: {
      q: { type: 'string', description: '关键词，命中标题/摘要' },
      source_id: { type: 'string', description: '只看某个源' },
      liked: { type: 'boolean', description: 'true 只看收藏' },
      from_date: { type: 'string', description: '起始日期 YYYY-MM-DD' },
      to_date: { type: 'string', description: '截止日期 YYYY-MM-DD' },
      limit: { type: 'integer', description: '返回条数，默认 15，上限 100' },
      offset: { type: 'integer', description: '分页偏移，默认 0' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    isConcurrencySafe: () => true,
    timeoutMs: TIMEOUT_MS,
    async execute(args = {}) {
      const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);
      try {
        const data = await service.feed({
          q: args.q || undefined,
          source_id: args.source_id || undefined,
          liked: args.liked === true ? true : undefined,
          from_date: args.from_date || undefined,
          to_date: args.to_date || undefined,
          limit,
          offset,
        });
        const items = (data && data.items) || [];
        const total = (data && data.total) || 0;
        if (items.length === 0) return '没有匹配的条目。';
        const lines = [`共 ${total} 条，返回第 ${offset + 1}–${offset + items.length} 条：`];
        for (const item of items) {
          const flag = item.liked ? '★' : '·';
          lines.push(`${flag} #${item.id} [${item.source_name || item.source_id}] ${item.title || '(无标题)'} — ${shortTime(item.created_at || item.published_at || item.first_seen_at)}`);
          if (item.summary) lines.push(`    ${String(item.summary).replace(/\s+/g, ' ').slice(0, 160)}`);
        }
        return lines.join('\n');
      } catch (err) {
        return describeError(err);
      }
    },
  }, 'hub_items');

  // ---- 7. 单条 + 收藏 ---------------------------------------------------
  register({
    name: 'hub_item',
    description: '查看单条订阅条目的正文摘要与链接；action=like/unlike 可收藏或取消收藏（收藏的条目不会被两周清理）。',
    parameters: {
      id: { type: 'integer', description: '条目 id（hub_items 返回里的 #N）' },
      action: { type: 'string', description: 'show（默认）| like | unlike' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    isConcurrencySafe: (args) => !args || !args.action || args.action === 'show',
    timeoutMs: TIMEOUT_MS,
    async execute(args = {}) {
      const id = Number(args.id);
      if (!Number.isInteger(id) || id <= 0) return '缺少有效的条目 id（整数）。';
      const action = String(args.action || 'show').trim();
      try {
        if (action === 'like' || action === 'unlike') {
          const data = action === 'like' ? await service.like(id) : await service.unlike(id);
          const item = (data && data.item) || data || {};
          return `${action === 'like' ? '已收藏' : '已取消收藏'} #${id}${item.title ? `：${item.title}` : ''}`;
        }
        // 服务端没有单条 GET：用 source_id 无法精确定位，所以按 id 在最近条目里找。
        const data = await service.feed({ limit: 100, offset: 0 });
        const found = ((data && data.items) || []).find((item) => Number(item.id) === id);
        if (!found) {
          return `在最近 100 条里没找到 #${id}。可以用 hub_items 带关键词先定位；或改用日期区间。`;
        }
        const lines = [
          `#${found.id} ${found.title || '(无标题)'}`,
          `来源：${found.source_name || found.source_id} · ${shortTime(found.created_at || found.published_at || found.first_seen_at)}`,
          found.url ? `链接：${found.url}` : '',
          found.liked ? '收藏：是' : '',
          '',
          String(found.summary || found.body || '(无摘要)').replace(/\s+/g, ' ').slice(0, 1200),
        ].filter(Boolean);
        return lines.join('\n');
      } catch (err) {
        return describeError(err);
      }
    },
  }, 'hub_item');

  // ---- 8. 当前选中（对话感知面板） --------------------------------------
  register({
    name: 'hub_selection',
    description: '读取用户此刻在「消息订阅」面板里选中的条目或订阅源（标题、来源、链接、摘要）。'
      + '当用户说「这条」「这个 feed」「刚才我看的那个」却没说清是什么时，先调这个再回答。',
    parameters: {
      session_id: { type: 'string', description: '可选：指定会话 id；不传则按当前/最近的选中' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    isConcurrencySafe: () => true,
    timeoutMs: TIMEOUT_MS,
    async execute(args = {}) {
      const record = selection.get(String(args.session_id || ''));
      if (!record || !record.selection) {
        return '用户当前没有在面板里选中任何条目（或选中已过期）。可以直接问他要看哪条，或用 hub_items 先列出来。';
      }
      const sel = record.selection;
      const lines = [
        `当前选中：${sel.kind === 'source' ? '订阅源' : '条目'}`,
        sel.title ? `标题：${sel.title}` : '',
        sel.id ? `id：${sel.id}` : '',
        sel.source_name || sel.source_id ? `来源：${sel.source_name || sel.source_id}` : '',
        sel.created_at ? `时间：${shortTime(sel.created_at)}` : '',
        sel.url ? `链接：${sel.url}` : '',
        sel.liked ? '收藏：是' : '',
        sel.summary ? `摘要：${String(sel.summary).replace(/\s+/g, ' ').slice(0, 600)}` : '',
        `（选中作用域：${record.scope}，${Math.round((Date.now() - record.at) / 1000)} 秒前）`,
      ].filter(Boolean);
      return lines.join('\n');
    },
  }, 'hub_selection');

  // ---- 9. 每日精选 ------------------------------------------------------
  register({
    name: 'hub_digest',
    description: '查看「每日精选 / 每周精选」（服务端已经生成好的 curation 合集）。'
      + '不传 collection_id 时列出各期（时间、标题、摘要）；传了则展开那一期的入选条目与入选理由。'
      + '用户问「今天的精选」「最近一期日报讲了什么」时用它。',
    parameters: {
      kind: { type: 'string', description: '可选：daily | weekly；不传则两种都要' },
      limit: { type: 'number', description: '列表条数，默认 10，上限 50' },
      collection_id: { type: 'string', description: '可选：展开某一期（从列表里拿到的 id）' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    isConcurrencySafe: () => true,
    timeoutMs: TIMEOUT_MS,
    async execute(args = {}) {
      try {
        if (args.collection_id) {
          const collection = await service.curation(String(args.collection_id));
          if (!collection) return `没有找到这一期精选：${args.collection_id}`;
          const lines = [
            `${collection.title || '(无标题)'}（${kindText(collection.kind)}）`,
            `区间：${collection.period_start || '—'} → ${collection.period_end || '—'}`,
          ];
          if (collection.summary) lines.push('', String(collection.summary).replace(/\s+/g, ' '));
          const items = collection.items || [];
          lines.push('', `共 ${items.length} 条：`);
          items.forEach((item, index) => {
            lines.push(`${index + 1}. ${item.title || '(无标题)'}`);
            if (item.source_name) lines.push(`   来源：${item.source_name}`);
            if (item.rationale) lines.push(`   入选理由：${String(item.rationale).replace(/\s+/g, ' ').slice(0, 300)}`);
            if (item.url) lines.push(`   链接：${item.url}`);
          });
          return lines.join('\n');
        }
        const data = await service.curations({
          kind: args.kind ? String(args.kind) : undefined,
          limit: Math.min(Math.max(Number(args.limit) || 10, 1), 50),
        });
        const items = (data && data.items) || [];
        if (items.length === 0) {
          return '还没有精选取集。精选由服务端脚本（scripts/curation_*.py）生成后写入 curation_collections；'
            + '本地可以用 curation_fetch.py / curation_post.py 触发。';
        }
        const lines = [`共 ${items.length} 期：`];
        for (const row of items) {
          lines.push(`· [${kindText(row.kind)}] ${row.period_start || row.created_at?.slice(0, 10) || '—'} ${row.title || ''}`.trim());
          if (row.summary) lines.push(`  ${String(row.summary).replace(/\s+/g, ' ').slice(0, 120)}`);
          lines.push(`  id：${row.id}`);
        }
        lines.push('', '要展开某一期，带上 collection_id 再调一次。');
        return lines.join('\n');
      } catch (err) {
        return describeError(err);
      }
    },
  }, 'hub_digest');

  // ---- 10. 关注偏好（决定精选取舍口径） ---------------------------------
  register({
    name: 'hub_preferences',
    description: '读取或修改「个人关注方向」（关注偏好）。这些方向是每日精选的取舍口径。'
      + 'action=list 查看；action=add/remove 增量改；action=set 整份覆盖。'
      + '用户说「我最近更关注 X」「把 Y 从关注里去掉」时用它。',
    parameters: {
      action: { type: 'string', description: 'list（默认）| add | remove | set', enum: ['list', 'add', 'remove', 'set'] },
      direction: { type: 'string', description: 'add/remove 时的单个方向文本' },
      directions: { type: 'array', items: { type: 'string' }, description: 'set 时的完整列表' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    isConcurrencySafe: () => false,
    timeoutMs: TIMEOUT_MS,
    async execute(args = {}) {
      const action = String(args.action || 'list').trim();
      try {
        const current = ((await service.preferences()) || {}).directions || [];
        if (action === 'list') {
          if (current.length === 0) return '还没有设置关注方向（每日精选会按默认口径挑选）。';
          return ['当前关注方向：', ...current.map((item, index) => `${index + 1}. ${item}`)].join('\n');
        }

        let next = current;
        if (action === 'add' || action === 'remove') {
          const value = String(args.direction || '').trim();
          if (!value) return 'add/remove 需要提供 direction。';
          // 用精确文本匹配而不是模糊匹配：方向是用户自己的措辞，猜错比报错更烦人
          const exists = current.includes(value);
          if (action === 'add') {
            if (exists) return `「${value}」已经在关注方向里了。`;
            next = current.concat([value]);
          } else {
            if (!exists) {
              return `关注方向里没有「${value}」。\n现有：\n${current.map((item) => `· ${item}`).join('\n') || '（空）'}`;
            }
            next = current.filter((item) => item !== value);
          }
        } else if (action === 'set') {
          if (!Array.isArray(args.directions)) return 'set 需要 directions 字符串数组。';
          next = args.directions.map((item) => String(item));
        } else {
          return `不认识的 action：${action}（可用 list / add / remove / set）`;
        }

        const saved = ((await service.setPreferences(next)) || {}).directions || next;
        const verb = action === 'add' ? '已添加' : action === 'remove' ? '已移除' : '已更新';
        return [
          `${verb}。当前关注方向（${saved.length}）：`,
          ...saved.map((item, index) => `${index + 1}. ${item}`),
        ].join('\n');
      } catch (err) {
        return describeError(err);
      }
    },
  }, 'hub_preferences');

  return disposers;
}

/** curation kind → 中文标签（工具输出给模型看，统一口径）。 */
function kindText(kind) {
  if (kind === 'weekly') return '周报';
  if (kind === 'daily') return '日报';
  return kind || '精选';
}