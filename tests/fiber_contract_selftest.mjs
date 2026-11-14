/**
 * fiber_contract_selftest.mjs —— 宿主半边的契约自检（不启动 DSH）。
 *
 * 断言的是"宿主会怎么调我们"：name / inject / apply / Config 的形态与语义。
 * 这几条一旦漂移，插件在整个 profile 里就起不来，而报错往往看不出原因，
 * 所以放在第一道。
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const mod = await import('../src/index.mjs');

let checks = 0;
function ok(name, fn) { fn(); checks += 1; void name; }

// ---- 导出面 ---------------------------------------------------------------
assert.equal(typeof mod.name, 'string');
assert.ok(mod.name.includes('message-hub'), 'name 应包含 message-hub');
assert.ok(Array.isArray(mod.inject), 'inject 必须是数组（本插件全部服务可选）');
assert.equal(mod.inject.length, 0);
assert.equal(typeof mod.apply, 'function');
assert.equal(typeof mod.Config, 'object');
checks += 4;

// ---- Config：默认值 -------------------------------------------------------
const validator = mod.Config['~standard'];
assert.equal(validator.version, 1);
const defaults = validator.validate({});
assert.ok(!defaults.issues, '空配置应合法');
assert.equal(defaults.value.apiBase, 'http://127.0.0.1:4001');
assert.equal(defaults.value.autoStart, true);
assert.equal(defaults.value.defaultLimit, 50);
assert.equal(defaults.value.token, '');
checks += 5;

// ---- Config：trim 与非法值 -------------------------------------------------
const trimmed = validator.validate({ apiBase: '  http://127.0.0.1:4999/  ', token: '  abc  ' });
assert.equal(trimmed.value.apiBase, 'http://127.0.0.1:4999/');
assert.equal(trimmed.value.token, 'abc');
checks += 2;

// 标准 schema 语义：有 issue 就只回 issues（宿主据此拒载），不回 value
const bad = validator.validate({ autoStart: 'yes', defaultLimit: 0 });
assert.ok(Array.isArray(bad.issues) && bad.issues.length === 2, '两个非法字段应各报一条 issue');
assert.equal(bad.value, undefined);
assert.deepEqual(bad.issues.map((issue) => issue.path[0]).sort(), ['autoStart', 'defaultLimit']);
checks += 3;

const badType = validator.validate({ apiBase: 123 });
assert.ok(badType.issues.some((issue) => issue.path[0] === 'apiBase'));
checks += 1;

// ---- 路径与 token 解析 -----------------------------------------------------
const home = os.homedir();
assert.equal(mod.expandHome('~/x', '/home/u'), path.join('/home/u', 'x'));
assert.equal(mod.expandHome('%USERPROFILE%\\y', 'C:\\Users\\t'), 'C:\\Users\\t\\y');
assert.equal(mod.expandHome('/abs/z', '/home/u'), '/abs/z');
checks += 3;

// 显式配置优先于文件
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-token-'));
const tokenFile = path.join(tmpDir, 'api-token');
fs.writeFileSync(tokenFile, 'from-file\n', 'utf8');
assert.equal(mod.resolveToken({ token: 'from-config', tokenFile }, {}, home), 'from-config');
assert.equal(mod.resolveToken({ token: '  ', tokenFile }, {}, home), 'from-file');
assert.equal(mod.resolveToken({ token: '', tokenFile: path.join(tmpDir, 'missing') }, {}, home), '');
checks += 3;

assert.equal(mod.resolveServiceDir({ serviceDir: '  D:/x  ' }), 'D:/x');
assert.equal(mod.resolveServiceDir({}), mod.PACKAGE_SERVICE_DIR);
assert.ok(fs.existsSync(path.join(mod.PACKAGE_SERVICE_DIR, 'message_subscriptions', 'server.py')), '内置引擎应随包存在');
assert.equal(mod.resolveRuntimeDir({}, {}, home), path.join(home, '.dsh', 'message-hub', 'runtime'));
assert.equal(mod.resolveRuntimeDir({ runtimeDir: '~/rt' }, {}, home), path.join(home, 'rt'));
checks += 5;

// ---- 数据目录：默认落点 + 可配置 + 传给服务的参数 --------------------------
assert.equal(mod.DEFAULT_DATA_DIR, path.join(home, '.dsh', 'message-hub', 'data'));
assert.equal(mod.resolveDataDir({}, {}, home), path.join(home, '.dsh', 'message-hub', 'data'));
assert.equal(mod.resolveDataDir({ dataDir: 'D:/subs-data' }, {}, home), 'D:/subs-data');
assert.equal(mod.resolveDataDir({ dataDir: '~/mh' }, {}, home), path.join(home, 'mh'));
assert.equal(mod.resolveDataDir({}, { DSH_MESSAGE_HUB_DATA: 'E:/env-data' }, home), 'E:/env-data');
// 配置优先于环境变量
assert.equal(mod.resolveDataDir({ dataDir: 'D:/cfg' }, { DSH_MESSAGE_HUB_DATA: 'E:/env' }, home), 'D:/cfg');
checks += 6;

assert.equal(mod.databaseFile('D:/subs-data'), path.join('D:/subs-data', 'subscriptions.db'));
assert.deepEqual(mod.splitBase('http://127.0.0.1:4001'), { host: '127.0.0.1', port: '4001' });
assert.deepEqual(mod.splitBase('不是 URL'), { host: '127.0.0.1', port: '4001' });
checks += 3;

// 拉起服务时必须显式带 --database，否则服务会按 cwd 在代码仓里建库
assert.deepEqual(
  mod.buildServiceArgs({ apiBase: 'http://127.0.0.1:4001', dataDir: 'D:/subs-data' }),
  ['--host', '127.0.0.1', '--port', '4001', '--database', path.join('D:/subs-data', 'subscriptions.db')],
);
assert.deepEqual(
  mod.buildServiceArgs({ apiBase: 'http://127.0.0.1:4001', dataDir: '' }),
  ['--host', '127.0.0.1', '--port', '4001'],
);
checks += 2;

// 数据目录不可创建时应回可读原因，而不是抛异常
// （用没人监听的端口，避免撞上本机正在跑的引擎而被「已在运行」提前返回）
{
  const starter = mod.createStarter({
    serviceDir: path.join(tmpDir, 'no-such-service'),
    apiBase: 'http://127.0.0.1:4011',
    dataDir: path.join(tmpDir, 'a-file-blocker', 'nested'),
    runtimeDir: path.join(tmpDir, 'runtime'),
    log: () => {},
  });
  fs.writeFileSync(path.join(tmpDir, 'a-file-blocker'), 'not a dir', 'utf8');
  const failed = await starter();
  assert.equal(failed.ok, false);
  assert.ok(/数据目录无法创建/.test(failed.message), '应报数据目录问题：' + failed.message);
  checks += 2;
}

// ---- apply：给一个最小 ctx，确认它能自己跑起来（服务不在也应"挂载成功"）----
const effects = [];
const fakeCtx = {
  logger: { info() {}, warn() {} },
  get: () => false,           // 没有 webServer / tools：极简组合
  effect: (fn) => { effects.push(fn); return () => {}; },
  reflect: { provide: () => () => {} },
  provide: () => {},
};
const result = await mod.apply(fakeCtx, { apiBase: 'http://127.0.0.1:9', autoStart: false });
assert.ok(result && result.service, 'apply 应返回 service');
assert.equal(typeof result.service.probe, 'function');
assert.ok(effects.length >= 1, 'apply 应注册 teardown effect');
checks += 3;

// 没有 webServer / tools 时不该抛错（这是"精简组合也要能挂载"的保证）
assert.ok(true);

console.log(`fiber_contract_selftest: ${checks} 项断言全部通过`);