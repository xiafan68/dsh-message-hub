from __future__ import annotations

from pathlib import Path
import sqlite3
import os
import secrets
from typing import Any

from fastapi import Body, FastAPI, Header, HTTPException, Query, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import AppConfig, ConfigError, validate_source_config
from .service import SubscriptionService
from .store import Store


def create_app(config: AppConfig, store: Store) -> FastAPI:
    store.sync_monitors(config.sources)
    app = FastAPI(title="Message Subscriptions", version="0.1.0")
    static_directory = Path(__file__).with_name("static")
    app.mount("/assets", StaticFiles(directory=static_directory), name="assets")
    write_token = os.environ.get("MESSAGE_SUBSCRIPTIONS_API_TOKEN")

    def require_write_token(authorization: str | None) -> None:
        if write_token and not authorization:
            raise HTTPException(status_code=401, detail="Bearer token required")
        if write_token and not secrets.compare_digest(authorization.removeprefix("Bearer ").strip(), write_token):
            raise HTTPException(status_code=403, detail="Invalid bearer token")

    def current_sources() -> list[dict]:
        return store.monitor_configs()

    @app.get("/", include_in_schema=False)
    @app.get("/ui", include_in_schema=False)
    def root() -> FileResponse:
        return FileResponse(
            static_directory / "index.html",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )

    @app.get("/ui/login", include_in_schema=False)
    def login() -> FileResponse:
        return FileResponse(
            static_directory / "login.html",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )

    @app.get("/api/v1/health")
    def health() -> dict[str, Any]:
        database_ok = _database_healthy(store.path)
        return {
            "status": "ok" if database_ok else "degraded",
            "database": "ok" if database_ok else "error",
            "configured_sources": len(current_sources()),
            "write_protection": bool(write_token),
        }

    @app.get("/api/v1/auth/session")
    def auth_session(authorization: str | None = Header(default=None)) -> dict[str, bool]:
        require_write_token(authorization)
        return {"authenticated": True}

    @app.get("/api/v1/monitors")
    def monitors() -> dict[str, Any]:
        runtime = store.monitor_runtime()
        items = [_monitor_view(source, runtime.get(source["id"], {})) for source in current_sources()]
        return {"items": items, "total": len(items)}

    @app.post("/api/v1/monitors", status_code=201)
    def create_monitor(payload: dict = Body(...), authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        try:
            validate_source_config(payload)
            return _monitor_view(store.create_monitor(payload), {})
        except (ConfigError, KeyError, sqlite3.IntegrityError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/v1/monitors/{source_id}")
    def monitor(source_id: str) -> dict[str, Any]:
        source = store.monitor_record(source_id)
        if source is None:
            raise HTTPException(status_code=404, detail="Monitor not found")
        runtime = store.monitor_runtime().get(source_id, {})
        return _monitor_view(source, runtime)

    @app.patch("/api/v1/monitors/{source_id}")
    def update_monitor(source_id: str, payload: dict = Body(...), authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        try:
            current = store.monitor_record(source_id)
            if current is None:
                raise HTTPException(status_code=404, detail="Monitor not found")
            candidate = {key: value for key, value in current.items() if key not in {"monitor_status", "created_at", "updated_at"}}
            candidate.update(payload)
            validate_source_config(candidate)
            updated = store.update_monitor(source_id, payload)
            return _monitor_view(updated, store.monitor_runtime().get(source_id, {}))
        except ConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/v1/monitors/{source_id}/enable")
    def enable_monitor(source_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        result = store.set_monitor_status(source_id, "active")
        if result is None: raise HTTPException(status_code=404, detail="Monitor not found")
        return _monitor_view(result, store.monitor_runtime().get(source_id, {}))

    @app.post("/api/v1/monitors/{source_id}/disable")
    def disable_monitor(source_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        result = store.set_monitor_status(source_id, "paused")
        if result is None: raise HTTPException(status_code=404, detail="Monitor not found")
        return _monitor_view(result, store.monitor_runtime().get(source_id, {}))

    @app.delete("/api/v1/monitors/{source_id}", status_code=204)
    def delete_monitor(source_id: str, authorization: str | None = Header(default=None)) -> Response:
        require_write_token(authorization)
        if not store.delete_monitor(source_id): raise HTTPException(status_code=404, detail="Monitor not found")
        return Response(status_code=204)

    @app.post("/api/v1/monitors/{source_id}/run")
    def run_monitor(source_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        source = store.monitor_record(source_id)
        if source is None: raise HTTPException(status_code=404, detail="Monitor not found")
        runtime_config = type(config)(config.defaults, (source,), config.destinations, config.policies)
        result = SubscriptionService(runtime_config, store).run_source(source)
        return result.as_dict()

    @app.get("/api/v1/runs")
    def runs(limit: int = Query(20, ge=1, le=100)) -> dict[str, Any]:
        items = store.recent_runs(limit)
        return {"items": items, "total": len(items)}

    @app.get("/api/v1/overview")
    def overview() -> dict[str, Any]:
        runtime = store.monitor_runtime()
        monitor_items = [_monitor_view(source, runtime.get(source["id"], {})) for source in current_sources()]
        counts = store.overview_counts()
        counts.update(
            {
                "total_monitors": len(monitor_items),
                "active_monitors": sum(item["status"] == "active" for item in monitor_items),
                "attention_monitors": sum(item["status"] in {"degraded", "error"} for item in monitor_items),
            }
        )
        return counts

    @app.get("/api/v1/feed")
    def feed(
        source_id: str | None = None, from_date: str | None = None, to_date: str | None = None,
        q: str | None = None, liked: bool | None = None, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
    ) -> dict[str, Any]:
        items, total = store.feed_items(source_id, from_date, to_date, q, liked, limit, offset)
        sources = {source["id"]: source for source in current_sources()}
        for item in items:
            source = sources.get(item["source_id"], {})
            item["source_name"] = source.get("name", item["source_id"])
            item["created_at"] = item["published_at"] or item["first_seen_at"]
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    @app.post("/api/v1/feed/{item_id}/like")
    def like_feed_item(item_id: int, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        result = store.set_item_liked(item_id, True)
        if result is None:
            raise HTTPException(status_code=404, detail="Feed item not found")
        return result

    @app.delete("/api/v1/feed/{item_id}/like")
    def unlike_feed_item(item_id: int, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        result = store.set_item_liked(item_id, False)
        if result is None:
            raise HTTPException(status_code=404, detail="Feed item not found")
        return result

    @app.delete("/api/v1/feed/{item_id}")
    def delete_feed_item(item_id: int, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        if not store.delete_item(item_id):
            raise HTTPException(status_code=404, detail="Feed item not found")
        return {"deleted": 1}

    @app.post("/api/v1/feed/delete")
    def delete_feed_items(payload: dict = Body(...), authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        raw = payload.get("ids")
        if not isinstance(raw, list) or not raw:
            raise HTTPException(status_code=400, detail="ids must be a non-empty array")
        try:
            ids = sorted({int(value) for value in raw})
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="ids must be integers") from exc
        if len(ids) > 500:
            raise HTTPException(status_code=400, detail="too many ids (max 500)")
        return {"deleted": store.delete_items(ids)}

    @app.get("/api/v1/preferences")
    def preferences() -> dict[str, Any]:
        return {"directions": store.get_preferences()}

    @app.put("/api/v1/preferences")
    def update_preferences(payload: dict = Body(...), authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        directions = payload.get("directions")
        if not isinstance(directions, list) or not all(isinstance(item, str) for item in directions):
            raise HTTPException(status_code=400, detail="directions must be a string array")
        return {"directions": store.set_preferences(directions)}

    @app.get("/api/v1/curations")
    def curations(kind: str | None = None, limit: int = Query(20, ge=1, le=100)) -> dict[str, Any]:
        return {"items": store.curations(kind, limit)}

    @app.get("/api/v1/curations/{collection_id}")
    def curation(collection_id: str) -> dict[str, Any]:
        result = store.curation(collection_id)
        if result is None: raise HTTPException(status_code=404, detail="Curation not found")
        return result

    @app.post("/api/v1/curations", status_code=201)
    def create_curation(payload: dict = Body(...), authorization: str | None = Header(default=None)) -> dict[str, Any]:
        require_write_token(authorization)
        required = ("kind", "period_start", "period_end", "title", "items")
        if any(key not in payload for key in required) or payload["kind"] not in {"daily", "weekly"} or not isinstance(payload["items"], list):
            raise HTTPException(status_code=400, detail="kind, period dates, title and items are required")
        if any(not isinstance(item, dict) or not item.get("title") or not item.get("source_name") for item in payload["items"]):
            raise HTTPException(status_code=400, detail="each item requires title and source_name")
        if payload["kind"] == "daily" and any(
            not item.get("html_body")
            or not item.get("created_at")
            or not isinstance(item.get("source_item_ids"), list)
            or not item["source_item_ids"]
            for item in payload["items"]
        ):
            raise HTTPException(status_code=400, detail="daily items require html_body, created_at and source_item_ids")
        return store.upsert_curation(payload["kind"], payload["period_start"], payload["period_end"], payload["title"], payload.get("summary"), payload["items"])

    return app


def _database_healthy(path: Path) -> bool:
    try:
        with sqlite3.connect(path) as connection:
            connection.execute("SELECT 1").fetchone()
        return True
    except sqlite3.Error:
        return False


def _monitor_view(source: dict[str, Any], runtime: dict[str, object]) -> dict[str, Any]:
    enabled = source.get("enabled", True)
    failures = int(runtime.get("consecutive_failures", 0))
    if not enabled:
        status = "paused"
    elif failures >= 3:
        status = "error"
    elif failures > 0:
        status = "degraded"
    else:
        status = "active"
    request = source.get("request", {})
    outputs = source.get("outputs", {})
    return {
        "id": source["id"],
        "name": source.get("name", source["id"]),
        "type": source["type"],
        "enabled": enabled,
        "status": status,
        "tags": source.get("tags", []),
        "url": source.get("url") or request.get("url") or (
            f"https://github.com/{source['repository']}" if source.get("repository") else None
        ),
        "interval_minutes": source.get("schedule", {}).get(
            "interval_minutes", source.get("poll_interval_minutes", 30)
        ),
        "delivery_mode": outputs.get("delivery", {}).get("mode", source.get("delivery", "daily_digest")),
        "item_count": int(runtime.get("item_count", 0)),
        "last_run_at": runtime.get("last_run_at"),
        "last_status": runtime.get("last_status"),
        "last_success_at": runtime.get("last_success_at"),
        "last_error": runtime.get("last_error"),
        "consecutive_failures": failures,
    }
