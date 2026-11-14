/**
 * index.mjs —— 消息订阅插件宿主半边入口（纯 ESM，无第三方依赖）。
 *
 * 契约边界与 dsh-strategy-workbench / dsh-blender-plugin 一致：
 * 本文件只声明 `name` / `inject` / `apply(ctx, config)` 与 `Config`；业务在：
 *   - service.mjs  与引擎的边界（HTTP 契约、错误码、选中态）
 *   - server.mjs   面板用的 BFF 路由
 *   - tools.mjs    模型侧 hub_* 工具
 *   - python.mjs   内置引擎的运行时：解释器 / venv / 依赖 / 进程
 *
 * 设计取舍：插件**不实现采集**，但**自带采集引擎**。
 *   `service/` 是原样搬进来的 Python 订阅引擎（采集、去重、SSRF 防护、配置校验都在里面），
 *   面板与工具只经 BFF 与它对话。搬进来是为了不再依赖另一个 checkout、另一台机器上的常驻
 *   服务；升级引擎 = 用上游新版本覆盖 `service/`。插件这半边仍然只做代理、呈现与工具。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RUNTIME_DIR,
  ensureRuntime,
  probeHealth,
  resolvePython,
  serviceArgs,
  spawnService,
  venvPaths,
  waitForHealth,
} from './python.mjs';
import { registerBundledSkill } from './skills.mjs';

export const name = '@dsh-external/dsh-message-hub';

/** 需要的宿主服务：webServer / tools 全部可选（缺了也能挂载，只是少一半能力）。 */
export const inject = [];

export const DEFAULT_API_BASE = 'http://127.0.0.1:4001';
export const DEFAULT_TOKEN_FILE = '~/.config/message-subscriptions/api-token';

/** 数据目录默认落点（SQLite 与采集产物）。 */
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'message-hub', 'data');

/** 本仓库内置的引擎目录（`service/`）：venv 与 config 都从这里来。 */
export const PACKAGE_SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'service');

export { DEFAULT_RUNTIME_DIR, resolvePython, serviceArgs, venvPaths };

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-message-hub',
    validate(value) {
      const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const issues = [];
      const out = {};

      const str = (key, fallback) => {
        const raw = input[key];
        if (raw === undefined) return fallback;
        if (typeof raw !== 'string') {
          issues.push({ message: `${key} 必须是字符串`, path: [key] });
          return fallback;
        }
        return raw.trim();
      };

      out.apiBase = str('apiBase', DEFAULT_API_BASE) || DEFAULT_API_BASE;
      out.token = str('token', '');
      out.tokenFile = str('tokenFile', DEFAULT_TOKEN_FILE);
      // 空串 = 用默认落点，由 resolve* 系列解析（配了就展开 ~ 直接用）
      out.dataDir = str('dataDir', '');
      out.runtimeDir = str('runtimeDir', '');
      out.serviceDir = str('serviceDir', '');
      out.pythonPath = str('pythonPath', '');

      const autoStart = input.autoStart === undefined ? true : input.autoStart;
      if (typeof autoStart !== 'boolean') {
        issues.push({ message: 'autoStart 必须是布尔值', path: ['autoStart'] });
        out.autoStart = true;
      } else {
        out.autoStart = autoStart;
      }

      const installDeps = input.installDeps === undefined ? true : input.installDeps;
      if (typeof installDeps !== 'boolean') {
        issues.push({ message: 'installDeps 必须是布尔值', path: ['installDeps'] });
        out.installDeps = true;
      } else {
        out.installDeps = installDeps;
      }

      const limit = input.defaultLimit === undefined ? 50 : input.defaultLimit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
        issues.push({ message: 'defaultLimit 必须是 1..100 的整数', path: ['defaultLimit'] });
        out.defaultLimit = 50;
      } else {
        out.defaultLimit = limit;
      }

      // 自动采集：0 = 关闭；默认 6 小时一轮。引擎本身没有调度器，
      // 不在这里定时跑，条目就只会在有人手动点「采集」时才更新。
      const collect = input.collectIntervalMinutes === undefined ? 360 : input.collectIntervalMinutes;
      if (!Number.isFinite(collect) || collect < 0 || collect > 1440) {
        issues.push({ message: 'collectIntervalMinutes 必须是 0..1440 的整数（0 关闭）', path: ['collectIntervalMinutes'] });
        out.collectIntervalMinutes = 360;
      } else {
        out.collectIntervalMinutes = Math.floor(collect);
      }

      if (issues.length > 0) return { issues };
      return { value: out };
    },
  },
};

/** `~/x`、`%USERPROFILE%\x` 都要能展开，否则 Windows 上默认 tokenFile 永远读不到。 */
export function expandHome(filePath, home = os.homedir()) {
  if (!filePath) return '';
  const raw = String(filePath);
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2));
  if (raw.startsWith('%USERPROFILE%')) return raw.replace('%USERPROFILE%', home);
  return raw;
}

/** token 优先级：显式配置 > 环境变量 > token 文件。 */
export function resolveToken(config = {}, env = process.env, home = os.homedir()) {
  const direct = String(config.token || env.DSH_MESSAGE_HUB_TOKEN || '').trim();
  if (direct) return direct;
  const file = expandHome(config.tokenFile || env.DSH_MESSAGE_HUB_TOKEN_FILE || DEFAULT_TOKEN_FILE, home);
  try {
    const fromFile = fs.readFileSync(file, 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // 没有 token 文件是常态：内置引擎默认不带写保护
  }
  return '';
}

/** 引擎目录：默认用仓库里的 `service/`；配了 serviceDir / 环境变量就指到别处。 */
export function resolveServiceDir(config = {}, env = process.env) {
  const configured = String(config.serviceDir || env.DSH_MESSAGE_HUB_SERVICE || '').trim();
  return configured ? expandHome(configured) : PACKAGE_SERVICE_DIR;
}

/**
 * 运行时目录（venv、安装日志、service.log）。
 * 与 dataDir 分开：数据可以单独备份，而 venv 是几十 MB 的可再生垃圾。
 */
export function resolveRuntimeDir(config = {}, env = process.env, home = os.homedir()) {
  const configured = String(config.runtimeDir || env.DSH_MESSAGE_HUB_RUNTIME || '').trim();
  return configured ? expandHome(configured, home) : path.join(home, '.dsh', 'message-hub', 'runtime');
}

/**
 * 数据目录解析（优先级从高到低）：
 *   1. 配置 `dataDir`（`~` 会展开）
 *   2. 环境变量 `DSH_MESSAGE_HUB_DATA`
 *   3. `<home>/.dsh/message-hub/data`
 *
 * 注意：这个目录只决定插件**让引擎把 SQLite 放哪**；插件自己不读写库文件。
 */
export function resolveDataDir(config = {}, env = process.env, home = os.homedir()) {
  const configured = String(config.dataDir || env.DSH_MESSAGE_HUB_DATA || '').trim();
  if (configured) return expandHome(configured, home);
  return path.join(home, '.dsh', 'message-hub', 'data');
}

/** 数据目录里的库文件名（与引擎的默认命名一致）。 */
export function databaseFile(dataDir) {
  return path.join(dataDir, 'subscriptions.db');
}

/** apiBase → host/port；解析失败退回 4001（拉起场景下猜错端口比崩掉好）。 */
export function splitBase(apiBase) {
  try {
    const url = new URL(String(apiBase));
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return { host: url.hostname || '127.0.0.1', port: String(port) };
  } catch {
    return { host: '127.0.0.1', port: '4001' };
  }
}

/** 兼容旧导出名：引擎服务的命令行参数（`-m` 前缀由 createStarter 补上）。 */
export function buildServiceArgs({ apiBase = DEFAULT_API_BASE, dataDir = '', configPath = '' } = {}) {
  const { host, port } = splitBase(apiBase);
  const args = ['--host', host, '--port', port];
  if (dataDir) args.push('--database', databaseFile(dataDir));
  if (configPath) args.push('--config', configPath);
  return args;
}

function noop() {}

/**
 * 拉起内置引擎。
 *
 * 顺序是刻意的：
 *   1. 先探活 —— 已经在跑就别再 spawn 一个（端口冲突只会得到一份看不懂的日志）；
 *   2. 建数据目录 —— SQLite 只建文件不建目录，否则引擎会以晦涩的
 *      "unable to open database file" 退出；
 *   3. 准备 venv 与依赖 —— 首次可能要几十秒到几分钟（pip），这一步失败要给出原文；
 *   4. spawn + 等健康检查 —— 只有真的能答话才回 ok。
 *
 * 同一个 starter 上并发调用共享同一个 in-flight Promise：连点两次「启动服务」不会起两个进程。
 */
export function createStarter({
  serviceDir = PACKAGE_SERVICE_DIR,
  apiBase = DEFAULT_API_BASE,
  dataDir = '',
  runtimeDir = DEFAULT_RUNTIME_DIR,
  pythonPath = '',
  installDeps = true,
  log = () => {},
  platform = process.platform,
  resourcesPath = '',
  execPath = '',
} = {}) {
  let inFlight = null;

  async function startOnce() {
    const alive = await probeHealth(apiBase, 1500);
    if (alive.ok) return { ok: true, message: '服务已在运行' };

    let dbPath = '';
    if (dataDir) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        dbPath = databaseFile(dataDir);
      } catch (err) {
        return { ok: false, message: `数据目录无法创建：${dataDir}（${err && err.message ? err.message : err}）` };
      }
    }

    const entry = path.join(serviceDir, 'message_subscriptions', 'server.py');
    if (!fs.existsSync(entry)) {
      return {
        ok: false,
        message: `内置引擎不完整：找不到 ${entry}`
          + '（用 config.serviceDir 指向一个完整的 service/ 目录，或重新安装本插件）',
      };
    }

    log(`准备 Python 运行时：${runtimeDir}`);
    const runtime = await ensureRuntime({
      runtimeDir,
      serviceDir,
      requirementsFile: path.join(serviceDir, 'requirements.txt'),
      pythonPath,
      installDeps,
      platform,
      log,
      resourcesPath,
      execPath,
    });
    if (!runtime.ok) return { ok: false, message: runtime.message, detail: runtime.detail };

    const args = serviceArgs({
      apiBase,
      dataDir,
      configPath: path.join(serviceDir, 'config', 'subscriptions.yaml'),
    });
    log(`拉起引擎：${runtime.venvPython} ${args.join(' ')}（库 ${dbPath || '默认'}）`);
    const spawned = spawnService({
      venvPython: runtime.venvPython,
      serviceDir,
      args,
      logPath: path.join(runtimeDir, 'service.log'),
    });
    if (!spawned.ok) return spawned;

    const ready = await waitForHealth(apiBase, { deadlineMs: 30_000, intervalMs: 700 });
    if (!ready.ok) {
      return {
        ok: false,
        message: `已拉起引擎（pid ${spawned.pid}），但 30 秒内健康检查未通过。`
          + `日志：${path.join(runtimeDir, 'service.log')}`,
      };
    }
    return { ok: true, message: `服务已就绪（pid ${spawned.pid}）` };
  }

  return function ensureStarted() {
    if (!inFlight) {
      inFlight = startOnce().finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}

export function apply(ctx, config = {}) {
  const state = { disposed: false, ready: null, service: null, api: null, selection: null, disposers: [] };

  const logger = () => (ctx && ctx.logger) || {};
  const log = (msg) => {
    const l = logger();
    if (typeof l.info === 'function') l.info(`[message-hub] ${msg}`);
  };
  const warn = (msg) => {
    const l = logger();
    if (typeof l.warn === 'function') l.warn(`[message-hub] ${msg}`);
  };

  // 随包 skill：把「先探活、再看数据、最后动手」的操作口径交给模型。
  // 没有 skills 服务时这里静默跳过，不影响工具面。
  registerBundledSkill(ctx, warn);

  state.ready = (async () => {
    const here = new URL('.', import.meta.url);
    const { createService, openSelectionStore } = await import(new URL('./service.mjs', here).href);
    const { createApi, ROUTE_PREFIX } = await import(new URL('./server.mjs', here).href);

    const apiBase = String((config && config.apiBase) || DEFAULT_API_BASE).replace(/\/+$/, '');
    const token = resolveToken(config || {});
    const serviceDir = resolveServiceDir(config || {});
    const runtimeDir = resolveRuntimeDir(config || {});
    const dataDir = resolveDataDir(config || {});
    const service = createService({ apiBase, token, log: warn });
    const selection = openSelectionStore();
    const ensureStarted = (config && config.autoStart !== false)
      ? createStarter({
        serviceDir,
        apiBase,
        dataDir,
        runtimeDir,
        pythonPath: (config && config.pythonPath) || '',
        installDeps: !(config && config.installDeps === false),
        log,
        platform: process.platform,
        resourcesPath: process.resourcesPath || '',
        execPath: process.execPath || '',
      })
      : null;

    state.service = service;
    state.selection = selection;
    state.api = createApi({ service, selection, ensureStarted, dataDir, log });

    const probe = await service.probe();
    if (!probe.ok) {
      warn(`引擎不可达（${apiBase}）：${probe.message}`
        + (ensureStarted ? ' —— 面板可点「启动服务」，或调 hub_service_start' : ''));
    } else {
      log(`已连通引擎 ${apiBase}（${probe.health && probe.health.configured_sources} 个源）`);
    }

    // ① HTTP：宿主有 webServer 才挂；面板与模型工具都走同一条 BFF。
    const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer', false) : null;
    if (webServer && typeof webServer.register === 'function') {
      state.disposers.push(state.api.registerWebServer(webServer));
      log(`BFF 已挂载：${ROUTE_PREFIX}（引擎 ${apiBase}）`);
    } else {
      warn('没有 webServer 服务：面板与选中态上报都不可用（工具仍可用）');
    }

    // ② 工具：让模型能直接增删订阅源、查条目、读选中。
    const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools', false) : null;
    if (tools && typeof tools.register === 'function') {
      const { registerTools } = await import(new URL('./tools.mjs', here).href);
      state.disposers.push(...registerTools({
        ctx,
        tools,
        service,
        selection,
        ensureStarted,
        dataDir,
        defaultLimit: (config && config.defaultLimit) || 50,
        log,
      }));
    } else {
      warn('没有 tools 服务：hub_* 工具不会注册（对话里不能增删订阅源）');
    }

    // ③ 自动采集：引擎没有内置调度器，所以采不采集完全由插件决定。
    //    没有它，每日精选任务前一天的数据就会是空的（只有面板点开时才补）。
    const collectEvery = Number(config && config.collectIntervalMinutes);
    if (Number.isFinite(collectEvery) && collectEvery > 0) {
      let collecting = false;
      const tick = async () => {
        if (state.disposed || collecting) return;
        collecting = true;
        try {
          const summary = await service.runAll({ concurrency: 2 });
          log(`自动采集：${summary.succeeded}/${summary.total} 成功，${summary.failed} 失败`);
        } catch (err) {
          warn('自动采集失败：' + (err && err.message ? err.message : String(err)));
        } finally {
          collecting = false;
        }
      };
      const timer = setInterval(tick, Math.max(5, collectEvery) * 60 * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      state.disposers.push(() => clearInterval(timer));
      // 进程重启后 interval 会重置，先补一轮，避免「刚重启就永远等不到下一次」。
      const kickoff = setTimeout(tick, 120 * 1000);
      if (typeof kickoff.unref === 'function') kickoff.unref();
      state.disposers.push(() => clearTimeout(kickoff));
      log(`自动采集已启用：每 ${collectEvery} 分钟一轮，启动 2 分钟后先跑一次`);
    }

    // ④ 给 client 半边/其他插件读的运行时事实。
    const face = {
      apiBase,
      apiPrefix: ROUTE_PREFIX,
      serviceDir,
      runtimeDir,
      dataDir,
      database: databaseFile(dataDir),
    };
    if (ctx && ctx.reflect && typeof ctx.reflect.provide === 'function') {
      state.disposers.push(ctx.reflect.provide('messageHub', face));
    } else if (ctx && typeof ctx.provide === 'function') {
      ctx.provide('messageHub', face);
    }

    return { service, api: state.api };
  })().catch((err) => {
    warn('初始化失败：' + (err && err.stack ? err.stack : String(err)));
    throw err;
  });

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      state.disposed = true;
      for (const dispose of state.disposers.splice(0)) {
        try { dispose(); } catch { /* 清理失败不影响其他资源 */ }
      }
    }, '@dsh-external/dsh-message-hub: teardown');
  }

  return state.ready.catch(noop);
}