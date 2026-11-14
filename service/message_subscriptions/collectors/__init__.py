from __future__ import annotations

from typing import Any

from ..http import HttpFetcher
from ..models import CollectionResult, SourceState
from .feed import collect_feed
from .web_page import collect_web_page


class UnsupportedSourceError(ValueError):
    pass


def collect_source(
    source: dict[str, Any], state: SourceState, fetcher: HttpFetcher
) -> CollectionResult:
    source_type = source["type"]
    if source_type in {"rss", "atom", "github_releases"}:
        return collect_feed(source, state, fetcher)
    if source_type == "web_page":
        return collect_web_page(source, state, fetcher)
    raise UnsupportedSourceError(f"不支持的来源类型: {source_type}")

