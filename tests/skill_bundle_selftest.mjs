/**
 * skill_bundle_selftest.mjs —— 随包 skill（skills/message-hub）的离线自检。
 *
 * 断言四件事：
 *   1. SKILL.md 存在，frontmatter 合法，name 与目录同名；
 *   2. 正文提到的工具都真实存在（工具改名时这条会先炸，而不是等模型用错）；
 *   3. provider 的 list/get 是 async 且形状符合宿主要求；
 *   4. 没有 skills 服务时注册只告警，不影响插件启动；有服务时确实注册了一次。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const skills = await import('../src/skills.mjs');

let checks = 0;
function ok(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`skill_bundle_selftest 失败：${name}`);
    throw err;
  }
  checks += 1;
}

const skillFile = path.join(skills.BUNDLED_SKILL_DIR, 'SKILL.md');
ok('SKILL.md 存在', () => assert.ok(fs.existsSync(skillFile)));

const skill = skills.readBundledSkill();
ok('frontmatter 可解析', () => assert.ok(skill));
ok('name 是 kebab-case', () => assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/));
ok('name 与目录同名', () => assert.equal(skill.name, path.basename(skills.BUNDLED_SKILL_DIR)));
ok('description 足够具体', () => assert.ok(skill.description.length > 40));

// 工具地图不能写成"想象中的工具"：正文提到的每个 hub_* 都必须真实注册
const toolNames = (() => {
  const source = fs.readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
  return new Set([...source.matchAll(/name: '(hub_[a-z_]+)'/g)].map((m) => m[1]));
})();
ok('工具表非空', () => assert.ok(toolNames.size >= 10));

// 注意负向断言：`github_releases` 里也含 "hub_" 子串，不能算工具名
const mentioned = new Set([...skill.content.matchAll(/(?<![A-Za-z0-9_-])hub_([a-z_]+)/g)].map((m) => `hub_${m[1]}`));
ok('正文至少提到 6 个工具', () => assert.ok(mentioned.size >= 6));
ok('正文只引用真实工具', () => {
  const unknown = [...mentioned].filter((name) => !toolNames.has(name));
  assert.deepEqual(unknown, [], `SKILL.md 引用了不存在的工具：${unknown.join(', ')}`);
});
ok('关键流程都在', () => {
  for (const word of ['hub_status', 'hub_feeds', 'hub_items', 'hub_digest', 'hub_feed_add', 'hub_selection']) {
    assert.ok(mentioned.has(word), `缺少流程：${word}`);
  }
});

// ---- provider 形状 ---------------------------------------------------------
const provider = skills.createBundledSkillProvider();
ok('provider 可创建', () => assert.ok(provider));
ok('provider 名字稳定', () => assert.equal(provider.name, 'dsh-message-hub'));
ok('rank = 600', () => assert.equal(skills.BUNDLED_SKILL_RANK, 600));

const listed = await provider.list();
ok('list 返回 1 条', () => assert.equal(listed.length, 1));
ok('candidate 有必需字段', () => {
  const candidate = listed[0];
  assert.equal(candidate.source, 'bundled');
  assert.equal(candidate.provider, 'dsh-message-hub');
  assert.equal(candidate.rank, 600);
  assert.equal(candidate.invocation.modelInvocable, true);
  assert.equal(candidate.resourceBase.kind, 'directory');
});

const got = await provider.get();
ok('get 带正文', () => {
  assert.ok(got.content.includes('# Message Hub'));
  assert.ok(got.content.length > 1000, '正文太短，检查是否只写了标题');
});

// ---- 注册：没有 skills 服务时不许炸 ----------------------------------------
{
  const logs = [];
  const result = skills.registerBundledSkill({}, (line) => logs.push(line));
  ok('无 skills 服务时返回 false', () => assert.equal(result, false));
}

// 有服务时：ctx.inject 的回调里能拿到 skills，就注册一次
{
  let registered = 0;
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['skills']);
      callback({ skills: { registerProvider: (factory) => { registered += 1; factory(); } } });
    },
  };
  const result = skills.registerBundledSkill(ctx, () => {});
  ok('挂载成功返回 true', () => assert.equal(result, true));
  ok('registerProvider 注册一次', () => assert.equal(registered, 1));
}

// 直接挂在 ctx.skills 上的宿主（没有 inject）也要能工作
{
  let registered = 0;
  const ctx = { skills: { registerProvider: () => { registered += 1; } } };
  skills.registerBundledSkill(ctx, () => {});
  ok('ctx.skills 直挂可用', () => assert.equal(registered, 1));
}

// frontmatter 解析的边界
{
  const parsed = skills.parseSkillFrontmatter('no frontmatter');
  ok('没有 frontmatter 时 body 原样返回', () => assert.equal(parsed.body, 'no frontmatter'));
  const quoted = skills.parseSkillFrontmatter('---\nname: "x-y"\ndescription: a\n  b\n---\nbody');
  ok('引号与续行都处理', () => {
    assert.equal(quoted.meta.name, 'x-y');
    assert.equal(quoted.meta.description, 'a b');
    assert.equal(quoted.body, 'body');
  });
}

console.log(`skill_bundle_selftest: ${checks} 项断言全部通过`);