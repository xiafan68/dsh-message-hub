/**
 * submission_selftest.mjs —— 投稿前：仓库能不能被装、条目能不能过 CI。
 *
 * 这些字段不进运行时；但漏了或写歪了，结果是「别人装不上」或「PR 被 CI 打回再改一轮」。
 * 规则来源：awesome-dsh-plugin/contributing.md
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let checks = 0;
function ok(name, fn) { fn(); checks += 1; void name; }

const root = new URL('..', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const exists = (rel) => fs.existsSync(new URL(rel, root));

// 装进 node_modules 后再跑本测试（比如别人 clone 依赖后 npm test）应当跳过。
if (/[\\/]node_modules[\\/]/.test(fileURLToPath(root))) {
  console.log('submission_selftest: 跳过（跑在 node_modules 里，不是源码仓库）');
  process.exit(0);
}

const pkg = JSON.parse(read('package.json'));

const ALLOWED_CATEGORIES = new Set([
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl',
  'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev', 'security',
  'remote', 'market', 'fun',
]);

const MARKETING = [
  'best', 'ultimate', 'perfect', 'powerful', 'revolutionary', 'amazing', '#1', 'no.1',
  '最强', '最好', '唯一', '完美', '神器', '顶级', '秒杀', '颠覆',
];

const OVERCLAIMS = ['卸载插件', '卸载这些插件', 'uninstall the plugin', 'saves tokens', '减少 token', '降低 token'];

function parseEntry(text) {
  const values = {};
  const lines = text.split(/\r?\n/);
  let section = null;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const nested = /^ {2}([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (nested && section) { values[section][nested[1]] = unquote(nested[2], index + 1); return; }
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!top) return;
    if (top[2] === '') { values[top[1]] = {}; section = top[1]; return; }
    section = null;
    values[top[1]] = unquote(top[2], index + 1);
  });
  return { values, lines };
}

function unquote(value, lineNo) {
  const text = value.trim();
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    assert.ok(text.length >= 2 && text.endsWith(quote), `第 ${lineNo} 行引号没有闭合`);
    return text.slice(1, -1);
  }
  return text;
}

// ── 装得上：dsh.bundle 是「可安装」的唯一凭据 ──────────────────────────────
ok('package.json 声明 dsh.bundle', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(exists('cordis.patch.yml'), '声明了 patch 却没有这个文件');
});

ok('cordis.patch.yml 装配的正是本包', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /^- insert:/m);
  assert.ok(patch.includes(pkg.name), `patch 里的 name 与 ${pkg.name} 不一致，装上会静默不生效`);
});

ok('带浏览器 UI，client.platform 标为 web', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.ok(exists('lib/client.js'), '缺少已构建的浏览器产物，装完面板不会出现');
});

ok('有 LICENSE 文件，且与 package.json 的 license 一致', () => {
  assert.equal(pkg.license, 'MIT');
  const text = read('LICENSE');
  assert.match(text, /^MIT License/);
  assert.match(text, /Permission is hereby granted/);
});

ok('.gitignore 挡住本地排查产物与 ACL 备份', () => {
  const ignore = read('.gitignore');
  for (const pattern of ['node_modules/', '.tmp-*', '.acl-recovery/', '*.tgz']) {
    assert.ok(ignore.includes(pattern), `.gitignore 缺少 ${pattern}`);
  }
});

ok('README 讲清安装与许可证', () => {
  const text = read('README.md');
  assert.match(text, /^## 快速开始/m);
  assert.match(text, /^## 许可证/m);
});

// ── awesome-dsh-plugin 的条目 ─────────────────────────────────────────────
function entryFiles() {
  return fs.readdirSync(new URL('data/plugins/', root)).filter((name) => name.endsWith('.yml'));
}
const files = entryFiles();
ok('data/plugins/ 只有一条条目', () => {
  assert.equal(files.length, 1, '条目文件应当只有一个：' + files.join(', '));
});

const entryFile = files[0];
const { values: entry, lines: entryLines } = parseEntry(read('data/plugins/' + entryFile));
const [owner, repo] = String(entry.name ?? '').split('/');

ok('条目字段齐全：url、name、category、description.en', () => {
  assert.ok(entry.url, '缺少 url');
  assert.ok(owner && repo, 'name 必须是 owner/repo');
  assert.ok(ALLOWED_CATEGORIES.has(entry.category), `category 不在允许的取值里：${entry.category}`);
  assert.ok(entry.description?.en, 'description.en 是必填项');
});

ok('name、url 与仓库一一对应', () => {
  assert.equal(repo, pkg.name.replace(/^@[^/]+\//, ''), 'name 的仓库名与包名尾巴不一致');
  assert.equal(entry.url, `https://github.com/${owner}/${repo}`);
  assert.equal(entryFile, `${owner}__${repo}.yml`, `文件名应为 ${owner}__${repo}.yml`);
});

ok('package.json 的 repository / author 与条目对齐', () => {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  assert.ok(raw, 'package.json 缺少 repository');
  assert.equal(String(raw).replace(/^git\+/, '').replace(/\.git$/, ''), entry.url);
  assert.equal(pkg.author, owner);
});

ok('url 是 https 且指向仓库根', () => {
  assert.match(entry.url, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
});

ok('英文描述一句话、句号结尾、长度适中', () => {
  const text = entry.description.en;
  assert.match(text, /\.$/, '英文描述必须以 . 结尾');
  assert.ok(text.length >= 40, '太短，讲不清做什么');
  assert.ok(text.length <= 300, '太长，列表里放不下');
  assert.ok(!/\n/.test(text), '必须是一行');
});

ok('中文描述以中文句号结尾', () => {
  const text = entry.description?.zh;
  if (!text) return;
  assert.match(text, /[。.]$/);
  assert.ok(text.length >= 10);
});

ok('描述里出现 ": " 的必须加引号', () => {
  for (const [index, line] of entryLines.entries()) {
    const nested = /^ {2}(en|zh):\s*(.*)$/.exec(line);
    if (!nested) continue;
    const value = nested[2];
    const quoted = value.startsWith('"') || value.startsWith("'");
    const colonSpace = /:\s/.test(value.slice(0, -1));
    assert.ok(!(colonSpace && !quoted), `第 ${index + 1} 行含 ": " 却没有加引号`);
  }
});

ok('描述不带营销词', () => {
  const text = `${entry.description.en} ${entry.description.zh ?? ''}`.toLowerCase();
  for (const word of MARKETING) {
    assert.ok(!text.includes(word.toLowerCase()), `去掉营销词：${word}`);
  }
});

ok('描述与实现一致，不写还原不了的承诺', () => {
  const text = `${entry.description.en} ${entry.description.zh ?? ''}`.toLowerCase();
  for (const claim of OVERCLAIMS) {
    assert.ok(!text.includes(claim.toLowerCase()), `与实现不符的说法：${claim}`);
  }
});

ok('条目与 package.json 无 UTF-8 BOM', () => {
  for (const rel of ['package.json', 'data/plugins/' + entryFile]) {
    const bytes = fs.readFileSync(new URL(rel, root));
    assert.notEqual(bytes[0], 0xef, `${rel} 带 BOM`);
  }
});

ok('screenshots.json（若已声明）路径合法且文件真实存在', () => {
  if (!exists('screenshots.json')) return;
  const declared = JSON.parse(read('screenshots.json'));
  const list = Array.isArray(declared) ? declared : declared.screenshots;
  assert.ok(Array.isArray(list), '需要数组，或 { "screenshots": [...] }');
  assert.ok(list.length >= 1 && list.length <= 8, '1–8 张');
  for (const src of list) {
    assert.equal(typeof src, 'string');
    assert.ok(!src.startsWith('/'), `相对路径不能以 / 开头：${src}`);
    assert.ok(!src.split('/').includes('..'), `不能跳出插件目录：${src}`);
    assert.ok(exists(src), `截图不存在：${src}`);
  }
});

console.log(`submission_selftest: ${checks} 项断言全部通过`);