import json
import tempfile
import unittest
from pathlib import Path

from powerarr_plus.seen_filter_service import (
    RedisSeenStore,
    SQLiteSeenStore,
    fingerprint_release,
    migrate_redis_to_sqlite,
    normalize_url_for_key,
    release_key_material,
)


class FakeRedisClient:
    def __init__(self) -> None:
        self.host = "127.0.0.1"
        self.port = 6379
        self.sets: dict[str, set[str]] = {}
        self.values: dict[str, str] = {}

    def command(self, *args):
        return self.pipeline([args])[0]

    def pipeline(self, commands):
        results = []
        for command in commands:
            op = str(command[0]).upper()
            if op == "PING":
                results.append("PONG")
            elif op == "SCARD":
                results.append(len(self.sets.get(str(command[1]), set())))
            elif op == "SISMEMBER":
                results.append(
                    1
                    if str(command[2]) in self.sets.get(str(command[1]), set())
                    else 0
                )
            elif op == "SADD":
                self.sets.setdefault(str(command[1]), set()).add(str(command[2]))
                results.append(1)
            elif op == "SREM":
                self.sets.setdefault(str(command[1]), set()).discard(str(command[2]))
                results.append(1)
            elif op == "SET":
                self.values[str(command[1])] = str(command[2])
                results.append("OK")
            elif op == "GET":
                results.append(self.values.get(str(command[1])))
            elif op == "DEL":
                results.append(1 if self.values.pop(str(command[1]), None) is not None else 0)
            elif op == "SSCAN":
                results.append(["0", sorted(self.sets.get(str(command[1]), set()))])
            else:
                raise AssertionError(f"unexpected command: {command!r}")
        return results


class SeenFilterTests(unittest.TestCase):
    def test_download_url_does_not_affect_fingerprint(self) -> None:
        release = {
            "guid": "abc",
            "indexerId": 7,
            "title": "Example.Release.2026",
            "size": 123,
            "downloadUrl": "https://example.invalid/a?apikey=secret",
        }

        changed = {
            **release,
            "downloadUrl": "https://example.invalid/a?apikey=different",
        }

        self.assertEqual(fingerprint_release(release), fingerprint_release(changed))

    def test_info_hash_wins_and_is_normalized(self) -> None:
        material = release_key_material(
            {
                "infoHash": "ABCDEF",
                "guid": "ignored",
                "indexerId": 1,
            }
        )

        self.assertEqual(material, "infohash:abcdef")

    def test_sensitive_query_params_are_removed_from_info_url_key(self) -> None:
        normalized = normalize_url_for_key(
            "HTTPS://Example.Invalid/path?apikey=secret&token=t&keep=1#fragment"
        )

        self.assertEqual(normalized, "https://example.invalid/path?keep=1")

    def test_fallback_uses_normalized_title_and_size(self) -> None:
        material = release_key_material(
            {"indexerId": 9, "title": "  Example   Release  ", "size": 42}
        )

        self.assertEqual(material, "title-size:9:example release:42")

    def test_sqlite_store_hides_filters_and_unhides(self) -> None:
        release = {
            "guid": "release-a",
            "indexerId": 1,
            "title": "Example.Release.2026",
            "indexer": "IndexerA",
            "size": 100,
            "files": 12,
        }
        other_release = {
            "guid": "release-b",
            "indexerId": 1,
            "title": "Other.Release.2026",
            "indexer": "IndexerA",
            "size": 200,
            "files": 3,
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            store = SQLiteSeenStore(Path(temp_dir) / "powerarrplus.sqlite3")

            hide_result = store.hide_releases([release])
            self.assertEqual(hide_result["hiddenCount"], 1)
            stats = store.stats()
            self.assertEqual(stats["hiddenCount"], 1)
            self.assertTrue(stats["dbExists"])
            self.assertGreater(stats["dbSizeBytes"], 0)
            self.assertEqual(stats["journalMode"], "wal")
            self.assertIsNotNone(stats["newestHiddenAt"])
            self.assertIn("sqliteVersion", stats)

            filter_result = store.filter_releases([release, other_release])
            self.assertEqual(filter_result["hiddenCount"], 1)
            self.assertEqual(len(filter_result["visible"]), 1)
            self.assertEqual(
                filter_result["visible"][0]["_seenFilterFingerprint"],
                fingerprint_release(other_release),
            )

            store.unhide([fingerprint_release(release)])
            filter_result = store.filter_releases([release, other_release])
            self.assertEqual(filter_result["hiddenCount"], 0)
            self.assertEqual(len(filter_result["visible"]), 2)

    def test_migrates_redis_metadata_to_sqlite(self) -> None:
        redis = FakeRedisClient()
        redis_store = RedisSeenStore(redis, "test:prefix")
        fingerprint = "abc123"
        missing_fingerprint = "missing123"
        redis.sets[redis_store.hidden_key] = {fingerprint, missing_fingerprint}
        redis.values[f"{redis_store.meta_prefix}:{fingerprint}"] = json.dumps(
            {
                "fingerprint": fingerprint,
                "hiddenAt": "2026-01-01T00:00:00+00:00",
                "title": "Migrated.Release",
                "indexer": "IndexerA",
                "indexerId": 9,
                "size": 123,
                "files": 5,
                "keyMaterialType": "guid",
            }
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            sqlite_store = SQLiteSeenStore(Path(temp_dir) / "powerarrplus.sqlite3")
            result = migrate_redis_to_sqlite(redis_store, sqlite_store, 100)

            self.assertEqual(result["migrated"], 2)
            self.assertEqual(result["missingMetadata"], 1)
            self.assertEqual(result["sqliteHiddenCount"], 2)
            self.assertEqual(sqlite_store.stats()["hiddenCount"], 2)


if __name__ == "__main__":
    unittest.main()
