from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import re
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup, Tag

from ..http import HttpFetcher
from ..models import CollectionResult, Item, SourceState


class ExtractionError(ValueError):
    pass


def collect_web_page(
    source: dict[str, Any], state: SourceState, fetcher: HttpFetcher
) -> CollectionResult:
    request = source["request"]
    response = fetcher.fetch(
        request["url"],
        state=state,
        headers=request.get("headers"),
        timeout_seconds=float(request.get("timeout_seconds", 20)),
    )
    etag = response.headers.get("etag")
    modified = response.headers.get("last-modified")
    if response.status_code == 304:
        return CollectionResult([], etag or state.etag, modified or state.last_modified, True)

    soup = BeautifulSoup(response.content, "html.parser")
    extract = source["extract"]
    for selector in extract.get("exclude_selectors", []):
        for node in soup.select(selector):
            node.decompose()

    regions = _regions(extract)
    items: list[Item] = []
    matched = 0
    for name, selector, fields in regions:
        nodes = soup.select(selector)
        matched += len(nodes)
        for node in nodes:
            item = _extract_item(source, response.url, node, fields, name)
            if item is not None:
                items.append(item)
    if matched == 0:
        raise ExtractionError("所有 item selector 均未匹配，拒绝将空页面视为正常结果")
    return CollectionResult(_deduplicate(items), etag, modified)


def _regions(extract: dict[str, Any]) -> list[tuple[str | None, str, dict[str, Any]]]:
    if extract.get("item_selector"):
        return [(None, extract["item_selector"], extract["fields"])]
    if extract.get("item_selectors"):
        return [(str(index), selector, extract["fields"]) for index, selector in enumerate(extract["item_selectors"])]
    result = []
    for collection in extract.get("collections", []):
        result.append((collection.get("name"), collection["item_selector"], collection["fields"]))
    return result


def _extract_item(
    source: dict[str, Any], base_url: str, node: Tag, fields: dict[str, Any], collection: str | None
) -> Item | None:
    values = {name: _extract_field(node, specification) for name, specification in fields.items()}
    title = values.get("title")
    url = urljoin(base_url, values["url"]) if values.get("url") else None
    if not url or urlsplit(url).scheme not in {"http", "https"}:
        return None
    if not title or title.strip() == url:
        return None
    title = title or url or "(无标题)"
    canonical_url = _canonical_url(url) if url else None
    fallback_hash = sha256(
        "\x1f".join([title, canonical_url or "", values.get("summary") or ""]).encode()
    ).hexdigest()
    detect = source.get("detect", {})
    if detect.get("strategy") == "content_hash":
        external_id = fallback_hash
    else:
        external_id = values.get("id") or canonical_url or fallback_hash
    return Item(
        source_id=source["id"],
        external_id=external_id,
        title=title,
        url=canonical_url,
        summary=values.get("summary"),
        author=values.get("author"),
        published_at=_parse_date(values.get("published_at")),
        tags=tuple(source.get("tags", [])),
        raw={"fields": values},
        source_collection=collection,
    )


def _extract_field(node: Tag, specification: Any) -> str | None:
    if isinstance(specification, str):
        specification = {"selector": specification, "value": "text"}
    if not isinstance(specification, dict):
        raise ExtractionError("字段配置必须是 selector 字符串或对象")
    selectors = specification.get("selectors") or [specification.get("selector")]
    for selector in selectors:
        target = node.select_one(selector) if selector else node
        if target is None:
            continue
        value_type = specification.get("value", "text")
        if value_type == "text":
            value = target.get_text(" ", strip=True)
        elif value_type == "datetime":
            value = target.get("datetime") or target.get_text(" ", strip=True)
        else:
            value = target.get(value_type)
        if value is not None:
            normalized = re.sub(r"\s+", " ", str(value)).strip()
            if normalized:
                return normalized
    return None


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result


def _canonical_url(url: str) -> str:
    parsed = urlsplit(url)
    hostname = (parsed.hostname or "").lower()
    port = parsed.port
    netloc = hostname
    if port and not ((parsed.scheme == "http" and port == 80) or (parsed.scheme == "https" and port == 443)):
        netloc = f"{hostname}:{port}"
    return urlunsplit((parsed.scheme.lower(), netloc, parsed.path or "/", parsed.query, ""))


def _deduplicate(items: list[Item]) -> list[Item]:
    seen: set[str] = set()
    result: list[Item] = []
    for item in items:
        if item.external_id not in seen:
            seen.add(item.external_id)
            result.append(item)
    return result
