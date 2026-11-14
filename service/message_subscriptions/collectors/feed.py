from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from hashlib import sha256
from typing import Any
import xml.etree.ElementTree as ET

from ..http import HttpFetcher
from ..models import CollectionResult, Item, SourceState


class FeedParseError(ValueError):
    pass


def collect_feed(
    source: dict[str, Any], state: SourceState, fetcher: HttpFetcher
) -> CollectionResult:
    url = source.get("url")
    if source["type"] == "github_releases":
        url = f"https://github.com/{source['repository']}/releases.atom"
    response = fetcher.fetch(
        url,
        state=state,
        headers=source.get("headers"),
        timeout_seconds=float(source.get("timeout_seconds", 20)),
    )
    etag = response.headers.get("etag")
    modified = response.headers.get("last-modified")
    if response.status_code == 304:
        return CollectionResult([], etag or state.etag, modified or state.last_modified, True)
    try:
        root = ET.fromstring(response.content)
    except ET.ParseError as exc:
        raise FeedParseError(f"Feed XML 解析失败: {exc}") from exc

    root_name = _local_name(root.tag)
    if root_name == "rss":
        entries = [element for element in root.iter() if _local_name(element.tag) == "item"]
        items = [_rss_item(source, entry) for entry in entries]
    elif root_name == "feed":
        entries = [element for element in root if _local_name(element.tag) == "entry"]
        items = [_atom_item(source, entry) for entry in entries]
    else:
        raise FeedParseError(f"不支持的 Feed 根元素: {root_name}")
    return CollectionResult(_deduplicate(items), etag, modified)


def _rss_item(source: dict[str, Any], element: ET.Element) -> Item:
    title = _child_text(element, "title") or "(无标题)"
    link = _child_text(element, "link")
    summary = _child_text(element, "description")
    guid = _child_text(element, "guid")
    external_id = guid or link or _fingerprint(title, summary)
    return Item(
        source_id=source["id"],
        external_id=external_id,
        title=title,
        url=link,
        summary=summary,
        author=_child_text(element, "author") or _child_text(element, "creator"),
        published_at=_parse_date(_child_text(element, "pubDate")),
        tags=tuple(source.get("tags", [])),
        raw={"kind": "rss", "guid": guid},
    )


def _atom_item(source: dict[str, Any], element: ET.Element) -> Item:
    title = _child_text(element, "title") or "(无标题)"
    summary = _child_text(element, "summary") or _child_text(element, "content")
    link = None
    for child in element:
        if _local_name(child.tag) == "link" and child.attrib.get("rel", "alternate") == "alternate":
            link = child.attrib.get("href")
            if link:
                break
    entry_id = _child_text(element, "id")
    author = None
    for child in element:
        if _local_name(child.tag) == "author":
            author = _child_text(child, "name")
            break
    return Item(
        source_id=source["id"],
        external_id=entry_id or link or _fingerprint(title, summary),
        title=title,
        url=link,
        summary=summary,
        author=author,
        published_at=_parse_date(_child_text(element, "published") or _child_text(element, "updated")),
        tags=tuple(source.get("tags", [])),
        raw={"kind": "atom", "id": entry_id},
    )


def _child_text(element: ET.Element, name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == name and child.text:
            value = " ".join(child.itertext()).strip()
            return value or None
    return None


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        result = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result


def _fingerprint(*values: str | None) -> str:
    return sha256("\x1f".join(value or "" for value in values).encode()).hexdigest()


def _deduplicate(items: list[Item]) -> list[Item]:
    seen: set[str] = set()
    result: list[Item] = []
    for item in items:
        if item.external_id not in seen:
            seen.add(item.external_id)
            result.append(item)
    return result

