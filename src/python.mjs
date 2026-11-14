/**
 * python.mjs —— 内置订阅引擎的运行时管理（解释器 / venv / 依赖 / 拉起服务）。
 *
 * 这一层只回答一个问题：**怎样在这台机器上把 service/ 里的 Python 引擎跑起来。**
 * 它不做业务判断，也不认识面板：输入是路径与配置，输出是「起没起来、没起来该修哪里」。
 *
 * 为什么需要它（而不是让用户自己装 Python 再跑脚本）：
 *   - DSH 桌面端自带一份 Python（resources/runtime/primary-runtime/dependencies/python），
 *     但里面没有 fastapi/uvicorn/httpx/bs4。所以「自带解释器」不等于「开箱可跑」：
 *     首次启动仍要在 <runtimeDir>/pyenv 里建 venv 装这五个包。
 *   - 引擎用 `-m message_subscriptions.server` 起：cwd 必须是 service/，模块才在
 *     sys.path 上；config 用绝对路径传，避免被 cwd 决定。
 *   - 安装是**有成本的**（联网、几十 MB），所以用 marker 记录 requirements 的哈希：
 *     只有首次或 requirements 变了才重新装。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const PYTHON_MIN = 3.11;

/** 默认运行时目录（venv 与安装日志都在这里）。与 dataDir 分开，备份数据时不必带上 venv。 */
export const DEFAULT_RUNTIME_DIR = path.join(os.homedir(), '.dsh', 'message-hub', 'runtime');

/** `<runtimeDir>/pyenv` 里解释器的落点。 */
export function venvPaths(runtimeDir, platform = process.platform) {
  const dir = path.join(runtimeDir, 'pyenv');
  const python = platform === 'win32'
    ? path.join(dir, 'Scripts', 'python.exe')
    : path.join(dir, 'bin', 'python3');
  return { dir, python };
}

/**
 * 宿主自带的 Python 可能在哪儿。
 * Windows 桌面端实测：<install>/resources/runtime/primary-runtime/dependencies/python/python.exe
 */
export function bundledPythonCandidates({ platform = process.platform, resourcesPath = '', execPath = '' } = {}) {
  const resources = resourcesPath
    || (execPath ? path.join(path.dirname(execPath), 'resources') : '');
  if (!resources) return [];
  const base = path.join(resources, 'runtime', 'primary-runtime', 'dependencies', 'python');
  return platform === 'win32'
    ? [path.join(base, 'python.exe')]
    : [path.join(base, 'bin', 'python3'), path.join(base, 'bin', 'python')];
}

/** PATH 里的候选命令（Windows 不解析 .bat，避免被应用商店别名劫持）。 */
function pathCandidates(platform, env) {
  const names = platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  const dirs = String(env.PATH || env.Path || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const out = [];
  for (const dir of dirs) {
    for (const name of names) out.push(path.join(dir, name));
  }
  return out;
}

function runCapture(command, args, { timeoutMs = 15000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err && err.message ? err.message : err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已经退出 */ }
      resolve({ ok: false, code: -2, stdout, stderr: stderr + '\n(超时被终止)' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-16_384); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(err && err.message ? err.message : err) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/**
 * 找一个能用的 Python（>=3.11）：
 *   config.pythonPath → 宿主自带 → PATH。
 * 每个候选都真跑一次版本探测：存在不代表能用（Windows 的商店别名、坏掉的 venv 都见过）。
 */
export async function resolvePython({
  configured = '',
  platform = process.platform,
  env = process.env,
  resourcesPath = '',
  execPath = '',
  exists = fs.existsSync,
  log = () => {},
} = {}) {
  const tried = [];
  const candidates = [];
  if (configured) candidates.push({ path: configured, source: 'config.pythonPath' });
  for (const candidate of bundledPythonCandidates({ platform, resourcesPath, execPath })) {
    candidates.push({ path: candidate, source: '宿主自带' });
  }
  for (const candidate of pathCandidates(platform, env)) {
    candidates.push({ path: candidate, source: 'PATH' });
  }

  for (const candidate of candidates) {
    if (!exists(candidate.path)) { tried.push(`${candidate.source}=${candidate.path}（不存在）`); continue; }
    const probe = await runCapture(candidate.path, ['-c', 'import sys;print(sys.version_info[0], sys.version_info[1])'], { timeoutMs: 8000 });
    if (!probe.ok) { tried.push(`${candidate.source}=${candidate.path}（无法执行）`); continue; }
    const [major, minor] = probe.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(major) || !Number.isInteger(minor)) {
      tried.push(`${candidate.source}=${candidate.path}（版本输出无法解析）`);
      continue;
    }
    if (major < 3 || (major === 3 && minor < PYTHON_MIN)) {
      tried.push(`${candidate.source}=${candidate.path}（${major}.${minor} < ${PYTHON_MIN}）`);
      continue;
    }
    log(`使用 Python ${major}.${minor}：${candidate.path}（${candidate.source}）`);
    return { ok: true, path: candidate.path, version: `${major}.${minor}`, source: candidate.source };
  }

  return {
    ok: false,
    message: [
      `找不到可用的 Python（需要 >= ${PYTHON_MIN}）。`,
      '已尝试：',
      ...tried.slice(0, 6).map((line) => `  · ${line}`),
      '修法：装一个 Python 3.11+，或在配置里写 pythonPath 指向解释器。',
    ].join('\n'),
  };
}

function requirementsHash(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

function markerPath(venvDir) {
  return path.join(venvDir, '.dsh-deps.json');
}

function readMarker(venvDir) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(venvDir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 建 venv、装依赖，幂等。
 *
 * 幂等键 = requirements 的哈希：内容没变就跳过（否则每次点「启动服务」都要等 pip）。
 * 装失败时把 pip 的最后几行带回去 —— 「依赖装不上」这种错误，没有原文没法修。
 */
export async function ensureRuntime({
  runtimeDir,
  serviceDir,
  requirementsFile,
  pythonPath = '',
  installDeps = true,
  platform = process.platform,
  log = () => {},
  installTimeoutMs = 300_000,
  venvTimeoutMs = 120_000,
  resourcesPath = '',
  execPath = '',
} = {}) {
  if (!runtimeDir) return { ok: false, message: '缺少 runtimeDir' };
  const requirements = requirementsFile || path.join(serviceDir, 'requirements.txt');
  if (!fs.existsSync(requirements)) {
    return { ok: false, message: `找不到依赖清单：${requirements}（service/ 不完整？）` };
  }

  const { dir: venvDir, python: venvPython } = venvPaths(runtimeDir, platform);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
  } catch (err) {
    return { ok: false, message: `运行时目录无法创建：${runtimeDir}（${err && err.message ? err.message : err}）` };
  }

  const hash = requirementsHash(requirements);
  const marker = readMarker(venvDir);
  const venvExists = fs.existsSync(venvPython);

  if (venvExists && marker && marker.hash === hash) {
    log(`Python 运行时已就绪：${venvPython}`);
    return { ok: true, venvPython, installed: false, message: '依赖已就绪' };
  }

  if (!installDeps) {
    return {
      ok: false,
      message: `运行时未安装（${venvDir}），且 config.installDeps = false。`
        + `请手动执行：${venvPython} -m pip install -r "${requirements}"`,
    };
  }

  const installLog = path.join(runtimeDir, 'install.log');
  const appendInstallLog = (text) => {
    try { fs.appendFileSync(installLog, text.endsWith('\n') ? text : `${text}\n`, 'utf8'); } catch { /* 日志失败不影响安装 */ }
  };

  // ① venv 不存在就建一个：用找到的 Python；已有的基础解释器不重建（重建会白等）。
  if (!venvExists) {
    const python = await resolvePython({ configured: pythonPath, platform, resourcesPath, execPath, log });
    if (!python.ok) return { ok: false, message: python.message };
    appendInstallLog(`[venv] ${python.path} -m venv ${venvDir}`);
    const created = await runCapture(python.path, ['-m', 'venv', venvDir], { timeoutMs: venvTimeoutMs });
    if (!created.ok || !fs.existsSync(venvPython)) {
      appendInstallLog(created.stderr || created.stdout);
      return {
        ok: false,
        message: `创建 venv 失败（${venvDir}）：${(created.stderr || created.stdout || '').trim().slice(-400)}`,
      };
    }
  }

  // ② 装依赖。用 venv 里的 pip，避免污染基础解释器。
  appendInstallLog(`[pip] install -r ${requirements}`);
  const pip = await runCapture(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', requirements], {
    timeoutMs: installTimeoutMs,
    env: { PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONUTF8: '1' },
  });
  appendInstallLog(pip.stdout);
  appendInstallLog(pip.stderr);
  if (!pip.ok) {
    return {
      ok: false,
      message: `安装 Python 依赖失败（venv：${venvDir}）。pip 输出见 ${installLog}。`,
      detail: (pip.stderr || pip.stdout || '').trim().slice(-600),
    };
  }

  try {
    fs.writeFileSync(markerPath(venvDir), JSON.stringify({ hash, requirements, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch { /* marker 写不进去只影响下次会重装，不阻塞启动 */ }
  log(`Python 依赖安装完成：${venvPython}`);
  return { ok: true, venvPython, installed: true, message: '依赖安装完成' };
}

/** 上游服务的参数：cwd 决定模块与相对 config，所以这里只用绝对路径。 */
export function serviceArgs({ apiBase, dataDir, configPath }) {
  let host = '127.0.0.1';
  let port = '4001';
  try {
    const url = new URL(String(apiBase));
    host = url.hostname || host;
    port = url.port || (url.protocol === 'https:' ? '443' : '80');
  } catch { /* 非法地址按默认端口起，BFF 会另外报不可达 */ }
  const args = ['-m', 'message_subscriptions.server', '--host', host, '--port', port];
  if (dataDir) args.push('--database', path.join(dataDir, 'subscriptions.db'));
  if (configPath) args.push('--config', configPath);
  return args;
}

/** 拉起服务进程：detached，父进程退出后它继续活；stdout/stderr 落到 service.log。 */
export function spawnService({ venvPython, serviceDir, args, logPath, env = {} }) {
  let logFd = null;
  try {
    logFd = logPath ? fs.openSync(logPath, 'a') : null;
  } catch {
    logFd = null;
  }
  try {
    const child = spawn(venvPython, args, {
      cwd: serviceDir,
      detached: true,
      windowsHide: true,
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        // 不要在 service/（包内只读资源）里写 __pycache__：升级时容易被一起带脏
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: serviceDir,
        ...env,
      },
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, message: `拉起失败：${err && err.message ? err.message : err}` };
  } finally {
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* 子进程已继承句柄 */ }
    }
  }
}

export async function probeHealth(apiBase, timeoutMs = 2000) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, message: String(err && err.message ? err.message : err) };
  }
}

export async function waitForHealth(apiBase, { deadlineMs = 30_000, intervalMs = 700 } = {}) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const probe = await probeHealth(apiBase, 2000);
    if (probe.ok) return { ok: true };
  }
  return { ok: false };
}