/**
 * service_selftest.mjs —— 与 Python 服务边界的自检（真起一个 http mock）。
 *
 * 为什么不用 mock fetch：真实的 401/403/500/连接拒绝路径恰恰是最容易写错的，
 * 用 node:http 起一个真服务器，才能验证"状态码 → code"的映射以及请求头。
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import { createService, cleanParams, openSelectionStore, HubServiceError } from '../src/service.mjs';

let checks = 0;
const seen = [];
/** 简易路由：按 path 决定回什么，顺带把请求记下来给断言用。 */
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body });
    const send = (status, payload) => {
      const buf = Buffer.from(JSON.stringify(payload), 'utf8');
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
      res.end(buf);
    };
    const url = new URL(req.url, 'http://local');
    switch (url.pathname) {
      case '/api/v1/health':
        send(200, { status: 'ok', database: 'ok', configured_sources: 38, write_protection: true });
        break;
      case '/api/v1/monitors':
        send(200, {
          items: [
            { id: 'anthropic-news', name: 'Newsroom', type: 'web_page', enabled: true, status: 'active', item_count: 3 },
            { id: 'bad', name: 'Broken', type: 'rss', enabled: true, status: 'active', item_count: 0 },
            { id: 'paused', name: 'Paused', type: 'rss', enabled: false, status: 'paused', item_count: 0 },
          ],
          total: 3,
        });
        break;
      case '/api/v1/monitors/anthropic-news/run':
        send(200, { status: 'ok', fetched_count: 5, new_count: 2 });
        break;
      case '/api/v1/feed':
        send(200, { items: [{ id: 7, title: 'Hello', summary: 'world', liked: false }], total: 1, limit: 50, offset: 0 });
        break;
      case '/api/v1/overview':
        send(200, { total_monitors: 1, active_monitors: 1, attention_monitors: 0, total_items: 2559 });
        break;
      case '/api/v1/monitors/bad/run':
        send(500, { detail: '采集炸了' });
        break;
      case '/api/v1/monitors/secret':
        send(403, { detail: 'Invalid bearer token' });
        break;
      case '/api/v1/monitors/needauth':
        send(401, { detail: 'Bearer token required' });
        break;
      default:
        send(404, { detail: 'nope' });
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const service = createService({ apiBase: base, token: 'tok-123', timeoutMs: 3000 });

// ---- 正常读 ---------------------------------------------------------------
const health = await service.health();
assert.equal(health.configured_sources, 38);
checks += 1;
assert.equal(seen.at(-1).auth, 'Bearer tok-123', '应带 Bearer token');
checks += 1;

const monitors = await service.monitors();
assert.equal(monitors.items[0].id, 'anthropic-news');
checks += 1;

const feed = await service.feed({ q: '', source_id: 'anthropic-news', liked: true, limit: 50, offset: 0 });
assert.equal(feed.items[0].id, 7);
assert.equal(seen.at(-1).url, '/api/v1/feed?source_id=anthropic-news&liked=true&limit=50&offset=0');
checks += 2;

const overview = await service.overview();
assert.equal(overview.total_items, 2559);
checks += 1;

// ---- 错误映射 -------------------------------------------------------------
await assert.rejects(service.runMonitor('bad'), (err) => {
  assert.ok(err instanceof HubServiceError);
  assert.equal(err.code, 'http-500');
  assert.equal(err.status, 500);
  assert.ok(err.message.includes('采集炸了'), '应把服务端 detail 带出来');
  return true;
});
checks += 1;

await assert.rejects(service.deleteMonitor('secret'), (err) => err.code === 'forbidden');
await assert.rejects(service.deleteMonitor('needauth'), (err) => err.code === 'unauthorized');
checks += 2;

// ---- 批量采集：跳过暂停源、单源失败不中断 ---------------------------------
const batch = await service.runAll({ concurrency: 2 });
assert.equal(batch.total, 2, '只采集 enabled 的源');
assert.equal(batch.succeeded, 1);
assert.equal(batch.failed, 1);
assert.equal(batch.results.find((item) => item.id === 'anthropic-news').created, 2);
assert.equal(batch.results.find((item) => item.id === 'bad').ok, false);
checks += 5;

// ---- 连不上 → service-down ------------------------------------------------
const dead = createService({ apiBase: 'http://127.0.0.1:9', timeoutMs: 1200 });
const probe = await dead.probe();
assert.equal(probe.ok, false);
assert.equal(probe.code, 'service-down');
checks += 2;

// ---- cleanParams ----------------------------------------------------------
assert.deepEqual(cleanParams({ a: '', b: null, c: undefined, d: true, e: 0 }), { d: 'true', e: '0' });
checks += 1;

// ---- 选中态寄存 -----------------------------------------------------------
const store = openSelectionStore({ ttlMs: 60_000 });
store.put('sess-A', { kind: 'item', id: '7', title: 'Hello' });
assert.equal(store.get('sess-A').selection.title, 'Hello');
assert.equal(store.get('sess-A').scope, 'session');
checks += 2;

// 别的会话没有自己的选中时，退回全局最近一次（面板可能还没拿到 sessionId）
store.put('', { kind: 'source', id: 'anthropic-news', title: 'Newsroom' });
assert.equal(store.get('sess-B').selection.id, 'anthropic-news');
assert.equal(store.get('sess-B').scope, 'global');
checks += 2;

// 自己的会话优先于全局
store.put('sess-A', { kind: 'item', id: '8', title: 'Own' });
assert.equal(store.get('sess-A').selection.id, '8');
checks += 1;

// 清空
store.put('sess-A', null);
assert.equal(store.get('sess-A').selection.id, 'anthropic-news', '清空后应退回全局');
checks += 1;

// TTL 过期
let fakeNow = Date.now();
const ttlStore = openSelectionStore({ ttlMs: 1000, now: () => fakeNow });
ttlStore.put('s', { kind: 'item', id: '1' });
fakeNow += 5000;
assert.equal(ttlStore.get('s'), null);
checks += 1;

server.close();
console.log(`service_selftest: ${checks} 项断言全部通过`);