import unittest

from powerarr_plus.seen_filter_service import (
    fingerprint_release,
    normalize_url_for_key,
    release_key_material,
)


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


if __name__ == "__main__":
    unittest.main()

