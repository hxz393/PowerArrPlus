"""Redis-backed local filter service for Prowlarr search results."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import socket
import sys
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 17896
DEFAULT_REDIS_HOST = "192.168.2.204"
DEFAULT_REDIS_PORT = 6379
DEFAULT_KEY_PREFIX = "powerarr_plus:prowlarr_seen_filter"

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
        "protocol": release.get("protocol"),
        "publishDate": release.get("publishDate"),
        "seeders": release.get("seeders"),
        "leechers": release.get("leechers"),
        "keyMaterialType": release_key_material(release).split(":", 1)[0],
    }


class SeenStore:
    def __init__(self, redis: RedisClient, key_prefix: str) -> None:
        self.redis = redis
        self.hidden_key = f"{key_prefix}:hidden:v1"
        self.meta_prefix = f"{key_prefix}:meta:v1"

    def ping(self) -> Any:
        return self.redis.command("PING")

    def stats(self) -> dict[str, Any]:
        return {"hiddenCount": self.redis.command("SCARD", self.hidden_key)}

    def filter_releases(self, releases: list[dict[str, Any]]) -> dict[str, Any]:
        fingerprints = [fingerprint_release(release) for release in releases]
        commands = [("SISMEMBER", self.hidden_key, fp) for fp in fingerprints]
        hidden_flags = self.redis.pipeline(commands) if commands else []

        visible: list[dict[str, Any]] = []
        hidden: list[dict[str, Any]] = []
        for release, fingerprint, flag in zip(releases, fingerprints, hidden_flags):
            if int(flag) == 1:
                hidden.append(
                    {
                        "fingerprint": fingerprint,
                        "title": release.get("title"),
                        "indexer": release.get("indexer"),
                        "indexerId": release.get("indexerId"),
                        "size": release.get("size"),
                    }
                )
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


def make_handler(store: SeenStore, allow_origin: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "PowerArrPlus/0.1"

        def do_OPTIONS(self) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            self._send_common_headers()
            self.end_headers()

        def do_GET(self) -> None:
            try:
                path = urllib.parse.urlsplit(self.path).path
                if path in {"/health", "/api/health"}:
                    result = {"ok": True, "redis": store.ping()}
                elif path == "/api/stats":
                    result = {"ok": True, **store.stats()}
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
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.self_test:
        self_test()
        return 0

    redis = RedisClient(args.redis_host, args.redis_port)
    store = SeenStore(redis, args.key_prefix)

    if args.test_redis:
        print(json.dumps({"redis": store.ping(), **store.stats()}, ensure_ascii=False))
        return 0

    handler = make_handler(store, args.allow_origin)
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    print(
        f"listening on http://{args.bind}:{args.port}; "
        f"redis={args.redis_host}:{args.redis_port}; "
        f"key_prefix={args.key_prefix}",
        flush=True,
    )
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

