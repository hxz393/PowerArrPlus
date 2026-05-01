"""Local filter service for Prowlarr search results."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import os
import re
import socket
import sqlite3
import sys
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol


DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 17896
DEFAULT_STORE = "sqlite"
DEFAULT_DB_PATH = "data/powerarrplus.sqlite3"
DEFAULT_REDIS_HOST = "127.0.0.1"
DEFAULT_REDIS_PORT = 6379
DEFAULT_KEY_PREFIX = "powerarr_plus:prowlarr_seen_filter"
SQLITE_QUERY_CHUNK_SIZE = 900

SENSITIVE_QUERY_KEYS = {
    "apikey",
    "api_key",
    "key",
    "passkey",
    "token",
    "auth",
    "sid",
    "session",
}


def _bulk(value: Any) -> bytes:
    if value is None:
        data = b""
    elif isinstance(value, bytes):
        data = value
    else:
        data = str(value).encode("utf-8")

    return b"$" + str(len(data)).encode("ascii") + b"\r\n" + data + b"\r\n"


def encode_command(*args: Any) -> bytes:
    return b"*" + str(len(args)).encode("ascii") + b"\r\n" + b"".join(
        _bulk(arg) for arg in args
    )


class RedisProtocolError(RuntimeError):
    """Raised when Redis returns an unexpected or error response."""


class RedisClient:
    def __init__(self, host: str, port: int, timeout: float = 3.0) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout

    def command(self, *args: Any) -> Any:
        return self.pipeline([args])[0]

    def pipeline(self, commands: list[tuple[Any, ...]]) -> list[Any]:
        if not commands:
            return []

        with socket.create_connection(
            (self.host, self.port), timeout=self.timeout
        ) as conn:
            conn.settimeout(self.timeout)
            stream = conn.makefile("rb")
            conn.sendall(b"".join(encode_command(*command) for command in commands))
            return [self._read_response(stream) for _ in commands]

    def _read_response(self, stream: Any) -> Any:
        prefix = stream.read(1)
        if not prefix:
            raise RedisProtocolError("empty Redis response")

        if prefix == b"+":
            return stream.readline().rstrip(b"\r\n").decode("utf-8", "replace")

        if prefix == b"-":
            message = stream.readline().rstrip(b"\r\n").decode("utf-8", "replace")
            raise RedisProtocolError(message)

        if prefix == b":":
            return int(stream.readline().rstrip(b"\r\n"))

        if prefix == b"$":
            length = int(stream.readline().rstrip(b"\r\n"))
            if length == -1:
                return None
            data = stream.read(length)
            stream.read(2)
            return data.decode("utf-8", "replace")

        if prefix == b"*":
            length = int(stream.readline().rstrip(b"\r\n"))
            if length == -1:
                return None
            return [self._read_response(stream) for _ in range(length)]

        raise RedisProtocolError(f"unexpected Redis response prefix: {prefix!r}")


def normalize_title(title: Any) -> str:
    text = "" if title is None else str(title)
    text = text.strip().lower()
    text = re.sub(r"\s+", " ", text)
    return text


def normalize_url_for_key(url: Any) -> str:
    if not url:
        return ""

    parsed = urllib.parse.urlsplit(str(url).strip())
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    filtered_query = urllib.parse.urlencode(
        [
            (key, value)
            for key, value in query_pairs
            if key.lower() not in SENSITIVE_QUERY_KEYS
        ],
        doseq=True,
    )

    return urllib.parse.urlunsplit(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path,
            filtered_query,
            "",
        )
    )


def release_key_material(release: dict[str, Any]) -> str:
    indexer_id = str(release.get("indexerId") or "")

    info_hash = release.get("infoHash")
    if info_hash:
        return f"infohash:{str(info_hash).strip().lower()}"

    guid = release.get("guid")
    if guid:
        return f"guid:{indexer_id}:{str(guid).strip()}"

    release_hash = release.get("releaseHash")
    if release_hash:
        return f"releasehash:{indexer_id}:{str(release_hash).strip()}"

    info_url = normalize_url_for_key(release.get("infoUrl"))
    if info_url:
        return f"infourl:{indexer_id}:{info_url}"

    title = normalize_title(release.get("title") or release.get("sortTitle"))
    size = str(release.get("size") or "")
    return f"title-size:{indexer_id}:{title}:{size}"


def fingerprint_release(release: dict[str, Any]) -> str:
    material = release_key_material(release)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def release_metadata(release: dict[str, Any], fingerprint: str) -> dict[str, Any]:
    return {
        "fingerprint": fingerprint,
        "hiddenAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "title": release.get("title"),
        "sortTitle": release.get("sortTitle"),
        "indexer": release.get("indexer"),
        "indexerId": release.get("indexerId"),
        "size": release.get("size"),
        "files": release.get("files"),
        "protocol": release.get("protocol"),
        "publishDate": release.get("publishDate"),
        "age": release.get("age"),
        "grabs": release.get("grabs"),
        "seeders": release.get("seeders"),
        "leechers": release.get("leechers"),
        "keyMaterialType": release_key_material(release).split(":", 1)[0],
    }


def chunked(items: list[Any], size: int) -> list[list[Any]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def release_protocol(release: dict[str, Any]) -> str:
    return normalize_title(release.get("protocol"))


def is_nzb_release(release: dict[str, Any]) -> bool:
    return release_protocol(release) in {"nzb", "usenet"}


def date_ordinal(value: Any) -> int | None:
    if not value:
        return None

    text = str(value).strip()
    if not text:
        return None

    if text.endswith("Z"):
        text = text[:-1] + "+00:00"

    parsed: dt.datetime | None = None
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        try:
            parsed = dt.datetime.strptime(text[:10], "%Y-%m-%d")
        except ValueError:
            return None

    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(dt.timezone.utc)
    return parsed.date().toordinal()


def release_publish_day(
    release: dict[str, Any], now: dt.datetime | None = None
) -> int | None:
    for key in ("publishDate", "publish_date", "postedDate", "date"):
        day = date_ordinal(release.get(key))
        if day is not None:
            return day

    age = optional_int(release.get("age"))
    if age is None:
        return None

    reference_day = date_ordinal(release.get("hiddenAt"))
    if reference_day is None:
        reference = now or dt.datetime.now(dt.timezone.utc)
        reference_day = reference.astimezone(dt.timezone.utc).date().toordinal()
    return reference_day - age


def duplicate_signature(
    release: dict[str, Any], now: dt.datetime | None = None
) -> tuple[int, int, int] | None:
    if not is_nzb_release(release):
        return None

    size = optional_int(release.get("size"))
    files = optional_int(release.get("files"))
    publish_day = release_publish_day(release, now)
    if size is None or files is None or publish_day is None:
        return None

    return size, files, publish_day


def signatures_match(
    left: tuple[int, int, int], right: tuple[int, int, int]
) -> bool:
    return left[0] == right[0] and left[1] == right[1] and abs(left[2] - right[2]) <= 1


def duplicate_signature_candidates(
    releases: list[dict[str, Any]],
    fingerprints: list[str],
    exact_hidden: set[str],
    now: dt.datetime,
) -> tuple[list[tuple[int, tuple[int, int, int]]], set[tuple[int, int]]]:
    candidates: list[tuple[int, tuple[int, int, int]]] = []
    pairs: set[tuple[int, int]] = set()
    for index, (release, fingerprint) in enumerate(zip(releases, fingerprints)):
        if fingerprint in exact_hidden:
            continue
        signature = duplicate_signature(release, now)
        if signature is None:
            continue
        candidates.append((index, signature))
        pairs.add((signature[0], signature[1]))
    return candidates, pairs


def find_duplicate_signature_matches(
    candidates: list[tuple[int, tuple[int, int, int]]],
    hidden_by_pair: dict[tuple[int, int], list[tuple[str, tuple[int, int, int]]]],
) -> dict[int, str]:
    matches: dict[int, str] = {}
    for index, signature in candidates:
        pair = (signature[0], signature[1])
        for fingerprint, hidden_signature in hidden_by_pair.get(pair, []):
            if signatures_match(signature, hidden_signature):
                matches[index] = fingerprint
                break
    return matches


def file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except FileNotFoundError:
        return 0


def file_mtime_iso(path: Path) -> str | None:
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return None
    return dt.datetime.fromtimestamp(mtime, dt.timezone.utc).isoformat()


def metadata_column_values(metadata: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(metadata["fingerprint"]),
        str(
            metadata.get("hiddenAt")
            or dt.datetime.now(dt.timezone.utc).isoformat()
        ),
        metadata.get("title"),
        metadata.get("sortTitle"),
        metadata.get("indexer"),
        None if metadata.get("indexerId") is None else str(metadata.get("indexerId")),
        optional_int(metadata.get("size")),
        optional_int(metadata.get("files")),
        metadata.get("keyMaterialType"),
        json.dumps(metadata, ensure_ascii=False, sort_keys=True),
    )


def hidden_summary(
    release: dict[str, Any], fingerprint: str
) -> dict[str, Any]:
    return {
        "fingerprint": fingerprint,
        "title": release.get("title"),
        "indexer": release.get("indexer"),
        "indexerId": release.get("indexerId"),
        "size": release.get("size"),
        "files": release.get("files"),
        "protocol": release.get("protocol"),
        "publishDate": release.get("publishDate"),
        "age": release.get("age"),
    }


class ReleaseStore(Protocol):
    name: str

    def ping(self) -> Any:
        ...

    def stats(self) -> dict[str, Any]:
        ...

    def filter_releases(self, releases: list[dict[str, Any]]) -> dict[str, Any]:
        ...

    def hide_releases(self, releases: list[dict[str, Any]]) -> dict[str, Any]:
        ...

    def unhide(self, fingerprints: list[str]) -> dict[str, Any]:
        ...


class RedisSeenStore:
    name = "redis"

    def __init__(self, redis: RedisClient, key_prefix: str) -> None:
        self.redis = redis
        self.hidden_key = f"{key_prefix}:hidden:v1"
        self.meta_prefix = f"{key_prefix}:meta:v1"

    def ping(self) -> Any:
        return self.redis.command("PING")

    def stats(self) -> dict[str, Any]:
        return {
            "hiddenCount": self.redis.command("SCARD", self.hidden_key),
            "hiddenKey": self.hidden_key,
            "metaPrefix": self.meta_prefix,
            "redisHost": self.redis.host,
            "redisPort": self.redis.port,
        }

    def _signature_matches(
        self,
        releases: list[dict[str, Any]],
        fingerprints: list[str],
        exact_hidden: set[str],
    ) -> dict[int, str]:
        now = dt.datetime.now(dt.timezone.utc)
        candidates, candidate_pairs = duplicate_signature_candidates(
            releases, fingerprints, exact_hidden, now
        )
        if not candidates:
            return {}

        hidden_by_pair: dict[tuple[int, int], list[tuple[str, tuple[int, int, int]]]] = {}
        cursor = "0"
        while True:
            result = self.redis.command("SSCAN", self.hidden_key, cursor, "COUNT", 1000)
            if not isinstance(result, list) or len(result) != 2:
                raise RedisProtocolError("unexpected Redis SSCAN response")

            cursor = str(result[0])
            hidden_fingerprints = [str(fp) for fp in (result[1] or [])]
            if hidden_fingerprints:
                raw_metadata = self.redis.pipeline(
                    [
                        ("GET", f"{self.meta_prefix}:{fingerprint}")
                        for fingerprint in hidden_fingerprints
                    ]
                )
                for fingerprint, raw in zip(hidden_fingerprints, raw_metadata):
                    metadata, _problem = metadata_from_redis(fingerprint, raw, now.isoformat())
                    signature = duplicate_signature(metadata, now)
                    if signature is None:
                        continue
                    pair = (signature[0], signature[1])
                    if pair in candidate_pairs:
                        hidden_by_pair.setdefault(pair, []).append((fingerprint, signature))

            if cursor == "0":
                break

        return find_duplicate_signature_matches(candidates, hidden_by_pair)

    def filter_releases(self, releases: list[dict[str, Any]]) -> dict[str, Any]:
        fingerprints = [fingerprint_release(release) for release in releases]
        commands = [("SISMEMBER", self.hidden_key, fp) for fp in fingerprints]
        hidden_flags = self.redis.pipeline(commands) if commands else []
        exact_hidden = {
            fingerprint
            for fingerprint, flag in zip(fingerprints, hidden_flags)
            if int(flag) == 1
        }
        signature_matches = self._signature_matches(releases, fingerprints, exact_hidden)

        visible: list[dict[str, Any]] = []
        hidden: list[dict[str, Any]] = []
        for index, (release, fingerprint) in enumerate(zip(releases, fingerprints)):
            matched_fingerprint = (
                fingerprint if fingerprint in exact_hidden else signature_matches.get(index)
            )
            if matched_fingerprint:
                hidden.append(hidden_summary(release, matched_fingerprint))
            else:
                copied = dict(release)
                copied["_seenFilterFingerprint"] = fingerprint
                visible.append(copied)

        return {
            "total": len(releases),
            "visible": visible,
            "hidden": hidden,
            "hiddenCount": len(hidden),
        }

    def hide_releases(self, releases: list[dict[str, Any]]) -> dict[str, Any]:
        commands: list[tuple[Any, ...]] = []
        hidden: list[dict[str, Any]] = []
        for release in releases:
            fingerprint = fingerprint_release(release)
            metadata = release_metadata(release, fingerprint)
            commands.append(("SADD", self.hidden_key, fingerprint))
            commands.append(
                (
                    "SET",
                    f"{self.meta_prefix}:{fingerprint}",
                    json.dumps(metadata, ensure_ascii=False, sort_keys=True),
                )
            )
            hidden.append(metadata)

        if commands:
            self.redis.pipeline(commands)

        return {"hiddenCount": len(hidden), "hidden": hidden}

    def unhide(self, fingerprints: list[str]) -> dict[str, Any]:
        commands: list[tuple[Any, ...]] = []
        for fingerprint in fingerprints:
            commands.append(("SREM", self.hidden_key, fingerprint))
            commands.append(("DEL", f"{self.meta_prefix}:{fingerprint}"))

        if commands:
            self.redis.pipeline(commands)

        return {"unhiddenCount": len(fingerprints), "fingerprints": fingerprints}


SeenStore = RedisSeenStore


class SQLiteSeenStore:
    name = "sqlite"

    def __init__(self, db_path: str | os.PathLike[str]) -> None:
        self.db_path = Path(db_path)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        if str(self.db_path) != ":memory:":
            self.db_path.parent.mkdir(parents=True, exist_ok=True)

        conn = sqlite3.connect(self.db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        return conn

    @contextmanager
    def _connection(self) -> Any:
        conn = self._connect()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        with self._connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS hidden_release (
                    fingerprint TEXT PRIMARY KEY,
                    hidden_at TEXT NOT NULL,
                    title TEXT,
                    sort_title TEXT,
                    indexer TEXT,
                    indexer_id TEXT,
                    size INTEGER,
                    files INTEGER,
                    key_material_type TEXT,
                    metadata_json TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_hidden_release_hidden_at
                ON hidden_release(hidden_at)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_hidden_release_indexer_id
                ON hidden_release(indexer_id)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_hidden_release_size_files
                ON hidden_release(size, files)
                """
            )

    def ping(self) -> str:
        with self._connection() as conn:
            conn.execute("SELECT 1").fetchone()
        return "OK"

    def stats(self) -> dict[str, Any]:
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT
                    COUNT(*) AS hidden_count,
                    MIN(hidden_at) AS oldest_hidden_at,
                    MAX(hidden_at) AS newest_hidden_at
                FROM hidden_release
                """
            ).fetchone()
            page_size = int(conn.execute("PRAGMA page_size").fetchone()[0])
            page_count = int(conn.execute("PRAGMA page_count").fetchone()[0])
            freelist_count = int(
                conn.execute("PRAGMA freelist_count").fetchone()[0]
            )
            user_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            journal_mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0])
            sqlite_version = str(
                conn.execute("SELECT sqlite_version()").fetchone()[0]
            )

        wal_path = Path(str(self.db_path) + "-wal")
        shm_path = Path(str(self.db_path) + "-shm")
        db_size = file_size(self.db_path)
        wal_size = file_size(wal_path)
        shm_size = file_size(shm_path)

        return {
            "hiddenCount": int(row["hidden_count"]),
            "oldestHiddenAt": row["oldest_hidden_at"],
            "newestHiddenAt": row["newest_hidden_at"],
            "dbPath": str(self.db_path),
            "dbExists": self.db_path.exists(),
            "dbSizeBytes": db_size,
            "walSizeBytes": wal_size,
            "shmSizeBytes": shm_size,
            "totalSizeBytes": db_size + wal_size + shm_size,
            "dbModifiedAt": file_mtime_iso(self.db_path),
            "walModifiedAt": file_mtime_iso(wal_path),
            "sqliteVersion": sqlite_version,
            "journalMode": journal_mode,
            "pageSize": page_size,
            "pageCount": page_count,
            "freelistCount": freelist_count,
            "userVersion": user_version,
        }

    def _signature_matches(
        self,
        releases: list[dict[str, Any]],
        fingerprints: list[str],
        exact_hidden: set[str],
        conn: sqlite3.Connection,
    ) -> dict[int, str]:
        now = dt.datetime.now(dt.timezone.utc)
        candidates, candidate_pairs = duplicate_signature_candidates(
            releases, fingerprints, exact_hidden, now
        )
        if not candidates:
            return {}

        hidden_by_pair: dict[tuple[int, int], list[tuple[str, tuple[int, int, int]]]] = {}
        pair_batch_size = max(1, SQLITE_QUERY_CHUNK_SIZE // 2)
        for batch in chunked(sorted(candidate_pairs), pair_batch_size):
            clause = " OR ".join("(size = ? AND files = ?)" for _ in batch)
            params: list[Any] = []
            for size, files in batch:
                params.extend([size, files])

            rows = conn.execute(
                f"""
                SELECT fingerprint, metadata_json
                FROM hidden_release
                WHERE {clause}
                """,
                params,
            ).fetchall()
            for row in rows:
                try:
                    metadata = json.loads(str(row["metadata_json"]))
                except json.JSONDecodeError:
                    continue
                if not isinstance(metadata, dict):
                    continue

                signature = duplicate_signature(metadata, now)
                if signature is None:
                    continue
                pair = (signature[0], signature[1])
                hidden_by_pair.setdefault(pair, []).append(
                    (str(row["fingerprint"]), signature)
                )

        return find_duplicate_signature_matches(candidates, hidden_by_pair)

    def filter_releases(self, releases: list[dict[str, Any]]) -> dict[str, Any]:
        fingerprints = [fingerprint_release(release) for release in releases]
        hidden_fingerprints: set[str] = set()
        signature_matches: dict[int, str] = {}

        if fingerprints:
            with self._connection() as conn:
                for batch in chunked(fingerprints, SQLITE_QUERY_CHUNK_SIZE):
                    placeholders = ",".join("?" for _ in batch)
                    rows = conn.execute(
                        """
                        SELECT fingerprint FROM hidden_release
                        WHERE fingerprint IN (
                        """
                        + placeholders
                        + ")",
                        batch,
                    ).fetchall()
                    hidden_fingerprints.update(str(row["fingerprint"]) for row in rows)
                signature_matches = self._signature_matches(
                    releases, fingerprints, hidden_fingerprints, conn
                )

        visible: list[dict[str, Any]] = []
        hidden: list[dict[str, Any]] = []
        for index, (release, fingerprint) in enumerate(zip(releases, fingerprints)):
            matched_fingerprint = (
                fingerprint
                if fingerprint in hidden_fingerprints
                else signature_matches.get(index)
            )
            if matched_fingerprint:
                hidden.append(hidden_summary(release, matched_fingerprint))
            else:
                copied = dict(release)
                copied["_seenFilterFingerprint"] = fingerprint
                visible.append(copied)

        return {
            "total": len(releases),
            "visible": visible,
            "hidden": hidden,
            "hiddenCount": len(hidden),
        }

    def hide_releases(self, releases: list[dict[str, Any]]) -> dict[str, Any]:
        hidden: list[dict[str, Any]] = []
        for release in releases:
            fingerprint = fingerprint_release(release)
            hidden.append(release_metadata(release, fingerprint))

        self.upsert_metadata_batch(hidden)
        return {"hiddenCount": len(hidden), "hidden": hidden}

    def upsert_metadata_batch(self, metadata_items: list[dict[str, Any]]) -> None:
        if not metadata_items:
            return

        with self._connection() as conn:
            conn.executemany(
                """
                INSERT INTO hidden_release (
                    fingerprint,
                    hidden_at,
                    title,
                    sort_title,
                    indexer,
                    indexer_id,
                    size,
                    files,
                    key_material_type,
                    metadata_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(fingerprint) DO UPDATE SET
                    hidden_at = excluded.hidden_at,
                    title = excluded.title,
                    sort_title = excluded.sort_title,
                    indexer = excluded.indexer,
                    indexer_id = excluded.indexer_id,
                    size = excluded.size,
                    files = excluded.files,
                    key_material_type = excluded.key_material_type,
                    metadata_json = excluded.metadata_json
                """,
                [metadata_column_values(metadata) for metadata in metadata_items],
            )

    def unhide(self, fingerprints: list[str]) -> dict[str, Any]:
        clean = [str(fingerprint) for fingerprint in fingerprints]
        if clean:
            with self._connection() as conn:
                for batch in chunked(clean, SQLITE_QUERY_CHUNK_SIZE):
                    placeholders = ",".join("?" for _ in batch)
                    conn.execute(
                        "DELETE FROM hidden_release WHERE fingerprint IN ("
                        + placeholders
                        + ")",
                        batch,
                    )

        return {"unhiddenCount": len(clean), "fingerprints": clean}


def extract_releases(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        releases = payload
    elif isinstance(payload, dict):
        releases = (
            payload.get("releases")
            or payload.get("results")
            or payload.get("items")
            or []
        )
    else:
        raise ValueError("expected a JSON array or object")

    if not isinstance(releases, list):
        raise ValueError("releases must be an array")

    clean: list[dict[str, Any]] = []
    for item in releases:
        if isinstance(item, dict):
            clean.append(item)
    return clean


def create_store(args: argparse.Namespace) -> ReleaseStore:
    if args.store == "redis":
        return RedisSeenStore(
            RedisClient(args.redis_host, args.redis_port), args.key_prefix
        )
    if args.store == "sqlite":
        return SQLiteSeenStore(args.db_path)
    raise ValueError(f"unsupported store: {args.store}")


def metadata_from_redis(
    fingerprint: str, raw: Any, now_iso: str
) -> tuple[dict[str, Any], str | None]:
    if raw is None:
        return (
            {
                "fingerprint": fingerprint,
                "hiddenAt": now_iso,
                "keyMaterialType": "unknown",
            },
            "missing",
        )

    try:
        metadata = json.loads(str(raw))
    except json.JSONDecodeError:
        return (
            {
                "fingerprint": fingerprint,
                "hiddenAt": now_iso,
                "keyMaterialType": "unknown",
                "legacyMetadata": str(raw),
            },
            "invalid",
        )

    if not isinstance(metadata, dict):
        return (
            {
                "fingerprint": fingerprint,
                "hiddenAt": now_iso,
                "keyMaterialType": "unknown",
                "legacyMetadata": metadata,
            },
            "invalid",
        )

    metadata["fingerprint"] = str(metadata.get("fingerprint") or fingerprint)
    metadata["hiddenAt"] = metadata.get("hiddenAt") or now_iso
    return metadata, None


def migrate_redis_to_sqlite(
    redis_store: RedisSeenStore,
    sqlite_store: SQLiteSeenStore,
    batch_size: int,
) -> dict[str, Any]:
    batch_size = max(1, int(batch_size))
    cursor = "0"
    migrated = 0
    missing_metadata = 0
    invalid_metadata = 0

    while True:
        result = redis_store.redis.command(
            "SSCAN", redis_store.hidden_key, cursor, "COUNT", batch_size
        )
        if not isinstance(result, list) or len(result) != 2:
            raise RedisProtocolError("unexpected Redis SSCAN response")

        cursor = str(result[0])
        fingerprints = [str(fingerprint) for fingerprint in (result[1] or [])]
        if fingerprints:
            raw_metadata = redis_store.redis.pipeline(
                [
                    ("GET", f"{redis_store.meta_prefix}:{fingerprint}")
                    for fingerprint in fingerprints
                ]
            )
            now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
            metadata_batch: list[dict[str, Any]] = []
            for fingerprint, raw in zip(fingerprints, raw_metadata):
                metadata, problem = metadata_from_redis(fingerprint, raw, now_iso)
                if problem == "missing":
                    missing_metadata += 1
                elif problem == "invalid":
                    invalid_metadata += 1
                metadata_batch.append(metadata)

            sqlite_store.upsert_metadata_batch(metadata_batch)
            migrated += len(metadata_batch)

        if cursor == "0":
            break

    return {
        "migrated": migrated,
        "missingMetadata": missing_metadata,
        "invalidMetadata": invalid_metadata,
        "redisHiddenCount": redis_store.stats()["hiddenCount"],
        "sqliteHiddenCount": sqlite_store.stats()["hiddenCount"],
        "dbPath": str(sqlite_store.db_path),
    }


def make_handler(
    store: ReleaseStore, allow_origin: str
) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "PowerArrPlus/1.0.0"

        def do_OPTIONS(self) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            self._send_common_headers()
            self.end_headers()

        def do_GET(self) -> None:
            try:
                path = urllib.parse.urlsplit(self.path).path
                if path in {"/health", "/api/health"}:
                    result = {
                        "ok": True,
                        "store": store.name,
                        "status": store.ping(),
                    }
                elif path == "/api/stats":
                    result = {"ok": True, "store": store.name, **store.stats()}
                else:
                    self._send_error(HTTPStatus.NOT_FOUND, "unknown endpoint")
                    return

                self._send_json(result)
            except Exception as exc:
                self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

        def do_POST(self) -> None:
            try:
                path = urllib.parse.urlsplit(self.path).path
                payload = self._read_json()

                if path == "/api/filter":
                    result = store.filter_releases(extract_releases(payload))
                elif path == "/api/hide":
                    result = store.hide_releases(extract_releases(payload))
                elif path == "/api/unhide":
                    fingerprints = []
                    if isinstance(payload, dict):
                        fingerprints = payload.get("fingerprints") or []
                    if not isinstance(fingerprints, list):
                        raise ValueError("fingerprints must be an array")
                    result = store.unhide([str(fp) for fp in fingerprints])
                else:
                    self._send_error(HTTPStatus.NOT_FOUND, "unknown endpoint")
                    return

                self._send_json({"ok": True, **result})
            except ValueError as exc:
                self._send_error(HTTPStatus.BAD_REQUEST, str(exc))
            except Exception as exc:
                self._send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stderr.write(
                "%s - - [%s] %s\n"
                % (self.address_string(), self.log_date_time_string(), fmt % args)
            )

        def _read_json(self) -> Any:
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length)
            if not raw:
                return None
            return json.loads(raw.decode("utf-8-sig"))

        def _send_common_headers(self) -> None:
            self.send_header("Access-Control-Allow-Origin", allow_origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")

        def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._send_common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_error(self, status: int, message: str) -> None:
            self._send_json({"ok": False, "error": message}, status)

    return Handler


def self_test() -> None:
    sample = {
        "guid": "abc",
        "indexerId": 1,
        "title": "Example Release",
        "size": 123,
        "downloadUrl": "https://example.invalid/download?apikey=secret",
    }
    fp1 = fingerprint_release(sample)
    fp2 = fingerprint_release({**sample, "downloadUrl": "changed"})
    assert fp1 == fp2
    assert len(fp1) == 64
    assert release_key_material({"infoHash": "ABCDEF"}).startswith("infohash:abcdef")
    print("self-test ok")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--store",
        choices=("sqlite", "redis"),
        default=os.getenv("POWERARR_PLUS_STORE", DEFAULT_STORE),
        help="persistent storage backend",
    )
    parser.add_argument(
        "--db-path",
        default=os.getenv("POWERARR_PLUS_DB_PATH", DEFAULT_DB_PATH),
        help="SQLite database path when --store=sqlite",
    )
    parser.add_argument("--bind", default=os.getenv("POWERARR_PLUS_BIND", DEFAULT_BIND))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("POWERARR_PLUS_PORT", str(DEFAULT_PORT))),
    )
    parser.add_argument(
        "--redis-host",
        default=os.getenv("POWERARR_PLUS_REDIS_HOST", DEFAULT_REDIS_HOST),
    )
    parser.add_argument(
        "--redis-port",
        type=int,
        default=int(os.getenv("POWERARR_PLUS_REDIS_PORT", str(DEFAULT_REDIS_PORT))),
    )
    parser.add_argument(
        "--key-prefix",
        default=os.getenv("POWERARR_PLUS_KEY_PREFIX", DEFAULT_KEY_PREFIX),
    )
    parser.add_argument(
        "--allow-origin",
        default=os.getenv("POWERARR_PLUS_ALLOW_ORIGIN", "*"),
    )
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--test-redis", action="store_true")
    parser.add_argument("--test-store", action="store_true")
    parser.add_argument(
        "--migrate-redis-to-sqlite",
        action="store_true",
        help="copy hidden fingerprints and metadata from Redis into SQLite, then exit",
    )
    parser.add_argument(
        "--migration-batch-size",
        type=int,
        default=int(os.getenv("POWERARR_PLUS_MIGRATION_BATCH_SIZE", "1000")),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.self_test:
        self_test()
        return 0

    if args.test_redis:
        redis = RedisClient(args.redis_host, args.redis_port)
        store = RedisSeenStore(redis, args.key_prefix)
        print(json.dumps({"redis": store.ping(), **store.stats()}, ensure_ascii=False))
        return 0

    if args.migrate_redis_to_sqlite:
        redis_store = RedisSeenStore(
            RedisClient(args.redis_host, args.redis_port), args.key_prefix
        )
        sqlite_store = SQLiteSeenStore(args.db_path)
        result = migrate_redis_to_sqlite(
            redis_store, sqlite_store, args.migration_batch_size
        )
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        return 0

    store = create_store(args)

    if args.test_store:
        print(
            json.dumps(
                {"store": store.name, "status": store.ping(), **store.stats()},
                ensure_ascii=False,
            )
        )
        return 0

    handler = make_handler(store, args.allow_origin)
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    store_detail = (
        f"db_path={args.db_path}"
        if store.name == "sqlite"
        else f"redis={args.redis_host}:{args.redis_port}; key_prefix={args.key_prefix}"
    )
    print(
        f"listening on http://{args.bind}:{args.port}; "
        f"store={store.name}; {store_detail}",
        flush=True,
    )
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
