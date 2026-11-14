from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from .api import create_app
from .config import load_config
from .store import Store


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="message-subscriptions-api")
    parser.add_argument("--config", default="config/subscriptions.yaml", help="YAML 配置路径")
    parser.add_argument("--database", default="data/subscriptions.db", help="SQLite 数据库路径")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4001)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    config_path = Path(args.config)
    if not config_path.exists() and args.config == "config/subscriptions.yaml":
        config_path = Path("config/subscriptions.example.yaml")
    config = load_config(config_path)
    store = Store(args.database)
    store.initialize()
    store.sync_monitors(config.sources)
    uvicorn.run(create_app(config, store), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
