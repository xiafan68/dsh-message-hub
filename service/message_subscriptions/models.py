from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
import json
from typing import Any


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(slots=True)
class Item:
    source_id: str
    external_id: str
    title: str
    url: str | None = None
    summary: str | None = None
    author: str | None = None
    published_at: datetime | None = None
    tags: tuple[str, ...] = ()
    raw: dict[str, Any] = field(default_factory=dict)
    source_collection: str | None = None

    @property
    def content_hash(self) -> str:
        values = [self.title, self.url or "", self.summary or "", self.author or ""]
        return sha256("\x1f".join(values).encode()).hexdigest()

    def raw_json(self) -> str:
        return json.dumps(self.raw, ensure_ascii=False, sort_keys=True, default=str)


@dataclass(slots=True)
class FetchResult:
    url: str
    status_code: int
    content: bytes
    headers: dict[str, str]

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", errors="replace")


@dataclass(slots=True)
class SourceState:
    source_id: str
    etag: str | None = None
    last_modified: str | None = None
    consecutive_failures: int = 0


@dataclass(slots=True)
class CollectionResult:
    items: list[Item]
    etag: str | None = None
    last_modified: str | None = None
    not_modified: bool = False

