/**
 * build-client.mjs —— 客户端半边构建：`src/client/index.js` → `lib/client.js`。
 *
 * 与 dsh-strategy-workbench / dsh-blender-plugin 同一套做法：**不打包、不新增依赖**，
 * 只做拷贝 + sourceMappingURL 清洗 + 产物指纹 + 结构契约校验。
 * DSH 的 client 半边本来就是 `__ModuleLoader__.load` 形态，再套一层 bundler 只会
 * 引入新的失败面（本机装新依赖也不可靠）。
 *
 *   node scripts/build-client.mjs            # 写 lib/client.js
 *   node scripts/build-client.mjs --check    # 只校验是否最新
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src', 'client', 'index.js');
const OUT = path.join(ROOT, 'lib', 'client.js');
const CHECK_ONLY = process.argv.includes('--check');

if (!fs.existsSync(SRC)) {
  console.error('build-client: 源文件不存在：' + path.relative(ROOT, SRC));
  process.exit(1);
}

let code = fs.readFileSync(SRC, 'utf8');
const MAP_COMMENT_RE = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=[^\n]*$/gm;
const removedMapRefs = (code.match(MAP_COMMENT_RE) || []).length;
code = code.replace(MAP_COMMENT_RE, '').replace(/\n{3,}$/, '\n');
if (!code.endsWith('\n')) code += '\n';

// 结构性契约：客户端 bundle 必须自注册，且只导出 apply / inject。
const required = [
  ['window.__ModuleLoader__.load', '缺少 __ModuleLoader__.load 外壳'],
  ['exports.apply', '缺少 exports.apply'],
  ['exports.inject', '缺少 exports.inject'],
  ['"sidebar.panellist"', '缺少侧栏槽位注册'],
  ['"conversation.input.dock"', '缺少会话桥槽位注册'],
];
for (const [needle, message] of required) {
  if (!code.includes(needle)) {
    console.error('build-client: 产物不合法 —— ' + message);
    process.exit(1);
  }
}

const sha = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
const bytes = Buffer.byteLength(code, 'utf8');
const rel = path.relative(ROOT, OUT) || OUT;

if (CHECK_ONLY) {
  if (!fs.existsSync(OUT)) {
    console.error('build-client --check: 产物不存在 → ' + rel);
    process.exit(1);
  }
  const current = fs.readFileSync(OUT, 'utf8');
  if (current !== code) {
    console.error('build-client --check: 产物已过期 → ' + rel);
    console.error('  期望 sha256 ' + sha.slice(0, 12) + ' / ' + bytes + ' B');
    console.error('  修法：node scripts/build-client.mjs');
    process.exit(1);
  }
  console.log('build-client --check: 最新 ✅  ' + rel + '  sha256 ' + sha.slice(0, 12) + ' / ' + bytes + ' B');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, code, 'utf8');
console.log('build-client: ' + path.relative(ROOT, SRC) + ' → ' + rel);
console.log('  · ' + bytes + ' B  sha256 ' + sha.slice(0, 12));
if (removedMapRefs > 0) console.log('  · 摘掉 ' + removedMapRefs + ' 处悬空 sourceMappingURL 引用');