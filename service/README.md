# service/ —— 内置订阅引擎（vendored）

这里是从 `message-subscriptions` 复制进来的 Python 订阅引擎，**不是**本项目的业务代码：

- 面板、BFF、`hub_*` 工具都不在这里，它们在仓库根目录的 `src/`；
- 升级引擎 = 用上游项目的新版本覆盖 `message_subscriptions/`，再跑一遍 `npm run check`；
- 不要在本地改这个目录里的文件，否则下次覆盖会丢；要改就回上游改。

插件启动时会用 `python -m message_subscriptions.server` 把它拉起来（见 `src/python.mjs`），
并用 `--config` 显式指向 `service/config/subscriptions.yaml`、`--database` 指向
`<dataDir>/subscriptions.db`。

`config/subscriptions.yaml` 里的 `sources` 故意留空：订阅源的真身在数据库 `monitors` 表，
启动时的 `sync_monitors` 只会 `INSERT OR IGNORE` 追加。放示例源进去会把
`example.com` 写进你的库。

运行时依赖在 `requirements.txt`，插件首次启动时自动装进 `<runtimeDir>/pyenv`。