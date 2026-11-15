# Message Hub

**把 RSS、网页与 GitHub Releases 订阅，接进你的对话。**

Message Hub 是一个本地消息订阅中心：侧边栏一个入口，打开是「订阅源 · 条目流 · 详情」三栏。
面板里看到的每条消息都能一键写进对话草稿；模型的 `hub_selection` 也能读到你此刻选中了什么；
加源、暂停、立刻采集、改关注方向，都可以在对话里用一句话完成。

它自带采集引擎：`service/` 里的 Python 引擎负责抓取、去重、SSRF 防护与 SQLite 存储，
面板点「启动服务」时由插件拉起 —— 不需要另一个 checkout，也不需要你自己装 Python 和后端依赖。
插件还随包带一份 `message-hub` skill：装完插件，模型就知道这套工具该怎么组合用。

`Node ≥ 20` · `插件零运行时依赖` · `首次启动自动装引擎依赖` · `MIT`

---

## 它解决什么

订阅列表和对话原本是两套东西。功能都在，代价全在切换：

| 症状 | 代价 |
|---|---|
| 看到一条值得聊的消息，要手动复制标题/链接再贴进对话 | 上下文丢一半，还得说清是哪个源 |
| 想加一个 RSS，得切到管理台填表单 | 对话里说一句的事，变成两处操作 |
| 模型不知道你此刻在看什么 | 「这条能展开讲讲吗」→ 得先花一轮把内容贴给它 |

接进对话之后，这三件事变成：

1. **选中条目 → 写进对话草稿**：不自动发送，写进去后你补一句问题即可；没有可写入的会话时退回剪贴板，不会静默失败。
2. **选中即上报**：面板把「你在看什么」上报给宿主（按会话隔离），模型用 `hub_selection` 直接读到标题、来源、链接与摘要。
3. **对话内管理订阅**：`hub_feed_add` / `hub_feed_control` 直接增删启停，不必离开对话。

## 工作方式

```
浏览器（面板）
   │  只认 /message-hub/api（同源，连接层已鉴权）
   ▼
宿主半边（Node）              ← hub_* 工具（模型侧）
   │  HTTP + 可选 Bearer
   ▼
内置引擎（Python 子进程）      采集 · 去重 · SSRF 防护 · SQLite
   ▲
   └── venv + 依赖：<runtimeDir>/pyenv（首次启动自动准备）
```

分工只有三条：

- **浏览器**只说 `/message-hub/api`，不直连引擎：写接口可能要 Bearer Token，token 不该进浏览器；
  引擎与 GUI 不同源，还要处理 CORS。宿主已经鉴权过连接层，边界单一。
- **宿主半边**做代理、选中态与工具注册。它不读 SQLite、不抓网页 —— 引擎才持有采集语义。
- **引擎**决定数据。本项目只把 `--database <dataDir>/subscriptions.db` 与
  `--config service/config/subscriptions.yaml` 传给它，让「数据放哪」由本项目的配置说了算。

## 内置引擎

`service/` 是从 `message-subscriptions` 原样搬进来的 Python 引擎（FastAPI + httpx + bs4 +
PyYAML，约 1.8k 行），**不是本项目的业务代码**：升级引擎 = 用上游新版本覆盖它，
`service/README.md` 里有边界说明。

### 点「启动服务」之后发生了什么

1. **探活**：引擎已经在答话就直接返回，不会再 spawn 一个（否则只会得到端口冲突的日志）。
2. **建数据目录**：SQLite 只建文件不建目录，少了这一步引擎会以
   `unable to open database file` 退出。
3. **找 Python**：`config.pythonPath` → **DSH 自带的 Python 3.12**（`resources/runtime/.../python`）
   → PATH 上的 `python3` / `python`。每个候选都真跑一次版本探测，需要 ≥ 3.11。
4. **准备 venv**：在 `<runtimeDir>/pyenv` 建 venv，按 `service/requirements.txt` 装依赖。
   requirements 的哈希写在 `.dsh-deps.json` 里：内容没变就不重装。
5. **拉起进程**：`venv/python -m message_subscriptions.server --host --port --database --config`，
   detached 启动，stdout/stderr 落到 `<runtimeDir>/service.log`。
6. **等健康检查**：30 秒内 `/api/v1/health` 能答话才回 ok。

首次启动要联网从 PyPI 装五个直接依赖（约几十秒到两分钟），之后每次都是秒起。
同一个 starter 上并发调用共享同一个 in-flight Promise：连点两次「启动服务」不会起两个进程。

### 首次启动的前置

- **Python 3.11+**：DSH 桌面端自带，通常不用管；从源码跑 DSH 或精简安装时可能需要自己装，
  或用 `config.pythonPath` 指定。
- **首次能访问 PyPI**：装依赖用。离线机器可以预先准备 venv，或把 `installDeps` 设为 `false`
  后手动执行 `service/requirements.txt` 的安装（见排障）。
- **`service/` 完整**：入口 `service/message_subscriptions/server.py` 在就行。

## 快速开始

### 0. 前置条件

- **DeepSeek Harness（DSH）**，web 平台。宿主提供 `webServer` 才有面板与 HTTP 路由；
  提供 `tools` 才有 `hub_*` 工具。缺任一半都能挂载，只是少一半能力（日志会说明缺的是哪个）。
- **Node ≥ 20**（DSH 自带）。

### 1. 安装到 DSH profile

`~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": {
    "@dsh-external/dsh-message-hub": "link:/path/to/dsh-message-hub"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-external/dsh-message-hub"
      ]
    }
  }
}
```

发布到 registry 后把 `link:` 换成版本号即可；本地开发用 `link:` 指向 checkout。

```bash
cd ~/.dsh/profiles/<profile> && pnpm install
```

然后**重启 DSH**：bundle 变更不会热生效；`link:` 改源码后同样重启。

> ⚠️ 装配方式只能选一种：`bundles` 或注入器。两个同时开 = 两个 fiber 重复注册同名工具与面板。

### 2. 配置（可选）

bundle 自带一份默认配置（`cordis.patch.yml`），开箱即用。要改就在 profile 的
`cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-message-hub
  config:
    apiBase: 'http://127.0.0.1:4001'   # 引擎监听地址
    serviceDir: ''                     # 留空 = 本包自带的 service/
    runtimeDir: ''                     # 留空 = ~/.dsh/message-hub/runtime
    dataDir: ''                        # 留空 = ~/.dsh/message-hub/data
    pythonPath: ''                     # 留空 = 宿主自带 Python → PATH
    installDeps: true                  # 首次启动用 pip 装引擎依赖
    autoStart: true                    # 「启动服务」按钮是否可用
    defaultLimit: 50                   # 面板一屏条目数（1..100）
    collectIntervalMinutes: 360        # 后台自动采集间隔（分钟），0 = 关闭
    token: ''                          # 引擎要求鉴权时才需要
    tokenFile: '~/.config/message-subscriptions/api-token'
```

### 3. 启动引擎

面板显示灰点「本机订阅引擎没在跑」时点「启动服务」；或在对话里说「把订阅服务拉起来」
（`hub_service_start`）。首次会装依赖，按钮上会说明。

也可以手动跑（此时面板与工具照样能用）：

```bash
<runtimeDir>/pyenv/Scripts/python.exe -m message_subscriptions.server \
  --host 127.0.0.1 --port 4001 \
  --database <dataDir>/subscriptions.db \
  --config service/config/subscriptions.yaml
```

（`service/` 必须在 cwd，模块才在 `sys.path` 上；Windows 的 venv 在 `Scripts/`，POSIX 在 `bin/`。）

### 4. 验收

- 侧栏出现「消息订阅」入口，点开是三栏面板；
- 面板首屏有绿点、订阅源列表与条目（否则是灰点 + 启动按钮）；
- 对话里问「订阅在跑吗」，`hub_status` 返回服务状态、源数量、条目数与最近采集；
- 面板里选一条，再问「这条讲了什么」，模型能通过 `hub_selection` 答上来。

## 面板

### 条目流（默认）

左侧是订阅源（点一下按来源过滤），中间是条目流，右侧是详情。源列表列头的「全部采集」一次性跑所有**启用**的源。

- **搜索**：关键词命中标题/摘要，防抖 260ms；**只看收藏**；分页；刷新。
- **收藏**：详情里直接收藏/取消收藏（收藏的条目不会被上游的两周清理带走）。
- **删除条目**：右侧详情里删单条；左侧每行有勾选框，可全选当前页后点「删除选中（n）」。两处都要点两次确认；
  删除是物理删除（连带清掉投递记录），删了就没了。
- **立刻采集**：选中一个源后，右侧详情里触发单源采集，会真的发网络请求，可能耗时十几秒。
- **暂停 / 恢复 / 删除**：同样在右侧详情：暂停的源不再参与「全部采集」，也不会被自动采集；删除是软删，
  按钮要点两次（第二次变「确认删除」）才真的执行。
- **全部采集**：源列表列头的按钮，对所有启用的源并发 2 逐个跑（暂停的源跳过）；按钮实时显示
  `采集中 3/8`，跑完汇总新增条数或成功/失败数，单个源失败不会中断整批。
- **引用到对话**：把标题、来源、链接、摘要以引用块插进当前会话草稿，模型能看出这是外部材料；不自动发送。
- **写进对话草稿**：同一段引用以纯文本写进当前会话草稿；不自动发送。
- **新建对话**：页头随时可开一个空白对话；在条目或精选详情里点「新建对话」，会新开一个会话并把这段引用
  写进它的草稿（同样不发送）。
- **草稿写进哪个对话**：写进你现在打开的那个会话。想写到新会话里，先用「新建对话」——
  详情区的「新建对话」会连引用一起带过去；页头的新建只开空白对话。
- **复制引用**：没有可写入的会话时的手动出口。

### 每日精选

引擎里已经生成好的 `curation_collections`（daily 日报 / weekly 周报）。左列各期，点开看入选条目、
**入选理由**与原文链接；每条都能「引用到对话」「写进对话草稿」或「新建对话」把这一条带进新会话，
整期也能一键引用/写草稿或「新建对话」。引用时会把 `rationale` 一起带上，所以模型拿到的不是裸标题，
而是「为什么这条值得看」。

> 精选是只读的：它由引擎之外的精选脚本生成；面板不生成、不改写。新装环境里这一栏会是空的，
> 直到你往库里写入精选（或从旧库复制 `curation_collections` / `curated_items`）。

### 关注偏好

`preferences.directions` 的编辑器：chips 列表，可增删，保存时整份 `PUT`。这些方向是每日精选的
取舍口径 —— 改了它，下一期精选的挑选标准才会变。界面区分「已保存 / 有未保存的改动」，
保存后以服务端回传的归一化结果为准。

## 对话侧

`hub_*` 工具只在宿主提供 `tools` 时注册。每个工具返回**可读摘要**而不是原始 JSON：
条目列表动辄几千行，塞进上下文只会挤爆窗口。

| 工具 | 作用 | 写 |
|---|---|---|
| `hub_status` | 服务是否在线、源数量、条目总数、最近采集 | |
| `hub_service_start` | 拉起内置引擎（首次含装依赖），等健康检查 | ✓ |
| `hub_feeds` | 列订阅源（状态/条目数/上次采集），支持 q/status 过滤 | |
| `hub_feed_add` | 新增源：参数 `kind` 取 `rss`（url）/ `github_releases`（owner/name）/ `web_page`（完整 config） | ✓ |
| `hub_feed_control` | `enable` / `disable` / `delete` / `run` | ✓ |
| `hub_items` | 条目流（关键词/来源/日期/收藏/分页） | |
| `hub_item` | 单条详情；`action=like/unlike` 收藏、`delete` 删除 | ✓ |
| `hub_selection` | **用户此刻在面板里选中的条目或源** | |
| `hub_digest` | 每日/每周精选：不传 id 列各期，传 `collection_id` 展开条目与理由 | |
| `hub_preferences` | 关注方向：`list` / `add` / `remove` / `set` | ✓ |

对话里可以这样说：

- 「帮我订 Anthropic 的新闻 RSS」→ `hub_feed_add`
- 「我订了哪些源？哪个挂了」→ `hub_feeds`
- 「这条能展开讲讲吗」（面板里正选着）→ `hub_selection` 拿到标题/链接/摘要
- 「把这个源先暂停」→ `hub_feed_control(action="disable")`
- 「最近一期的每日精选讲了什么」→ `hub_digest`（再带 id 展开）
- 「我最近更关注 AI Agent 工程化」→ `hub_preferences(action="add")`

## 随包 Skill

插件带一份给 agent 看的操作指南：`skills/message-hub/SKILL.md`，随插件自动注册进宿主的
skills 注册表（没有 skills 服务时静默跳过，不影响工具）。

它不重复工具文档，只补三样工具描述给不了的东西：

1. **流程**：先 `hub_status` 探活 → `hub_feeds` 看源 → `hub_items` 收窄 → `hub_item` 展开；
   加源后不要假装采集，先问要不要 `run`。
2. **边界**：精选只读、`hub_item` 只查最近 100 条、`web_page` 不能一句话加、
   选中是 6 小时过期的快照。
3. **失败处置**：`service-down` → `hub_service_start`；401/403 → token；空结果 ≠ 服务坏了；
   找不到条目就用日期区间重查，不要编。

注册方式是 Provider（`rank = 600`），所以你自己放在 `~/.dsh/skills` 的同名 skill 仍然优先；
想改写行为，写一份自己的 `message-hub` 覆盖即可，不用改插件。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `apiBase` | `http://127.0.0.1:4001` | 引擎监听地址（BFF 与工具都连这里） |
| `serviceDir` | `''` → 本包 `service/` | 引擎代码目录；指向别处可复用已有 checkout |
| `runtimeDir` | `''` → `~/.dsh/message-hub/runtime` | venv、安装日志、`service.log` |
| `dataDir` | `''` → `~/.dsh/message-hub/data` | `subscriptions.db` 的落点 |
| `pythonPath` | `''` | 指定解释器；留空按 宿主自带 → PATH 找 |
| `installDeps` | `true` | 首次启动用 pip 装依赖；关掉则要求 venv 已备好 |
| `autoStart` | `true` | 是否允许「启动服务」/ `hub_service_start` |
| `token` | `''` | 引擎要求鉴权时的 Bearer；优先于其它来源 |
| `tokenFile` | `~/.config/message-subscriptions/api-token` | token 文件，读取后 trim |
| `defaultLimit` | `50` | 面板一屏条目数，1..100 |
| `collectIntervalMinutes` | `360` | 后台自动采集所有启用源的间隔（分钟）；`0` 关闭 |

**token 解析顺序**：`config.token` → 环境变量 `DSH_MESSAGE_HUB_TOKEN` → token 文件。
内置引擎默认 `write_protection: false`，本地单机通常不需要 token。

**自动采集**：引擎自身没有调度器，不主动跑的话条目只会在有人点「采集」时才更新。插件默认
每 6 小时在后台把启用源跑一轮（并发 2），并在进程启动 2 分钟后先补一轮；面板的「全部采集」
与 `POST /message-hub/api/feeds/run-all` 跟它共用同一份逻辑。想彻底手动就把
`collectIntervalMinutes` 设为 `0`。

**环境变量**：`DSH_MESSAGE_HUB_DATA`、`DSH_MESSAGE_HUB_RUNTIME`、`DSH_MESSAGE_HUB_SERVICE`
在对应配置留空时生效；`apiBase` / `pythonPath` / `installDeps` 请直接改配置键。

配置校验是手写的 Standard Schema：类型不对会返回 issue（例如 `defaultLimit` 必须是 1..100 的整数），
不会被静默接受。

## HTTP 接口

全部挂在 `/message-hub/api` 前缀下，不与宿主或别的插件抢路径。
写操作（非 GET/HEAD）要求同源 `Origin`；非浏览器客户端没有 Origin，按连接层已鉴权放行。

| 方法与路径 | 作用 |
|---|---|
| `GET /status`（同 `/health`） | 引擎健康 + 实际数据目录 + 当前选中 |
| `POST /service/start` | 拉起引擎（首次含建 venv、装依赖） |
| `GET /overview` | 计数 / 活跃源 / 最近 5 次运行 |
| `GET /feeds` | 订阅源列表 + 汇总计数 |
| `POST /feeds` | 新增订阅源（201） |
| `POST /feeds/<id>/enable` · `/disable` | 启停 |
| `POST /feeds/<id>/run` | 立刻采集（引擎 60s 超时） |
| `DELETE /feeds/<id>` | 软删 |
| `GET /items` | 条目流，参数 `q` `source_id` `liked` `from_date` `to_date` `limit` `offset` |
| `POST /items/<id>/like` · `/unlike` | 收藏 / 取消 |
| `DELETE /items/<id>` | 删除单条（物理删除） |
| `POST /items/delete` | 批量删除，`{ids:[...]}`，单次上限 500 |
| `GET /selection?session=` | 当前选中 |
| `POST /selection` | 面板上报选中，`{sessionId, selection}` |
| `DELETE /selection?session=` | 清空选中 |
| `GET /preferences` · `PUT /preferences` | 关注方向（PUT 为整份覆盖） |
| `GET /digest`（同 `/curations`） | 精选取集列表，参数 `kind` `limit` |
| `GET /digest/<id>`（同 `/curations/<id>`） | 展开一期 |

**错误语义**是稳定的，前端与模型据此给可执行提示，而不是一片红：

| 情况 | 状态码 | 说明 |
|---|---|---|
| 引擎连不上 / 超时 | 503 | 带 `hint`（怎么启动） |
| 引擎 401 / 403 | 401 / 403 | `unauthorized` / `forbidden` |
| 其它非 2xx | 502 | `http-<status>` |
| 请求体 > 16KB | 413 | `too-large` |
| 坏 JSON | 400 | `bad-json` |
| 跨源写 | 403 | `cross-origin` |

选中态只收白名单字段（`kind` `id` `title` `source_id` `source_name` `url` `created_at`
`summary` `liked`），id/标题/摘要都有长度上限：模型读到的结构永远稳定。

## 引擎契约

插件经由下面这些接口与引擎对话。自带引擎实现了全部；把 `apiBase` 指向另一个满足契约的服务
同样能工作（此时 `serviceDir` / `pythonPath` / `installDeps` 都用不上）。

| 接口 | 用途 |
|---|---|
| `GET /api/v1/health` | 探活（面板绿点/灰点，`hub_status` 第一步） |
| `GET /api/v1/overview` | 计数、活跃源、需处理源 |
| `GET /api/v1/monitors` | 订阅源列表 |
| `POST /api/v1/monitors` | 新增源（rss / github_releases / web_page） |
| `POST /api/v1/monitors/<id>/enable` · `/disable` | 启停 |
| `POST /api/v1/monitors/<id>/run` | 立刻采集 |
| `DELETE /api/v1/monitors/<id>` | 删除（软删） |
| `GET /api/v1/feed?…` | 条目流（同 BFF 的查询参数） |
| `POST /api/v1/feed/<id>/like` · `DELETE …/like` | 收藏 / 取消 |
| `GET /api/v1/preferences` · `PUT /api/v1/preferences` | 关注方向（PUT 整份覆盖） |
| `GET /api/v1/curations?kind=&limit=` | 精选取集列表 |
| `GET /api/v1/curations/<id>` | 某一期（含条目与入选理由） |
| `GET /api/v1/runs?limit=` | 最近采集记录 |

## 数据与运行时

两个目录，职责不同：

| | `dataDir`（默认 `~/.dsh/message-hub/data`） | `runtimeDir`（默认 `~/.dsh/message-hub/runtime`） |
|---|---|---|
| 内容 | `subscriptions.db` | `pyenv/`、`install.log`、`service.log` |
| 是否要备份 | 要（唯一的用户数据） | 不要（几十 MB，可重建） |
| 换机器 | 复制过去即可继续 | 让它重建（首次会慢几十秒） |

数据目录可配置，优先级：`config.dataDir` → `DSH_MESSAGE_HUB_DATA` → 默认路径。
引擎只把 `--database <dataDir>/subscriptions.db` 传给它，所以**手动启动**时要指同一个库，
否则你会看到两个各自演进的数据库。实际路径可以从 `GET /message-hub/api/status` 的 `dataDir`
字段或 `hub_status` 里确认，不用猜。

> 搬库：把旧 `subscriptions.db` 复制到新目录，用 `sqlite3 <db> "select count(*) from items"`
> 两边对齐条目数，再把旧文件改名留作备份。

## 目录结构

```
service/                 内置引擎（vendored，升级时整体覆盖）
  message_subscriptions/   采集 / 去重 / SSRF / SQLite / FastAPI
  config/subscriptions.yaml  启动配置（sources 故意为空，源在数据库里）
  requirements.txt         引擎依赖（首次启动装进 venv）
skills/
  message-hub/SKILL.md    随包 skill：给 agent 的操作指南
src/
  index.mjs        宿主入口：apply / Config / 路径解析 / 引擎启动器
  python.mjs       解释器 / venv / 依赖 / 子进程 / 健康检查
  skills.mjs       随包 skill 的解析与注册（可选能力，失败不影响工具面）
  service.mjs      唯一的上游边界：HTTP 调用、错误码、选中态
  server.mjs       BFF 路由（/message-hub/api）
  tools.mjs        hub_* 工具（10 个）
  client/index.js  浏览器半边：三栏面板、三个页签、草稿桥
lib/
  index.js         宿主入口产物（转发 src/index.mjs）
  client.js        浏览器产物（build 生成，勿手改）
tests/             6 个离线自检 + 1 个真服务 e2e
scripts/
  build-client.mjs 客户端构建与漂移校验
  restart-dsh.ps1  Windows 开发辅助（重启 DSH）
cordis.patch.yml   bundle 装配层（稳定 id + 默认配置）
```

## 开发

```bash
npm run build     # src/client/index.js → lib/client.js
npm test          # 6 个离线自检 + 1 个真服务 e2e
npm run check     # build --check + test（提交前跑这个）
```

宿主半边是纯 ESM、无构建；`lib/index.js` 只做转发出口，改 `src/` 后重启 DSH 生效。
浏览器半边是手写 `__ModuleLoader__` 形态，`build` 只做拷贝 + 摘掉悬空 `sourceMappingURL`
+ 指纹 + 结构契约校验（必须自注册、必须导出 `apply`/`inject`、必须注册两个槽位），
**不引入打包器**。

| 自检 | 覆盖 |
|---|---|
| `fiber_contract_selftest` | 导出面、Config 默认值/非法值、token 与路径解析、极简 ctx 下能挂载 |
| `engine_selftest` | 引擎目录完整性、config 不注入示例源、venv 落点、启动参数、依赖 marker 幂等、找不到 Python 时的报错 |
| `skill_bundle_selftest` | SKILL.md 的 frontmatter 与名字规范、正文引用的工具是否真实存在、provider 的 list/get 形状、没有 skills 服务时只告警不抛错 |
| `service_selftest` | 真 http mock 验引擎契约：Bearer 头、查询串裁剪、401/403/500 → 稳定 code、连不上 → `service-down`、选中态的会话隔离与 TTL |
| `server_selftest` | BFF 真 socket：路由、201/404/400/403/413、跨源写拒绝、坏 JSON、引擎错误 → 503 + hint、选中白名单裁剪 |
| `client_bundle_selftest` | 用假 `__ModuleLoader__` 执行 bundle：自注册、槽位 id 一致、zh/en 无缺词条、引用文本、草稿写入三个分支 |
| `e2e_host_smoke` | **真插件 + 真 BFF + 真引擎**；引擎没起时只断言降级路径并明说 SKIP，不假装通过 |

`lib/client.js` 没有 sourcemap：它是手写源码的拷贝，排障直接读 `src/client/index.js`；
`npm run check` 会拦住二者漂移。

**升级引擎**：用上游 `message-subscriptions` 的新版本覆盖 `service/message_subscriptions/`，
检查 `requirements.txt` 是否要跟着变，然后 `npm test`。依赖一旦变化，marker 会自动失效并在
下次启动时重装。

## 设计取舍

**引擎是子进程，不是进程内。** 采集用到 FastAPI、httpx、bs4 这一整套；DSH 自带 Python，
把它放进子进程比在 Node 里重写一遍解析更容易保持语义一致，也把引擎崩溃隔离在宿主之外。

**但引擎代码跟着包走。** 之前 `projectDir` 指向另一个 checkout，换机器就断；现在
`service/` 是包的一部分，唯一的机器外部依赖只剩「能跑 Python」——而 DSH 自带。

**venv 放 `runtimeDir`。** 几十 MB、可重建，和用户数据分开：备份数据时不必带上它，
换机器时也不用迁移。

**配置用手写 Standard Schema。** Cordis 的 `resolveConfig` 会去取 `Config['~standard'].validate`，
写成描述性对象会在宿主侧抛 TypeError，且报错看不出是这个原因。

**客户端不打包。** DSH 的 client 半边本来就是 `__ModuleLoader__` 形态，再套一层 bundler
只会引入新的失败面；拷贝 + 结构契约校验足够拦住真实事故。

## 已知边界

- **没有内置调度器**：引擎自己不会定时；周期采集由插件进程里的定时器完成（`collectIntervalMinutes`，
  默认 6 小时），插件没启动就没有采集。定时任务怎么配、每日精选怎么接，见 [docs/automation.md](docs/automation.md)。
- **首次启动要联网**（PyPI）。离线环境请预先备好 venv 或把 `installDeps` 设为 `false`。
- **精选不会自动生成**：`curation_collections` 由引擎之外的脚本写入，新环境里这一栏初始为空。
- **选中态在内存里**：插件重启即丢。
- **条目没有单条 GET**：`hub_item` 在最近 100 条里按 id 找，找不到会明说，而不是编一条出来。
- **`web_page` 类型需要完整 `config`**（request / extract / detect）：一句话塞不进 CSS 选择器，
  这类源建议先写好配置再导入。
- **只在 web 平台注册**（`dsh.client.platform = web`），面板没有 sourcemap。

## 排障

| 现象 | 多半是 | 动作 |
|---|---|---|
| 点「启动服务」后要等很久 | 首次在装依赖 | 等它跑完；进度看 `<runtimeDir>/install.log` |
| 启动失败：找不到 Python | PATH 里没有 3.11+ | 装一个，或 `config.pythonPath` 指向解释器 |
| 启动失败：pip 装不上 | 网络 / 代理 / 镜像 | 看 `install.log`；可手动 `venv/python -m pip install -r service/requirements.txt` |
| 30 秒内健康检查未通过 | 端口被占 / 引擎启动即崩 | 看 `<runtimeDir>/service.log`；换 `apiBase` 端口或结束占用进程 |
| 面板 404、路由全空 | 宿主没有 `webServer` | 确认 profile 里包含提供 `webServer` 的层（如 `@deepseek-ai/dsh-web-app`） |
| `hub_*` 工具不存在 | 宿主没有 `tools` 服务 | 同上；日志会写明缺哪个服务 |
| skill 列表里没有 `message-hub` | 宿主没有 skills 服务，或还没重启 | 确认 profile 含 `dsh-skill` / `dsh-tool-skill`；重启后在新会话里看 |
| 引擎在线但没有条目 | 还没采集过 | 对源点「立刻采集」 |

## 许可证

MIT。`service/` 是从 `message-subscriptions` 搬入的引擎，见该目录的 README 与上游许可。