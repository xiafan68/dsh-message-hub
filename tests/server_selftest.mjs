/**
 * server_selftest.mjs —— BFF 路由契约自检。
 *
 * 用假的 service / selection 起真实的 http 服务：路由匹配、写入的同源校验、
 * 请求体上限、上游错误的 HTTP 映射，这些只有走真 socket 才验证得准。
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApi, ROUTE_PREFIX, normaliseSelection } from '../src/server.mjs';
import { openSelectionStore } from '../src/service.mjs';

let checks = 0;
const calls = [];

const monitors = [
  { id: 'anthropic-news', name: 'Newsroom', type: 'web_page', enabled: true, status: 'active', item_count: 12, tags: ['ai-hot'], url: 'https://www.anthropic.com/news' },
  { id: 'github-blog', name: 'GitHub Blog', type: 'rss', enabled: true, status: 'degraded', item_count: 3, tags: ['blog'], url: 'https://github.blog/feed/' },
];

const service = {
  base: 'http://127.0.0.1:4001',
  async probe() { return { ok: true, health: { configured_sources: 2, write_protection: true } }; },
  async overview() { return { total_monitors: 2, active_monitors: 1, attention_monitors: 1, total_items: 2559 }; },
  async runs(limit) { calls.push(['runs', limit]); return { items: [{ source_id: 'github-blog', status: 'ok', new_count: 1, started_at: '2026-11-13T21:00:00+08:00' }] }; },
  async monitors() { return { items: monitors, total: monitors.length }; },
  async createMonitor(payload) { calls.push(['createMonitor', payload]); return { id: payload.id, name: payload.name, type: payload.type, enabled: true, status: 'active', item_count: 0 }; },
  async setMonitorEnabled(id, enabled) { calls.push(['setMonitorEnabled', id, enabled]); return { id, enabled, status: enabled ? 'active' : 'paused' }; },
  async deleteMonitor(id) { calls.push(['deleteMonitor', id]); },
  async runMonitor(id) { calls.push(['runMonitor', id]); return { status: 'ok', new_count: 2 }; },
    async runAll(options = {}) { calls.push(['runAll', options.concurrency]); return { total: 2, succeeded: 2, failed: 0, results: [] }; },
  async feed(params) { calls.push(['feed', params]); return { items: [{ id: 7, title: 'Hello', summary: 'world', liked: false, source_id: 'github-blog' }], total: 1, limit: 50, offset: 0 }; },
  async like(id) { calls.push(['like', id]); return { id: Number(id), liked: true }; },
  async unlike(id) { calls.push(['unlike', id]); return { id: Number(id), liked: false }; },
  async deleteItem(id) { calls.push(['deleteItem', id]); return { deleted: 1 }; },
  async deleteItems(ids) { calls.push(['deleteItems', ids]); return { deleted: ids.length }; },
  async preferences() { return { directions: ['AI 基础设施'] }; },
  async setPreferences(directions) { calls.push(['setPreferences', directions]); return { directions: directions.map((d) => d.trim()).filter(Boolean) }; },
  async curations(params) { calls.push(['curations', params]); return { items: [{ id: 'c-daily', kind: 'daily', period_start: '2026-11-12', period_end: '2026-11-13', title: '2026-11-12 每日精选', summary: 'AI 基础设施两条' }] }; },
  async curation(id) {
    calls.push(['curation', id]);
    if (id !== 'c-daily') return null;
    return {
      id: 'c-daily', kind: 'daily', period_start: '2026-11-12', period_end: '2026-11-13',
      title: '2026-11-12 每日精选', summary: 'AI 基础设施两条',
      items: [{ id: 1, title: 'X 发布新模型', source_name: 'Anthropic', url: 'https://x/1', rationale: '与关注方向吻合' }],
    };
  },
};

const selection = openSelectionStore({ ttlMs: 60_000 });
let started = 0;
const api = createApi({
  service,
  selection,
  ensureStarted: async () => { started += 1; return { ok: true, message: 'ok' }; },
  log: () => {},
});

const server = http.createServer((req, res) => api.handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`;

async function json(path, options = {}) {
  const response = await fetch(base + path, options);
  const textBody = await response.text();
  return { status: response.status, body: textBody ? JSON.parse(textBody) : null };
}

// ---- 读 -------------------------------------------------------------------
let r = await json('/status');
assert.equal(r.status, 200);
assert.equal(r.body.service.ok, true);
assert.equal(r.body.apiBase, 'http://127.0.0.1:4001');
checks += 3;

r = await json('/overview');
assert.equal(r.body.total_items, 2559);
assert.equal(r.body.recent_runs.length, 1);
checks += 2;

r = await json('/feeds');
assert.equal(r.body.items.length, 2);
assert.equal(r.body.items[0].id, 'anthropic-news');
checks += 2;

r = await json('/items?q=hello&liked=true&limit=10&offset=20');
assert.equal(r.status, 200);
assert.deepEqual(calls.at(-1)[1], { source_id: undefined, q: 'hello', liked: true, from_date: undefined, to_date: undefined, limit: '10', offset: '20' });
checks += 1;

// ---- 写 -------------------------------------------------------------------
r = await json('/feeds', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'new-feed', name: 'New', type: 'rss', url: 'https://x/feed' }),
});
assert.equal(r.status, 201);
assert.equal(r.body.monitor.id, 'new-feed');
checks += 2;

r = await json('/feeds/github-blog/disable', { method: 'POST' });
assert.equal(r.status, 200);
assert.equal(calls.at(-1)[1], 'github-blog');
assert.equal(calls.at(-1)[2], false);
checks += 2;

r = await json('/feeds/github-blog/run', { method: 'POST' });
assert.equal(r.body.result.new_count, 2);
checks += 1;

r = await json('/feeds/run-all', { method: 'POST' });
assert.equal(r.status, 200);
assert.equal(r.body.summary.total, 2);
assert.equal(calls.at(-1)[0], 'runAll');
checks += 3;

r = await json('/feeds/github-blog', { method: 'DELETE' });
assert.equal(r.status, 200);
checks += 1;

r = await json('/items/7/like', { method: 'POST' });
assert.equal(r.body.item.liked, true);
checks += 1;

r = await json('/items/7/unlike', { method: 'POST' });
assert.equal(r.body.item.liked, false);
checks += 1;

// ---- 条目删除：单条 + 批量 -------------------------------------------------
r = await json('/items/7', { method: 'DELETE' });
assert.equal(r.status, 200);
assert.equal(r.body.deleted, 1);
checks += 2;

r = await json('/items/delete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids: [7, 8] }),
});
assert.equal(r.status, 200);
assert.equal(r.body.deleted, 2);
assert.deepEqual(calls.at(-1), ['deleteItems', [7, 8]]);
checks += 3;

r = await json('/items/delete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids: [] }),
});
assert.equal(r.status, 400);
assert.equal(r.body.code, 'bad-ids');
checks += 2;

r = await json('/service/start', { method: 'POST' });
assert.equal(r.body.ok, true);
assert.equal(started, 1);
checks += 2;

// ---- 每日精选 / 关注偏好 ---------------------------------------------------
r = await json('/digest?limit=5');
assert.equal(r.status, 200);
assert.equal(r.body.items[0].id, 'c-daily');
assert.deepEqual(calls.at(-1)[1], { kind: undefined, limit: '5' });
checks += 2;

r = await json('/digest/c-daily');
assert.equal(r.body.collection.items[0].rationale, '与关注方向吻合');
checks += 1;

r = await json('/digest/nope');
assert.equal(r.status, 404);
assert.equal(r.body.code, 'not-found');
checks += 2;

// 兼容 /curations 别名（与 Python 原接口同名，便于对照）
r = await json('/curations');
assert.equal(r.status, 200);
assert.equal(r.body.items.length, 1);
checks += 1;

r = await json('/preferences');
assert.deepEqual(r.body.directions, ['AI 基础设施']);
checks += 1;

r = await json('/preferences', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ directions: ['  AI 基础设施  ', '', ' AI 编程实践'] }),
});
assert.equal(r.status, 200);
assert.deepEqual(calls.at(-1)[1], ['  AI 基础设施  ', '', ' AI 编程实践']);
assert.deepEqual(r.body.directions, ['AI 基础设施', 'AI 编程实践'], '归一化交给服务端，BFF 只转发');
checks += 3;

r = await json('/preferences', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ directions: 'not-an-array' }),
});
assert.equal(r.status, 400);
assert.equal(r.body.code, 'bad-directions');
checks += 2;

// PUT 也要过同源校验
r = await json('/preferences', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
  body: JSON.stringify({ directions: ['x'] }),
});
assert.equal(r.status, 403);
checks += 1;

// ---- 选中态 ---------------------------------------------------------------
r = await json('/selection', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sessionId: 'sess-1',
    selection: {
      kind: 'item', id: 7, title: 'Hello', source_id: 'github-blog', source_name: 'GitHub Blog',
      url: 'https://x/y', created_at: '2026-11-13T21:00:00+08:00', summary: 'world', liked: true,
      // 下面两个字段不在白名单里，必须被丢掉
      injected: 'nope', nested: { deep: true },
    },
  }),
});
assert.equal(r.status, 200);
assert.equal(r.body.selection.selection.title, 'Hello');
assert.equal(r.body.selection.selection.injected, undefined, '白名单外的字段必须丢弃');
assert.equal(r.body.selection.selection.id, '7', 'id 统一转成字符串');
checks += 3;

r = await json('/selection?session=sess-1');
assert.equal(r.body.selection.selection.source_name, 'GitHub Blog');
checks += 1;

r = await json('/selection?session=other');
assert.equal(r.body.selection.selection.id, '7', '别的会话应退回全局最近一次');
checks += 1;

r = await json('/selection?session=sess-1', { method: 'DELETE' });
assert.equal(r.status, 200);
checks += 1;

// ---- 防御面 ---------------------------------------------------------------
r = await json('/feeds', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
  body: JSON.stringify({ id: 'x', type: 'rss', url: 'https://x/feed' }),
});
assert.equal(r.status, 403, '跨源写必须拒绝');
assert.equal(r.body.code, 'cross-origin');
checks += 2;

r = await json('/feeds', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'x', type: 'rss', url: 'https://x/' + 'a'.repeat(20_000) }),
});
assert.equal(r.status, 413, '超过 16KB 必须拒绝');
checks += 1;

r = await json('/feeds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
assert.equal(r.status, 400, '坏 JSON 必须拒绝');
checks += 1;

r = await json('/nope');
assert.equal(r.status, 404);
checks += 1;

// ---- 上游错误 → 503 + 可执行 hint ----------------------------------------
const failing = createApi({
  service: { ...service, async monitors() { const e = new Error('连不上'); e.code = 'service-down'; throw e; } },
  selection,
  log: () => {},
});
const failServer = http.createServer((req, res) => failing.handler(req, res));
await new Promise((resolve) => failServer.listen(0, '127.0.0.1', resolve));
const failBase = `http://127.0.0.1:${failServer.address().port}${ROUTE_PREFIX}`;
const failResponse = await fetch(`${failBase}/feeds`);
const failBody = await failResponse.json();
assert.equal(failResponse.status, 503);
assert.equal(failBody.code, 'service-down');
assert.ok(String(failBody.hint).includes('service/start'), 'hint 要给出自愈路径');
checks += 3;
failServer.close();

// ---- normaliseSelection ---------------------------------------------------
assert.equal(normaliseSelection(null), null);
assert.equal(normaliseSelection({}), null);
assert.equal(normaliseSelection({ id: 'x', title: 'y' }).kind, 'item');
assert.equal(normaliseSelection({ kind: 'source', id: 'x' }).kind, 'source');
assert.equal(normaliseSelection({ kind: 'weird', id: 'x' }).kind, 'item');
assert.equal(normaliseSelection({ id: 'x', summary: 'a'.repeat(5000) }).summary.length, 1200);
checks += 6;

server.close();
console.log(`server_selftest: ${checks} 项断言全部通过`);