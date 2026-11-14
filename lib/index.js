/**
 * lib/index.js —— 宿主半边产物入口（转发出口，保证与 src 不漂移）。
 *
 * 为什么不是打包产物：宿主半边是纯 ESM，无 TypeScript、无第三方运行时依赖。
 * 直接 `export ... from '../src/index.mjs'` 有三点好处：
 *   1. lib/ 与 src/ 不会出现两份可漂移的代码（改 src 即生效）；
 *   2. stack trace 指向真实源码，排障不用对着编译产物猜；
 *   3. 发布时 files 已包含 src，npm 打包不丢文件。
 *
 * 导出契约（DSH host plugin 最小面）：
 *   - name    包名
 *   - inject  需要的宿主服务（本插件全部可选，故为空数组）
 *   - apply   (ctx, config) => Promise<void>
 *   - Config  配置字段声明（宿主据此补默认值）
 *   - 其余导出供自检与排障：路径/token 解析、默认地址、运行时（解释器/venv）工具
 */
export {
  name,
  inject,
  apply,
  Config,
  DEFAULT_API_BASE,
  DEFAULT_TOKEN_FILE,
  DEFAULT_DATA_DIR,
  DEFAULT_RUNTIME_DIR,
  PACKAGE_SERVICE_DIR,
  expandHome,
  resolveToken,
  resolveServiceDir,
  resolveRuntimeDir,
  resolveDataDir,
  databaseFile,
  splitBase,
  buildServiceArgs,
  createStarter,
  resolvePython,
  serviceArgs,
  venvPaths,
} from '../src/index.mjs';