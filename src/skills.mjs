/**
 * skills.mjs —— 随包 skill（`skills/message-hub/`）的注册。
 *
 * 为什么把它放在插件里，而不是另发一个 skill 包：用户装的是插件，读的是面板；
 * 让他再去单独安装/软链一份"怎么用"的文档，实际没人会做。skill 随包走，
 * 装插件即出现在技能目录里，模型就能在需要时自己加载。
 *
 * 只依赖宿主的一条稳定接口 `ctx.skills.registerProvider`（与 `ctx.inject(['skills'])`），
 * 不 import 宿主的 dsh-skill 包。没有 skills 服务时整个逻辑静默跳过，绝不影响 10 个工具。
 *
 * rank = 600 与宿主内置 skill 同值：DSH 规则是 rank 小者优先，所以用户自己放在
 * ~/.dsh/skills（400）的副本仍然覆盖包内版本 —— 想改写的人不会被包内版本压住。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLED_SKILL_PROVIDER = 'dsh-message-hub';
export const BUNDLED_SKILL_RANK = 600;
export const BUNDLED_SKILL_DIR = fileURLToPath(new URL('../skills/message-hub/', import.meta.url));

/** 解析 SKILL.md 的 YAML frontmatter（只取 name/description，不引 yaml 依赖）。 */
export function parseSkillFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  let key = '';
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      let value = kv[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
      continue;
    }
    // 缩进的续行并进上一个 key（frontmatter 里写长 description 时会用到）
    if (key && /^\s+\S/.test(line)) meta[key] = (meta[key] ? `${meta[key]} ` : '') + line.trim();
  }
  return { meta, body: raw.slice(match[0].length) };
}

let cached;
export function readBundledSkill() {
  if (cached !== undefined) return cached;
  try {
    const file = path.join(BUNDLED_SKILL_DIR, 'SKILL.md');
    const { meta, body } = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
    const name = String(meta.name || '').trim();
    const description = String(meta.description || '').trim();
    // name 会被模型当作 skill 名传回来：只接受 kebab-case，且必须与目录同名
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !description) {
      cached = null;
      return null;
    }
    cached = { name, description, content: body, file };
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

/** 组装一个 bundled provider：list / get 必须是 async（宿主 lookup 会直接 .then）。 */
export function createBundledSkillProvider() {
  const skill = readBundledSkill();
  if (!skill) return null;
  const resourceBase = { kind: 'directory', path: BUNDLED_SKILL_DIR.split(path.sep).join('/') };
  const common = {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: BUNDLED_SKILL_PROVIDER,
    resourceBase,
    path: skill.file,
    locator: skill.file,
  };
  return {
    name: BUNDLED_SKILL_PROVIDER,
    list: async () => [{ ...common, rank: BUNDLED_SKILL_RANK }],
    get: async () => ({ ...common, rank: BUNDLED_SKILL_RANK, content: skill.content }),
  };
}

/**
 * 把随包 skill 挂到宿主的 skills 注册表。
 *
 * 用 `ctx.inject(['skills'], cb)` 延迟到服务可用时再注册：宿主没有 skills 服务时这个子 fiber
 * 一直待命，插件本身照常启动。返回是否真的挂上了，方便自检与排障。
 */
export function registerBundledSkill(ctx, log = () => {}) {
  const provider = createBundledSkillProvider();
  if (!provider) {
    log('随包 skill 未注册：skills/message-hub/SKILL.md 缺失或 frontmatter 不合法（不影响工具面）');
    return false;
  }

  let mounted = false;
  const mount = (scope) => {
    try {
      if (!scope || !scope.skills || typeof scope.skills.registerProvider !== 'function') return;
      scope.skills.registerProvider(() => provider);
      mounted = true;
    } catch (err) {
      log(`随包 skill 注册失败：${err && err.message ? err.message : err}（不影响工具面）`);
    }
  };

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['skills'], mount);
    } else if (ctx.skills && typeof ctx.skills.registerProvider === 'function') {
      mount(ctx);
    }
  } catch (err) {
    log(`随包 skill 挂载失败：${err && err.message ? err.message : err}（不影响工具面）`);
  }

  return mounted || typeof ctx.inject === 'function';
}