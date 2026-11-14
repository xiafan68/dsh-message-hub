/**
 * engine_selftest.mjs —— 内置引擎（service/）的离线契约自检。
 *
 * 这里断言的是「插件与引擎之间不该漂移的东西」：目录完整性、启动参数、venv 落点、
 * 依赖 marker 的幂等语义。它不需要联网，也不会真的起进程 —— 真起进程的验证在 e2e 里。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../src/index.mjs');
const py = await import('../src/python.mjs');

let checks = 0;
function ok(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`engine_selftest 失败：${name}`);
    throw err;
  }
  checks += 1;
}

const SERVICE = mod.PACKAGE_SERVICE_DIR;

// ---- 目录完整性：少了任何一件，启动都会在几十秒后才以晦涩错误暴露 ----------
ok('引擎目录存在', () => assert.ok(fs.existsSync(SERVICE)));
ok('入口存在', () => assert.ok(fs.existsSync(path.join(SERVICE, 'message_subscriptions', 'server.py'))));
ok('依赖清单存在', () => assert.ok(fs.existsSync(path.join(SERVICE, 'requirements.txt'))));
ok('静态资源存在', () => assert.ok(fs.existsSync(path.join(SERVICE, 'message_subscriptions', 'static', 'index.html'))));
ok('采集器存在', () => assert.ok(fs.existsSync(path.join(SERVICE, 'message_subscriptions', 'collectors', 'feed.py'))));

// 配置里的 sources 必须留空：否则启动时 sync_monitors 会把 example.com 写进用户的库
{
  const yaml = fs.readFileSync(path.join(SERVICE, 'config', 'subscriptions.yaml'), 'utf8');
  ok('配置不注入示例源', () => assert.match(yaml, /sources:\s*\[\s*\]/));
  ok('配置里没有启用的源条目', () => assert.ok(!/^\s*-\s+id:\s*\S+/m.test(yaml.replace(/^#.*$/gm, ''))));
}

// ---- venv 落点：Windows / POSIX 都要对 --------------------------------------
ok('Windows venv 路径', () => assert.deepEqual(
  py.venvPaths('C:/rt', 'win32'),
  { dir: path.join('C:/rt', 'pyenv'), python: path.join('C:/rt', 'pyenv', 'Scripts', 'python.exe') },
));
ok('POSIX venv 路径', () => assert.deepEqual(
  py.venvPaths('/rt', 'linux'),
  { dir: path.join('/rt', 'pyenv'), python: path.join('/rt', 'pyenv', 'bin', 'python3') },
));

// ---- 启动参数：数据库与配置必须是绝对路径 ----------------------------------
const args = py.serviceArgs({
  apiBase: 'http://127.0.0.1:4011',
  dataDir: 'D:/subs-data',
  configPath: 'D:/pkg/service/config/subscriptions.yaml',
});
ok('模块名在前', () => assert.deepEqual(args.slice(0, 2), ['-m', 'message_subscriptions.server']));
ok('host/port', () => assert.deepEqual(args.slice(2, 6), ['--host', '127.0.0.1', '--port', '4011']));
ok('database 指向 dataDir', () => assert.equal(args[args.indexOf('--database') + 1], path.join('D:/subs-data', 'subscriptions.db')));
ok('config 显式传给引擎', () => assert.equal(args[args.indexOf('--config') + 1], 'D:/pkg/service/config/subscriptions.yaml'));

ok('buildServiceArgs 与引擎参数一致', () => assert.deepEqual(
  mod.buildServiceArgs({ apiBase: 'http://127.0.0.1:4001', dataDir: 'D:/subs-data' }),
  ['--host', '127.0.0.1', '--port', '4001', '--database', path.join('D:/subs-data', 'subscriptions.db')],
));

// ---- 依赖安装：关掉 installDeps 时必须明说，而不是静默失败 -----------------
{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-rt-'));
  const result = await py.ensureRuntime({
    runtimeDir,
    serviceDir: SERVICE,
    requirementsFile: path.join(SERVICE, 'requirements.txt'),
    installDeps: false,
    platform: process.platform,
  });
  ok('installDeps=false 可读报错', () => assert.equal(result.ok, false));
  ok('报错提到 installDeps', () => assert.match(result.message, /installDeps/));
}

// ---- marker 幂等：requirements 没变就不该再跑 pip --------------------------
{
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-marker-'));
  const { dir, python: pythonPath } = py.venvPaths(runtimeDir, process.platform);
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, '', 'utf8');
  const requirements = path.join(SERVICE, 'requirements.txt');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(requirements)).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(dir, '.dsh-deps.json'), JSON.stringify({ hash }), 'utf8');

  const result = await py.ensureRuntime({ runtimeDir, serviceDir: SERVICE, requirementsFile: requirements, platform: process.platform });
  ok('marker 命中 → 不重装', () => {
    assert.equal(result.ok, true);
    assert.equal(result.installed, false);
  });
}

// ---- 解释器解析：找不到时要给可执行的说明，而不是抛异常 --------------------
{
  const result = await py.resolvePython({
    configured: '',
    env: {},
    platform: process.platform,
    exists: () => false,
    log: () => {},
  });
  ok('找不到 Python 时 ok=false', () => assert.equal(result.ok, false));
  ok('报错带修法', () => assert.match(result.message, /pythonPath/));
}

ok('运行时默认目录在 ~/.dsh 下', () => assert.equal(
  mod.DEFAULT_RUNTIME_DIR,
  path.join(os.homedir(), '.dsh', 'message-hub', 'runtime'),
));

console.log(`engine_selftest: ${checks} 项断言全部通过`);