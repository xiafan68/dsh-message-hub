/**
 * client_bundle_selftest.mjs —— 浏览器半边的离线自检。
 *
 * 用假的 `__ModuleLoader__` 执行 `lib/client.js`：验证它自注册、只导出 apply/inject、
 * 槽位 id 一致、zh/en 无缺翻译、引用文本与草稿写入的纯函数正确。
 * 像素与交互仍要回到 DSH 里看，这里只拦"结构性错误"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BUNDLE = path.join(ROOT, 'lib', 'client.js');

assert.ok(fs.existsSync(BUNDLE), 'lib/client.js 不存在：先跑 node scripts/build-client.mjs');
const code = fs.readFileSync(BUNDLE, 'utf8');

let registered = null;
const fakeWindow = { __ModuleLoader__: { load: (mod) => { registered = mod; } } };
// 只把 window 作为形参注入，避免污染全局
new Function('window', code)(fakeWindow);

assert.ok(registered, 'bundle 必须调用 window.__ModuleLoader__.load');
assert.equal(registered.id, '@dsh-external/dsh-message-hub');

const fakeReact = {
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};
const fakeJsx = { jsx: () => null, jsxs: () => null, Fragment: 'fragment' };
const mod = registered.factory((name) => {
  if (name === 'react') return fakeReact;
  if (name === 'react/jsx-runtime') return fakeJsx;
  throw new Error(`意外的模块请求：${name}`);
});

let checks = 0;

// ---- 导出面 ---------------------------------------------------------------
assert.equal(typeof mod.apply, 'function');
assert.ok(Array.isArray(mod.inject));
assert.ok(mod.inject.includes('slots'));
assert.ok(mod.inject.includes('locale'));
assert.equal(mod.PANEL_ID, 'message-hub');
checks += 5;

const selftest = mod.__selftest;
assert.ok(selftest, '必须暴露 __selftest 纯函数接缝');
assert.equal(selftest.PANEL_ID, mod.PANEL_ID, '侧栏 id 与主面板 key 必须一致');
assert.equal(selftest.API_PREFIX, '/message-hub/api', '前后端前缀必须一致');
checks += 3;

// ---- 文案完整性 -----------------------------------------------------------
const zhKeys = Object.keys(selftest.zh).sort();
const enKeys = Object.keys(selftest.en).sort();
const missingEn = zhKeys.filter((key) => !(key in selftest.en));
const missingZh = enKeys.filter((key) => !(key in selftest.zh));
assert.deepEqual(missingEn, [], 'en 缺词条：' + missingEn.join(','));
assert.deepEqual(missingZh, [], 'zh 缺词条：' + missingZh.join(','));
assert.ok(zhKeys.length >= 40, '词条数量看起来不对：' + zhKeys.length);
checks += 3;

// ---- 纯函数 ---------------------------------------------------------------
assert.equal(selftest.fill('第 {page} / {pages} 页', { page: 2, pages: 5 }), '第 2 / 5 页');
assert.equal(selftest.fill('x {missing} y', {}), 'x {missing} y');
assert.equal(selftest.intFmt(2559), (2559).toLocaleString());
assert.equal(selftest.intFmt('abc'), '—');
checks += 4;

assert.equal(selftest.oneLine('<p>hello\n\n  world</p>', 100), 'hello world');
assert.ok(selftest.oneLine('a'.repeat(50), 10).endsWith('…'));
checks += 2;

const now = Date.parse('2026-11-13T22:00:00+08:00');
assert.equal(selftest.relTime('2026-11-13T21:59:30+08:00', now), '刚刚');
assert.equal(selftest.relTime('2026-11-13T21:30:00+08:00', now), '30 分钟前');
assert.equal(selftest.relTime('2026-11-13T18:00:00+08:00', now), '4 小时前');
assert.equal(selftest.relTime('2026-11-10T22:00:00+08:00', now), '3 天前');
assert.equal(selftest.relTime('', now), '—');
checks += 5;

assert.equal(selftest.typeLabel('rss', (k) => k), 'typeRss');
assert.equal(selftest.typeLabel('github_releases', (k) => k), 'typeGithub');
assert.equal(selftest.typeLabel('web_page', (k) => k), 'typeWeb');
checks += 3;

// ---- 精选条目 → 选中态（必须落在 selection 白名单字段上） -------------------
const digestSelection = selftest.digestItemSelection({
  id: 9, source_item_id: 880004, title: '模型发布', source_name: 'Anthropic',
  url: 'https://x/9', rationale: '与「AI Agent 工程化」吻合', summary: '正文摘要',
}, { period_start: '2026-11-12' });
assert.equal(digestSelection.kind, 'item');
assert.equal(digestSelection.id, '880004', '优先用原始条目 id，模型才能回查');
assert.equal(digestSelection.source_name, 'Anthropic');
assert.equal(digestSelection.created_at, '2026-11-12');
assert.ok(digestSelection.summary.includes('入选理由'));
assert.deepEqual(Object.keys(digestSelection).sort(), [
  'created_at', 'id', 'kind', 'liked', 'source_name', 'summary', 'title', 'url',
], '字段集合必须与 normaliseSelection 白名单一致');
checks += 6;

assert.equal(selftest.kindLabel('weekly', (k) => k), 'digestKindWeekly');
assert.equal(selftest.kindLabel('daily', (k) => k), 'digestKindDaily');
checks += 2;

// ---- 引用文本 -------------------------------------------------------------
const itemRef = selftest.referenceFor({
  kind: 'item', id: '7', title: 'Hello', source_name: 'GitHub Blog',
  created_at: '2026-11-13T21:00:00+08:00', url: 'https://x/y', summary: 'world',
});
assert.ok(itemRef.includes('【消息订阅】Hello'));
assert.ok(itemRef.includes('来源：GitHub Blog'));
assert.ok(itemRef.includes('链接：https://x/y'));
assert.ok(itemRef.includes('world'));
checks += 4;

const sourceRef = selftest.referenceFor({ kind: 'source', id: 'github-blog', title: 'GitHub Blog', url: 'https://github.blog/feed/' });
assert.ok(sourceRef.includes('【消息订阅 · 订阅源】GitHub Blog'));
checks += 1;

assert.equal(selftest.referenceFor(null), '');
checks += 1;

// ---- 草稿写入的三个分支 ----------------------------------------------------
let written = selftest.insertToComposer('x');
assert.equal(written.ok, false);
assert.equal(written.reason, 'no-session');
checks += 2;

const inserted = [];
selftest.chatBridge.current = {
  sessionId: 'sess-1',
  actions: {
    captureInsertion: () => ({ from: 1, to: 2 }),
    insertText: (text, span) => { inserted.push([text, span]); return true; },
  },
  notify: null,
};
written = selftest.insertToComposer('hello');
assert.equal(written.ok, true);
assert.deepEqual(inserted[0], ['hello', { from: 1, to: 2 }]);
checks += 2;

// 草稿锁定：insertText 返回 false → rejected，并带上 hasBridge 让界面提示"稍后重试"
let attempts = 0;
selftest.chatBridge.current = {
  sessionId: 'sess-1',
  actions: { captureInsertion: () => undefined, insertText: () => { attempts += 1; return false; } },
  notify: null,
};
written = selftest.insertToComposer('hello');
assert.equal(written.ok, false);
assert.equal(written.reason, 'rejected');
assert.equal(written.hasBridge, true);
assert.equal(attempts, 2, '应该重试一次');
checks += 4;

// 抛异常也要被吞掉并转为 rejected（草稿正在切换的常见形态）
selftest.chatBridge.current = {
  sessionId: 'sess-1',
  actions: { captureInsertion: () => { throw new Error('race'); }, insertText: () => true },
  notify: null,
};
written = selftest.insertToComposer('hello');
assert.equal(written.ok, false);
assert.equal(written.reason, 'rejected');
checks += 2;

// ---- 槽位常量 -------------------------------------------------------------
assert.ok(code.includes('"sidebar.panellist"'));
assert.ok(code.includes('"conversation.input.dock"'));
assert.ok(code.includes('"main"'));
checks += 3;

// ---- 源管理按钮（暂停 / 删除确认） ------------------------------------------
assert.ok(code.includes('confirmDeleteFeed'), '缺少删除确认文案');
assert.ok(code.includes('feedDeleted'), '缺少删除完成提示');
assert.ok(code.includes('feedPaused'), '缺少暂停提示');
checks += 3;

console.log(`client_bundle_selftest: ${checks} 项断言全部通过`);