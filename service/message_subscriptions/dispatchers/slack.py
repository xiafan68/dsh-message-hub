from __future__ import annotations

import os
import subprocess
from typing import Any

from ..models import Item


class DispatchError(RuntimeError):
    pass


class SlackDispatcher:
    def __init__(self, config: dict[str, Any]):
        env_name = config.get("recipient_id_env")
        if not env_name:
            raise DispatchError("Slack 目的地缺少 recipient_id_env")
        recipient_id = os.environ.get(env_name)
        if not recipient_id:
            raise DispatchError(f"环境变量 {env_name} 未设置")
        self.recipient_id = recipient_id
        self.workspace = config.get("workspace")

    def send(self, item: Item) -> None:
        message = _format_message(item)
        command = [
            "slackcli",
            "messages",
            "send",
            "--recipient-id",
            self.recipient_id,
            "--message",
            message,
        ]
        if self.workspace:
            command.extend(["--workspace", self.workspace])
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise DispatchError(f"无法执行 slackcli: {exc}") from exc
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            raise DispatchError(f"slackcli 发送失败: {detail or result.returncode}")


def _format_message(item: Item) -> str:
    lines = [f"*{item.title}*"]
    if item.summary:
        summary = item.summary[:500] + ("…" if len(item.summary) > 500 else "")
        lines.append(summary)
    if item.url:
        lines.append(item.url)
    metadata = []
    if item.author:
        metadata.append(item.author)
    if item.published_at:
        metadata.append(item.published_at.isoformat())
    metadata.append(item.source_id)
    lines.append(" · ".join(metadata))
    return "\n".join(lines)

