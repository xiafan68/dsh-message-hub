from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Iterator
import json
import uuid

from .models import Item, SourceState


SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_states (
    source_id TEXT PRIMARY KEY,
    etag TEXT,
    last_modified TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_success_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
);

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    summary TEXT,
    author TEXT,
    published_at TEXT,
    tags TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL DEFAULT '{}',
    source_collection TEXT,
    first_seen_at TEXT NOT NULL,
    liked INTEGER NOT NULL DEFAULT 0,
    UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    destination TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    delivered_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(item_id, destination)
);

CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    directions_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS curation_collections (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(kind, period_start)
);

CREATE TABLE IF NOT EXISTS curated_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id TEXT NOT NULL REFERENCES curation_collections(id) ON DELETE CASCADE,
    source_item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
    source_item_ids_json TEXT NOT NULL DEFAULT '[]',
    title TEXT NOT NULL,
    source_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary TEXT,
    html_body TEXT,
    url TEXT,
    rationale TEXT,
    position INTEGER NOT NULL DEFAULT 0
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(items)")}
            if "liked" not in columns:
                connection.execute("ALTER TABLE items ADD COLUMN liked INTEGER NOT NULL DEFAULT 0")
            curation_columns = {row["name"] for row in connection.execute("PRAGMA table_info(curated_items)")}
            if "html_body" not in curation_columns:
                connection.execute("ALTER TABLE curated_items ADD COLUMN html_body TEXT")
            if "source_item_ids_json" not in curation_columns:
                connection.execute("ALTER TABLE curated_items ADD COLUMN source_item_ids_json TEXT NOT NULL DEFAULT '[]'")

    def sync_monitors(self, sources: tuple[dict, ...] | list[dict]) -> None:
        now = _now()
        with self.connect() as connection:
            for source in sources:
                source_id = source["id"]
                connection.execute(
                    """INSERT OR IGNORE INTO monitors(id, config_json, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (source_id, json.dumps(source, ensure_ascii=False), "active" if source.get("enabled", True) else "paused", now, now),
                )

    def monitor_configs(self, include_deleted: bool = False) -> list[dict]:
        query = "SELECT config_json, status FROM monitors"
        if not include_deleted:
            query += " WHERE deleted_at IS NULL"
        query += " ORDER BY created_at"
        with self.connect() as connection:
            rows = connection.execute(query).fetchall()
        configs = []
        for row in rows:
            config = json.loads(row["config_json"])
            config["enabled"] = row["status"] == "active"
            config["monitor_status"] = row["status"]
            configs.append(config)
        return configs

    def monitor_record(self, monitor_id: str) -> dict | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM monitors WHERE id = ? AND deleted_at IS NULL", (monitor_id,)
            ).fetchone()
        if row is None:
            return None
        config = json.loads(row["config_json"])
        config["enabled"] = row["status"] == "active"
        config["monitor_status"] = row["status"]
        config["created_at"] = row["created_at"]
        config["updated_at"] = row["updated_at"]
        return config

    def create_monitor(self, config: dict) -> dict:
        monitor_id = config["id"]
        now = _now()
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO monitors(id, config_json, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
                (monitor_id, json.dumps(config, ensure_ascii=False), now, now),
            )
        return self.monitor_record(monitor_id) or config

    def update_monitor(self, monitor_id: str, patch: dict) -> dict | None:
        current = self.monitor_record(monitor_id)
        if current is None:
            return None
        current.pop("monitor_status", None)
        current.pop("created_at", None)
        current.pop("updated_at", None)
        current.update(patch)
        now = _now()
        with self.connect() as connection:
            connection.execute(
                "UPDATE monitors SET config_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                (json.dumps(current, ensure_ascii=False), now, monitor_id),
            )
        return self.monitor_record(monitor_id)

    def set_monitor_status(self, monitor_id: str, status: str) -> dict | None:
        if status not in {"active", "paused"}:
            raise ValueError("invalid monitor status")
        now = _now()
        with self.connect() as connection:
            connection.execute(
                "UPDATE monitors SET status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                (status, now, monitor_id),
            )
        return self.monitor_record(monitor_id)

    def delete_monitor(self, monitor_id: str) -> bool:
        now = _now()
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE monitors SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                (now, now, monitor_id),
            )
        return cursor.rowcount > 0

    def get_preferences(self) -> list[str]:
        with self.connect() as connection:
            row = connection.execute("SELECT directions_json FROM preferences WHERE id = 1").fetchone()
        return json.loads(row["directions_json"]) if row else []

    def set_preferences(self, directions: list[str]) -> list[str]:
        cleaned = list(dict.fromkeys(item.strip() for item in directions if item and item.strip()))
        now = _now()
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO preferences(id, directions_json, updated_at) VALUES (1, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET directions_json = excluded.directions_json, updated_at = excluded.updated_at""",
                (json.dumps(cleaned, ensure_ascii=False), now),
            )
        return cleaned

    def feed_items(
        self, source_id: str | None = None, from_date: str | None = None, to_date: str | None = None,
        query: str | None = None, liked: bool | None = None, limit: int = 50, offset: int = 0,
    ) -> tuple[list[dict], int]:
        clauses, params = [], []
        if source_id:
            clauses.append("i.source_id = ?"); params.append(source_id)
        if from_date:
            clauses.append("COALESCE(i.published_at, i.first_seen_at) >= ?"); params.append(from_date)
        if to_date:
            clauses.append("COALESCE(i.published_at, i.first_seen_at) < ?"); params.append(to_date)
        if query:
            clauses.append("(i.title LIKE ? OR i.summary LIKE ?)"); params.extend([f"%{query}%", f"%{query}%"])
        if liked is not None:
            clauses.append("i.liked = ?"); params.append(int(liked))
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        safe_limit = max(1, min(limit, 100)); safe_offset = max(0, offset)
        with self.connect() as connection:
            total = connection.execute(f"SELECT COUNT(*) AS count FROM items i{where}", params).fetchone()["count"]
            rows = connection.execute(
                f"""SELECT i.id, i.source_id, i.title, i.url, i.summary, i.author,
                           i.published_at, i.first_seen_at, i.tags, i.external_id, i.liked
                    FROM items i{where} ORDER BY COALESCE(i.published_at, i.first_seen_at) DESC
                    LIMIT ? OFFSET ?""", params + [safe_limit, safe_offset]
            ).fetchall()
        return [dict(row) for row in rows], int(total)

    def set_item_liked(self, item_id: int, liked: bool) -> dict | None:
        with self.connect() as connection:
            connection.execute("UPDATE items SET liked = ? WHERE id = ?", (int(liked), item_id))
            row = connection.execute(
                "SELECT id, source_id, title, url, summary, author, published_at, first_seen_at, tags, external_id, liked FROM items WHERE id = ?",
                (item_id,),
            ).fetchone()
        return dict(row) if row else None

    def delete_item(self, item_id: int) -> bool:
        """物理删除一条条目。deliveries 有 ON DELETE CASCADE，这里显式清掉以防 PRAGMA 没开。"""
        with self.connect() as connection:
            connection.execute("DELETE FROM deliveries WHERE item_id = ?", (item_id,))
            cursor = connection.execute("DELETE FROM items WHERE id = ?", (item_id,))
        return cursor.rowcount > 0

    def delete_items(self, item_ids: list[int]) -> int:
        ids = sorted({int(value) for value in item_ids})
        if not ids:
            return 0
        placeholders = ",".join("?" for _ in ids)
        with self.connect() as connection:
            connection.execute(f"DELETE FROM deliveries WHERE item_id IN ({placeholders})", ids)
            cursor = connection.execute(f"DELETE FROM items WHERE id IN ({placeholders})", ids)
        return cursor.rowcount

    def delete_unliked_before(self, cutoff: str) -> int:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM items WHERE liked = 0 AND COALESCE(published_at, first_seen_at) < ?",
                (cutoff,),
            )
        return cursor.rowcount

    def upsert_curation(self, kind: str, period_start: str, period_end: str, title: str, summary: str | None, items: list[dict]) -> dict:
        collection_id = str(uuid.uuid4())
        now = _now()
        with self.connect() as connection:
            existing = connection.execute(
                "SELECT id FROM curation_collections WHERE kind = ? AND period_start = ?", (kind, period_start)
            ).fetchone()
            if existing:
                collection_id = existing["id"]
                connection.execute("DELETE FROM curated_items WHERE collection_id = ?", (collection_id,))
                connection.execute(
                    "UPDATE curation_collections SET period_end = ?, title = ?, summary = ?, created_at = ? WHERE id = ?",
                    (period_end, title, summary, now, collection_id),
                )
            else:
                connection.execute(
                    "INSERT INTO curation_collections(id, kind, period_start, period_end, title, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (collection_id, kind, period_start, period_end, title, summary, now),
                )
            for position, item in enumerate(items):
                connection.execute(
                    """INSERT INTO curated_items(collection_id, source_item_id, source_item_ids_json, title, source_name, created_at, summary, html_body, url, rationale, position)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (collection_id, item.get("source_item_id"), json.dumps(item.get("source_item_ids", [])), item["title"], item["source_name"], item.get("created_at") or now, item.get("summary"), item.get("html_body"), item.get("url"), item.get("rationale"), position),
                )
        return self.curation(collection_id) or {}

    def curations(self, kind: str | None = None, limit: int = 20) -> list[dict]:
        clauses = ["1 = 1"]; params: list = []
        if kind:
            clauses.append("kind = ?"); params.append(kind)
        with self.connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM curation_collections WHERE {' AND '.join(clauses)} ORDER BY period_start DESC LIMIT ?",
                params + [max(1, min(limit, 100))],
            ).fetchall()
        return [self._curation_row(row) for row in rows]

    def curation(self, collection_id: str) -> dict | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM curation_collections WHERE id = ?", (collection_id,)).fetchone()
            if row is None: return None
            items = connection.execute("SELECT * FROM curated_items WHERE collection_id = ? ORDER BY position", (collection_id,)).fetchall()
        result = self._curation_row(row)
        result["items"] = []
        for item in items:
            value = dict(item)
            value["source_item_ids"] = json.loads(value.pop("source_item_ids_json", "[]"))
            result["items"].append(value)
        return result

    @staticmethod
    def _curation_row(row: sqlite3.Row) -> dict:
        return {"id": row["id"], "kind": row["kind"], "period_start": row["period_start"], "period_end": row["period_end"], "title": row["title"], "summary": row["summary"], "created_at": row["created_at"]}

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def source_state(self, source_id: str) -> SourceState:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM source_states WHERE source_id = ?", (source_id,)
            ).fetchone()
        if row is None:
            return SourceState(source_id)
        return SourceState(source_id, row["etag"], row["last_modified"], row["consecutive_failures"])

    def start_run(self, source_id: str) -> int:
        with self.connect() as connection:
            cursor = connection.execute(
                "INSERT INTO runs(source_id, started_at, status) VALUES (?, ?, 'running')",
                (source_id, _now()),
            )
            return int(cursor.lastrowid)

    def finish_run(
        self, run_id: int, status: str, fetched_count: int, new_count: int, error: str | None = None
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """UPDATE runs SET finished_at = ?, status = ?, fetched_count = ?, new_count = ?, error = ?
                   WHERE id = ?""",
                (_now(), status, fetched_count, new_count, error, run_id),
            )

    def record_success(self, source_id: str, etag: str | None, last_modified: str | None) -> None:
        now = _now()
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO source_states(
                       source_id, etag, last_modified, consecutive_failures, last_success_at, updated_at
                   ) VALUES (?, ?, ?, 0, ?, ?)
                   ON CONFLICT(source_id) DO UPDATE SET
                       etag = excluded.etag,
                       last_modified = excluded.last_modified,
                       consecutive_failures = 0,
                       last_success_at = excluded.last_success_at,
                       last_error = NULL,
                       updated_at = excluded.updated_at""",
                (source_id, etag, last_modified, now, now),
            )

    def record_failure(self, source_id: str, error: str) -> None:
        now = _now()
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO source_states(source_id, consecutive_failures, last_error, updated_at)
                   VALUES (?, 1, ?, ?)
                   ON CONFLICT(source_id) DO UPDATE SET
                       consecutive_failures = consecutive_failures + 1,
                       last_error = excluded.last_error,
                       updated_at = excluded.updated_at""",
                (source_id, error, now),
            )

    def add_items(self, items: list[Item]) -> list[tuple[int, Item]]:
        inserted: list[tuple[int, Item]] = []
        with self.connect() as connection:
            for item in items:
                cursor = connection.execute(
                    """INSERT OR IGNORE INTO items(
                           source_id, external_id, content_hash, title, url, summary, author,
                           published_at, tags, raw_json, source_collection, first_seen_at
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        item.source_id,
                        item.external_id,
                        item.content_hash,
                        item.title,
                        item.url,
                        item.summary,
                        item.author,
                        item.published_at.isoformat() if item.published_at else None,
                        ",".join(item.tags),
                        item.raw_json(),
                        item.source_collection,
                        _now(),
                    ),
                )
                if cursor.rowcount:
                    inserted.append((int(cursor.lastrowid), item))
        return inserted

    def pending_delivery(self, item_id: int, destination: str) -> bool:
        now = _now()
        with self.connect() as connection:
            connection.execute(
                """INSERT OR IGNORE INTO deliveries(item_id, destination, status, updated_at)
                   VALUES (?, ?, 'pending', ?)""",
                (item_id, destination, now),
            )
            row = connection.execute(
                "SELECT status FROM deliveries WHERE item_id = ? AND destination = ?",
                (item_id, destination),
            ).fetchone()
        return row is not None and row["status"] != "delivered"

    def delivery_queue(self, source_id: str, destination: str) -> list[tuple[int, Item]]:
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT i.* FROM items i
                   JOIN deliveries d ON d.item_id = i.id
                   WHERE i.source_id = ? AND d.destination = ? AND d.status != 'delivered'
                   ORDER BY i.id""",
                (source_id, destination),
            ).fetchall()
        return [(int(row["id"]), self._row_to_item(row)) for row in rows]

    def record_delivery(self, item_id: int, destination: str, error: str | None = None) -> None:
        now = _now()
        status = "failed" if error else "delivered"
        with self.connect() as connection:
            connection.execute(
                """UPDATE deliveries SET status = ?, attempts = attempts + 1, last_error = ?,
                       delivered_at = CASE WHEN ? IS NULL THEN ? ELSE delivered_at END, updated_at = ?
                   WHERE item_id = ? AND destination = ?""",
                (status, error, error, now, now, item_id, destination),
            )

    def source_item_count(self, source_id: str) -> int:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM items WHERE source_id = ?", (source_id,)
            ).fetchone()
        return int(row["count"])

    def monitor_runtime(self) -> dict[str, dict[str, object]]:
        with self.connect() as connection:
            state_rows = connection.execute("SELECT * FROM source_states").fetchall()
            item_rows = connection.execute(
                "SELECT source_id, COUNT(*) AS item_count FROM items GROUP BY source_id"
            ).fetchall()
            run_rows = connection.execute(
                "SELECT * FROM runs ORDER BY started_at DESC, id DESC"
            ).fetchall()
        result: dict[str, dict[str, object]] = {}
        for row in state_rows:
            result[row["source_id"]] = {
                "consecutive_failures": row["consecutive_failures"],
                "last_success_at": row["last_success_at"],
                "last_error": row["last_error"],
            }
        for row in item_rows:
            result.setdefault(row["source_id"], {})["item_count"] = row["item_count"]
        for row in run_rows:
            runtime = result.setdefault(row["source_id"], {})
            if "last_run_at" not in runtime:
                runtime.update(
                    {
                        "last_run_at": row["finished_at"] or row["started_at"],
                        "last_status": row["status"],
                    }
                )
        return result

    def recent_runs(self, limit: int = 20) -> list[dict[str, object]]:
        safe_limit = max(1, min(limit, 100))
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT id, source_id, started_at, finished_at, status,
                          fetched_count, new_count, error
                   FROM runs ORDER BY started_at DESC, id DESC LIMIT ?""",
                (safe_limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def overview_counts(self) -> dict[str, int]:
        day_ago = (datetime.now(timezone.utc).timestamp() - 86_400)
        cutoff = datetime.fromtimestamp(day_ago, timezone.utc).isoformat()
        with self.connect() as connection:
            item_row = connection.execute(
                """SELECT COUNT(*) AS total_items,
                          SUM(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END) AS new_items_24h
                   FROM items""",
                (cutoff,),
            ).fetchone()
            failure_row = connection.execute(
                """SELECT COUNT(*) AS failures_24h FROM runs
                   WHERE started_at >= ? AND status IN
                   ('failed', 'fetch_failed', 'extract_failed', 'delivery_failed')""",
                (cutoff,),
            ).fetchone()
        return {
            "total_items": int(item_row["total_items"] or 0),
            "new_items_24h": int(item_row["new_items_24h"] or 0),
            "failures_24h": int(failure_row["failures_24h"] or 0),
        }

    @staticmethod
    def _row_to_item(row: sqlite3.Row) -> Item:
        published_at = datetime.fromisoformat(row["published_at"]) if row["published_at"] else None
        return Item(
            source_id=row["source_id"],
            external_id=row["external_id"],
            title=row["title"],
            url=row["url"],
            summary=row["summary"],
            author=row["author"],
            published_at=published_at,
            tags=tuple(filter(None, row["tags"].split(","))),
            source_collection=row["source_collection"],
        )
