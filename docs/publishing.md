# 发布清单（awesome-dsh-plugin）

按 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) 整理。收录的是**仓库**，不是 npm 包；npm 只是可选项。

## 1. 仓库侧前置

- [ ] 仓库公开：`https://github.com/xiafan68/dsh-message-hub`（当前尚未创建）
- [ ] 创建满 1 天后再提 PR（列表要求仓库存在 ≥ 1 天）
- [ ] 给仓库加 topic：`dsh-plugin`（Settings → Topics）
- [ ] 默认分支 `main`，包含 `LICENSE`、`README.md`、`data/plugins/` 条目与 `assets/icon-180.png`

## 2. 已就位的材料

| 材料 | 位置 | 说明 |
| --- | --- | --- |
| 条目 YAML | `data/plugins/xiafan68__dsh-message-hub.yml` | 原样复制到 awesome 仓库 `data/plugins/` |
| 图标 | `assets/icon-180.png` | 180×180 PNG，GitHub raw 链接已在条目里 |
| 许可证 | `LICENSE` | MIT |
| 元数据 | `package.json` | `dsh.bundle`、`repository`、`author`、`bugs`、`homepage`、预发布 peer 范围 |
| 机械校验 | `tests/submission_selftest.mjs` | `npm test` 会跑，18 项断言 |
| PR 文案 | 本文件第 4 节 | 直接粘到 PR 描述 |

条目里的图标地址：

```
https://raw.githubusercontent.com/xiafan68/dsh-message-hub/main/assets/icon-180.png
```

## 3. 推仓库

```powershell
cd D:\codes\dsh-message-hub
git remote add origin git@github.com:xiafan68/dsh-message-hub.git
git push -u origin main
```

仓库还没建时先在 https://github.com/new 建空仓库（不要初始化 README / .gitignore / LICENSE）。

## 4. PR 文案

标题：

```
Add xiafan68/dsh-message-hub
```

描述：

```markdown
### 插件

- 仓库：https://github.com/xiafan68/dsh-message-hub
- 分类：notify（订阅 / 推送）
- 安装方式：bundle（`dsh.bundle.patch` → `cordis.patch.yml`），带 web 面板

### 做什么

把 RSS、网页和 GitHub Releases 订阅收进一个三栏面板，同时以 `hub_*` 工具交给模型；插件内置 Python 采集引擎，首次启动自动建 venv 并拉起服务，之后定时采集。

### 自查

- [x] 仓库声明 `dsh.bundle`（不是只有 `dsh.client`）
- [x] `npm run check` 全绿（含 `tests/submission_selftest.mjs`）
- [x] 条目字段与文件名符合 `data/plugins/<owner>__<repo>.yml`
- [x] 描述只写功能，无营销词
- [x] 仓库已加 `dsh-plugin` topic
- [ ] 仓库创建满 1 天（提交前确认）
```

## 5. 提交 PR

```powershell
# fork 后 clone（或直接在 GitHub 网页操作）
git clone git@github.com:<your-account>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b add-dsh-message-hub
Copy-Item D:\codes\dsh-message-hub\data\plugins\xiafan68__dsh-message-hub.yml data\plugins\
git add data/plugins/xiafan68__dsh-message-hub.yml
git commit -m "Add xiafan68/dsh-message-hub"
git push origin add-dsh-message-hub
```

一个 PR 只加一个文件；README 由维护脚本生成，不要手改。

## 6. 可选增强（不急）

- `screenshots.json`（1–8 张相对路径）能显著提升列表页展示；截面板图后放到 `assets/`，路径不能以 `/` 开头、不能含 `..`
- GitHub Release + `tarball: https://github.com/xiafan68/dsh-message-hub/releases/download/v0.3.0/dsh-message-hub-0.3.0.tgz`（用钉死 tag 的地址，别用 `latest/download` 配带版本文件名）
- npm 发布（`repository` 已回指本仓库，满足 npm 页面回链要求）