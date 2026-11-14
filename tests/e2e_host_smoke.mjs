/**
 * e2e_host_smoke.mjs —— 端到端冒烟：真插件 + 真 BFF + **真 Python 服务**。
 *
 * 这是重启 DSH 之前能拿到的最强证据：用与宿主同形的 ctx 把 apply() 跑起来，
 * 抓它注册的路由与工具，再通过真 socket 打一遍。若 Python 服务没起，
 * 本测试只验证"降级路径"（/status 报 service.ok=false 且 hint 可执行），
 * 并明确打印 SKIP，不假装通过。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { apply, name } from '../src/index.mjs';

const effects = [];
const registered = { routes: [], tools: [], provided: [], logs: [] };

const fakeCtx = {
  logger: {
    info: (m) => registered.logs.push(['info', m]),
    warn: (m) => registered.logs.push(['warn', m]),
  },
  get(service) {
    if (service === 'webServer') {
      return {
        register: (route) => {
          registered.routes.push(route);
          return () => {};
        },
      };
    }
    if (service === 'tools') {
      return {
        register: (tool, label) => {
          registered.tools.push({ tool, label });
          return () => {};
        },
      };
    }
    return false;
  },
  effect(fn) { effects.push(fn); return () => {}; },
  reflect: { provide: (key, value) => { registered.provided.push([key, value]); return () => {}; } },
  provide: () => {},
};

await apply(fakeCtx, {
  apiBase: 'http://127.0.0.1:4001',
  // 指向仓库自带的引擎；autoStart=false 保证 e2e 不会自己起进程
  serviceDir: fileURLToPath(new URL('../service', import.meta.url)),
  autoStart: false,
});

await new Promise((resolve) => setTimeout(resolve, 300));

let checks = 0;
// 最重要的一条：初始化阶段任何异常都会被 apply 吞掉（只 warn），
// 表现出来就是"插件挂上了但少一半能力"。这里直接把它钉成断言。
const initFailures = registered.logs.filter(([, line]) => String(line).includes('初始化失败'));
assert.deepEqual(initFailures, [], '初始化阶段不应有异常：' + JSON.stringify(initFailures));
checks += 1;

assert.equal(registered.routes.length, 1, '应注册且只注册一条 prefix 路由');
assert.equal(registered.routes[0].kind, 'prefix');
assert.equal(registered.routes[0].path, '/message-hub/api');
checks += 3;

const toolNames = registered.tools.map((entry) => entry.tool.name).sort();
assert.deepEqual(toolNames, [
  'hub_digest', 'hub_feed_add', 'hub_feed_control', 'hub_feeds', 'hub_item',
  'hub_items', 'hub_preferences', 'hub_selection', 'hub_service_start', 'hub_status',
].sort());
checks += 1;

assert.ok(registered.provided.some(([key]) => key === 'messageHub'), '应 provide messageHub 运行时事实');
checks += 1;

// 用真 socket 打 BFF
const server = http.createServer((req, res) => registered.routes[0].handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/message-hub/api`;

async function json(path, options) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const status = await json('/status');
assert.equal(status.status, 200);
// /status 必须回报数据目录：用户问"数据放哪了"时，面板与排障都得有唯一答案
assert.ok(typeof status.body.dataDir === 'string' && status.body.dataDir.length > 0, '应回报 dataDir');
const serviceOk = Boolean(status.body.service && status.body.service.ok);
console.log(`e2e: 服务 ${serviceOk ? '在线' : '离线（走降级断言）'}，数据目录 ${status.body.dataDir}`);
checks += 2;

if (serviceOk) {
  const feeds = await json('/feeds');
  assert.equal(feeds.status, 200);
  assert.ok(Array.isArray(feeds.body.items));
  assert.ok(feeds.body.items.length > 0, '真服务里应有订阅源');
  checks += 3;

  const items = await json('/items?limit=5');
  assert.equal(items.status, 200);
  assert.ok(Array.isArray(items.body.items));
  checks += 2;

  // 选中上报 → 读回（真 socket，走完整 JSON 往返）
  const pushed = await json('/selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'e2e', selection: { kind: 'item', id: 1, title: 'e2e 选中' } }),
  });
  assert.equal(pushed.body.selection.selection.title, 'e2e 选中');
  const readBack = await json('/selection?session=e2e');
  assert.equal(readBack.body.selection.selection.id, '1');
  checks += 2;

  // 工具层：直接调 hub_feeds 的 execute，确认拿到的文本是可读摘要
  const feedsTool = registered.tools.find((entry) => entry.tool.name === 'hub_feeds').tool;
  const text = await feedsTool.execute({ limit: 5 });
  assert.ok(typeof text === 'string' && text.includes('|'), 'hub_feeds 应返回表格摘要');
  assert.ok(/共 \d+ 个源/.test(text));
  checks += 2;

  const selectionTool = registered.tools.find((entry) => entry.tool.name === 'hub_selection').tool;
  const selText = await selectionTool.execute({ session_id: 'e2e' });
  assert.ok(selText.includes('e2e 选中'), 'hub_selection 应读到刚上报的选中');
  checks += 1;

  // ---- 每日精选 -----------------------------------------------------------
  const digestList = await json('/digest?limit=10');
  assert.equal(digestList.status, 200);
  assert.ok(Array.isArray(digestList.body.items));
  assert.ok(digestList.body.items.length > 0, '真库里应有精选期次');
  checks += 3;

  const first = digestList.body.items[0];
  const digestOne = await json('/digest/' + encodeURIComponent(first.id));
  assert.equal(digestOne.status, 200);
  assert.equal(digestOne.body.collection.id, first.id);
  assert.ok(Array.isArray(digestOne.body.collection.items), '详情应带条目数组');
  checks += 3;

  const digestTool = registered.tools.find((entry) => entry.tool.name === 'hub_digest').tool;
  const digestText = await digestTool.execute({ limit: 5 });
  assert.ok(/期/.test(digestText), 'hub_digest 列表应有期数文案：' + digestText.slice(0, 80));
  const digestDetailText = await digestTool.execute({ collection_id: first.id });
  assert.ok(digestDetailText.includes(first.title || first.id), '展开某一期应带标题');
  checks += 2;

  // ---- 关注偏好 -----------------------------------------------------------
  const prefsRead = await json('/preferences');
  assert.equal(prefsRead.status, 200);
  assert.ok(Array.isArray(prefsRead.body.directions));
  const originalDirections = prefsRead.body.directions.slice();
  checks += 2;

  // 写路径：原样写回，验证 PUT 通且不改变用户数据
  const prefsWrite = await json('/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directions: originalDirections }),
  });
  assert.equal(prefsWrite.status, 200);
  assert.deepEqual(prefsWrite.body.directions, originalDirections, 'PUT 原样写回应得到同样的列表');
  checks += 2;

  const prefsTool = registered.tools.find((entry) => entry.tool.name === 'hub_preferences').tool;
  const prefsText = await prefsTool.execute({ action: 'list' });
  if (originalDirections.length > 0) {
    assert.ok(prefsText.includes(originalDirections[0]), 'hub_preferences 应列出已保存方向');
  }
  checks += 1;
} else {
  // 服务没起：断言降级路径是"可执行的"，而不是崩溃或白屏
  assert.equal(status.body.service.code, 'service-down');
  const feeds = await json('/feeds');
  assert.equal(feeds.status, 503);
  assert.ok(String(feeds.body.hint).includes('service/start'));
  checks += 3;
}

server.close();
console.log(`e2e_host_smoke: ${checks} 项断言通过`);
if (!serviceOk) {
  console.log('提示：Python 服务未启动，本次只验证了降级路径。起服务后重跑可验证真数据链路。');
}