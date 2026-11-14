from __future__ import annotations

from dataclasses import asdict, dataclass
import logging
from typing import Any, Protocol

from .collectors import collect_source
from .collectors.feed import FeedParseError
from .collectors.web_page import ExtractionError
from .config import AppConfig
from .dispatchers import SlackDispatcher
from .http import FetchError, HttpFetcher
from .models import Item
from .store import Store
from .security import UnsafeUrlError


logger = logging.getLogger(__name__)


class Dispatcher(Protocol):
    def send(self, item: Item) -> None: ...


@dataclass(slots=True)
class RunResult:
    source_id: str
    status: str
    fetched_count: int = 0
    new_count: int = 0
    delivered_count: int = 0
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class SubscriptionService:
    def __init__(
        self,
        config: AppConfig,
        store: Store,
        *,
        fetcher: HttpFetcher | None = None,
        dispatchers: dict[str, Dispatcher] | None = None,
        delivery_enabled: bool = True,
    ):
        self.config = config
        self.store = store
        self.fetcher = fetcher or HttpFetcher()
        self.delivery_enabled = delivery_enabled
        self.dispatchers = dispatchers if dispatchers is not None else self._build_dispatchers()

    def run_all(self, source_id: str | None = None) -> list[RunResult]:
        sources = [source for source in self.config.sources if source.get("enabled", True)]
        if source_id:
            sources = [source for source in sources if source["id"] == source_id]
            if not sources:
                raise ValueError(f"找不到已启用的来源: {source_id}")
        return [self.run_source(source) for source in sources]

    def run_source(self, source: dict[str, Any]) -> RunResult:
        source_id = source["id"]
        run_id = self.store.start_run(source_id)
        previous_count = self.store.source_item_count(source_id)
        try:
            collection = collect_source(source, self.store.source_state(source_id), self.fetcher)
            inserted = self.store.add_items(collection.items)
            self.store.record_success(source_id, collection.etag, collection.last_modified)

            destinations = self._immediate_destinations(source)
            silent_initial = (
                previous_count == 0
                and source.get("detect", {}).get("initial_snapshot", "emit") == "silent"
            )
            delivered = 0
            delivery_errors: list[str] = []
            if self.delivery_enabled and not silent_initial:
                for item_id, _ in inserted:
                    for destination in destinations:
                        self.store.pending_delivery(item_id, destination)
                for destination in destinations:
                    dispatcher = self.dispatchers.get(destination)
                    if dispatcher is None:
                        delivery_errors.append(f"未配置目的地: {destination}")
                        continue
                    for item_id, item in self.store.delivery_queue(source_id, destination):
                        try:
                            dispatcher.send(item)
                            self.store.record_delivery(item_id, destination)
                            delivered += 1
                        except Exception as exc:
                            error = str(exc)
                            self.store.record_delivery(item_id, destination, error)
                            delivery_errors.append(error)
                            logger.warning("delivery failed for %s: %s", source_id, error)

            if delivery_errors:
                status = "delivery_failed"
                error = "; ".join(delivery_errors)
            elif collection.not_modified or not inserted:
                status = "no_change"
                error = None
            else:
                status = "changed"
                error = None
            result = RunResult(source_id, status, len(collection.items), len(inserted), delivered, error)
            self.store.finish_run(run_id, status, result.fetched_count, result.new_count, error)
            return result
        except Exception as exc:
            error = str(exc)
            if isinstance(exc, (FetchError, UnsafeUrlError)):
                status = "fetch_failed"
            elif isinstance(exc, (FeedParseError, ExtractionError)):
                status = "extract_failed"
            else:
                status = "failed"
            self.store.record_failure(source_id, error)
            self.store.finish_run(run_id, status, 0, 0, error)
            logger.exception("source collection failed: %s", source_id)
            return RunResult(source_id, status, error=error)

    def _immediate_destinations(self, source: dict[str, Any]) -> list[str]:
        delivery = source.get("outputs", {}).get("delivery", {})
        mode = delivery.get("mode", source.get("delivery", "daily_digest"))
        if mode != "immediate":
            return []
        configured = delivery.get("destinations")
        if configured:
            return list(configured)
        destination = source.get("destination")
        return [destination] if destination else []

    def _build_dispatchers(self) -> dict[str, Dispatcher]:
        if not self.delivery_enabled:
            return {}
        result: dict[str, Dispatcher] = {}
        for name, destination in self.config.destinations.items():
            if destination.get("type") == "slackcli":
                try:
                    result[name] = SlackDispatcher(destination)
                except Exception as exc:
                    logger.warning("destination %s unavailable: %s", name, exc)
        return result
