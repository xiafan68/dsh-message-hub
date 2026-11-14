from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
import sys
from datetime import datetime, timedelta, timezone

from .config import ConfigError, load_config
from .service import SubscriptionService
from .store import Store


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="message-subscriptions")
    parser.add_argument("--config", default="config/subscriptions.yaml", help="YAML 配置路径")
    parser.add_argument("--database", default="data/subscriptions.db", help="SQLite 数据库路径")
    parser.add_argument("--verbose", action="store_true")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check-config", help="校验配置")
    subparsers.add_parser("init-db", help="初始化数据库")
    run_parser = subparsers.add_parser("run", help="运行一次采集")
    run_parser.add_argument("--source", help="仅运行指定来源 id")
    run_parser.add_argument("--no-delivery", action="store_true", help="采集入库但不发送通知")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        config = load_config(args.config)
        if args.command == "check-config":
            print(json.dumps({"valid": True, "sources": len(config.sources)}, ensure_ascii=False))
            return 0
        store = Store(Path(args.database))
        store.initialize()
        store.sync_monitors(config.sources)
        config = type(config)(config.defaults, tuple(store.monitor_configs()), config.destinations, config.policies)
        if args.command == "init-db":
            print(json.dumps({"initialized": str(store.path)}, ensure_ascii=False))
            return 0
        service = SubscriptionService(config, store, delivery_enabled=not args.no_delivery)
        results = service.run_all(args.source)
        deleted = store.delete_unliked_before((datetime.now(timezone.utc) - timedelta(days=14)).isoformat())
        print(json.dumps([result.as_dict() for result in results], ensure_ascii=False, indent=2))
        if deleted:
            logging.info("deleted %s unliked feed items older than 14 days", deleted)
        failure_statuses = {"failed", "fetch_failed", "extract_failed", "delivery_failed"}
        return 1 if any(result.status in failure_statuses for result in results) else 0
    except (ConfigError, ValueError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
