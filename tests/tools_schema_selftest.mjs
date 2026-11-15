/**
 * tools_schema_selftest.mjs —— 工具 parameters 必须是标准 JSON Schema。
 *
 * 背景：插件的 defineTool 兜底路径曾把「属性表」原样当 schema 发给宿主，
 * 顶层于是出现 `type: { type: 'string' }`，严格网关（LiteLLM / OpenAI）会以
 * `Tool function has invalid 'parameters' schema` 直接 400。这里锁住兜底路径
 * 的产出形状，防止回归。
 */
import assert from 'node:assert/strict';
import { registerTools } from '../src/tools.mjs';

let checks = 0;
function ok(name, fn) { fn(); checks += 1; void name; }

const registered = [];
const registry = {
  register(tool, label) {
    registered.push({ tool, label });
    return () => {};
  },
};

// 没有 ctx.require → 走本地编译兜底，正是出问题机器上的路径。
registerTools({ ctx: {}, tools: registry, service: {}, selection: null, log: () => {} });

ok('十个工具全部注册', () => {
  assert.equal(registered.length, 10);
  assert.equal(new Set(registered.map(({ tool }) => tool.name)).size, 10);
});

ok('每个 parameters 都是对象根 + properties 映射', () => {
  for (const { tool } of registered) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} 的 parameters.type`);
    assert.ok(tool.parameters.properties && typeof tool.parameters.properties === 'object', `${tool.name} 缺 properties`);
    assert.ok(!Array.isArray(tool.parameters.properties));
    // 属性名不能泄漏到 schema 顶层（否则 type/id/name 会覆盖关键字）
    for (const key of ['id', 'name', 'url', 'q', 'limit']) {
      assert.equal(tool.parameters[key], undefined, `${tool.name} 顶层混入了属性名 ${key}`);
    }
  }
});

ok('hub_feed_add 的 type 是字符串属性而不是 schema 本身', () => {
  const tool = registered.find(({ tool }) => tool.name === 'hub_feed_add').tool;
  const type = tool.parameters.properties.type;
  assert.equal(type.type, 'string');
  assert.match(type.description, /rss \| github_releases \| web_page/);
  assert.equal(tool.parameters.properties.interval_minutes.type, 'integer');
  assert.equal(tool.parameters.properties.config.type, 'object');
  assert.equal(tool.parameters.required, undefined, '没有必填参数时不应出现 required');
});

ok('无参工具的 parameters 是空对象 schema', () => {
  const tool = registered.find(({ tool }) => tool.name === 'hub_status').tool;
  assert.deepEqual(tool.parameters, { type: 'object', properties: {} });
});

ok('execute / output / description 都保留', () => {
  for (const { tool } of registered) {
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.output && typeof tool.output.render === 'function');
    assert.ok(tool.description.length > 10);
  }
});

console.log(`tools_schema_selftest: ${checks} 项断言全部通过`);