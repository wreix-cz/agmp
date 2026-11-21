import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("local_music_importer", ROOT / "importer.py")
IMPORTER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = IMPORTER
SPEC.loader.exec_module(IMPORTER)


class ImporterMatchingTests(unittest.TestCase):
    def test_version_qualifiers_are_penalized_without_breaking_parentheses(self):
        wanted = IMPORTER.Track("Artist", "Song")
        clean = IMPORTER.Candidate("clean", "Artist - Song (Official Audio)", "Artist - Topic", 210, "")
        live = IMPORTER.Candidate("live", "Artist - Song (Live)", "Artist", 210, "")

        clean_score = IMPORTER.score_candidate(clean, wanted, 210)
        live_score = IMPORTER.score_candidate(live, wanted, 210)

        self.assertGreater(clean_score, live_score)
        self.assertIn("penalty: live", live.notes)

    def test_duration_prefilter_removes_far_candidates(self):
        wanted = IMPORTER.Track("Artist", "Song", duration=200)
        close = IMPORTER.Candidate("close", "Artist - Song", "Artist", 201, "")
        far = IMPORTER.Candidate("far", "Artist - Song", "Artist", 400, "")

        ranked = IMPORTER.rank_candidates([far, close], wanted, wanted.duration)

        self.assertEqual([candidate.video_id for candidate in ranked], ["close"])
        self.assertEqual(far.notes, ["duration pre-filter"])

    def test_hand_entered_duration_has_looser_verification_tolerance(self):
        self.assertEqual(
            IMPORTER.duration_tolerance(IMPORTER.Track("a", "b", duration=100)),
            IMPORTER.DURATION_VERIFY_TOLERANCE,
        )
        self.assertEqual(
            IMPORTER.duration_tolerance(
                IMPORTER.Track("a", "b", duration=100, duration_is_hint=True)
            ),
            IMPORTER.DURATION_HINT_TOLERANCE,
        )


class ImporterLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.library = Path(self.temp.name) / "library"
        self.audio = self.library / "audio"
        self.cover = self.library / "cover"
        self.lyrics = self.library / "lyrics"
        self.library.mkdir()
        self.audio.mkdir()
        self.cover.mkdir()
        self.lyrics.mkdir()
        self.old_values = {
            name: getattr(IMPORTER, name)
            for name in (
                "LIBRARY_DIR",
                "AUDIO_DIR",
                "COVER_DIR",
                "LYRICS_DIR",
                "MANIFEST_PATH",
                "PLAYLIST_JSON_PATH",
                "PLAYLIST_M3U8_PATH",
                "FAILED_PATH",
            )
        }
        IMPORTER.LIBRARY_DIR = self.library
        IMPORTER.AUDIO_DIR = self.audio
        IMPORTER.COVER_DIR = self.cover
        IMPORTER.LYRICS_DIR = self.lyrics
        IMPORTER.MANIFEST_PATH = self.library / "manifest.json"
        IMPORTER.PLAYLIST_JSON_PATH = self.library / "playlist.json"
        IMPORTER.PLAYLIST_M3U8_PATH = self.library / "playlist.m3u8"
        IMPORTER.FAILED_PATH = self.library / "failed.json"

    def tearDown(self):
        for name, value in self.old_values.items():
            setattr(IMPORTER, name, value)
        self.temp.cleanup()

    def test_export_contains_sync_and_asset_metadata(self):
        audio = self.audio / "Artist - Song.m4a"
        audio.write_bytes(b"audio")
        (self.cover / "song.jpg").write_bytes(b"cover")
        manifest = IMPORTER.Manifest(IMPORTER.MANIFEST_PATH)
        manifest.add(
            "artist - song",
            {
                "artist": "Artist",
                "title": "Song",
                "fileName": audio.name,
                "duration": 120,
                "cover": "cover/song.jpg",
                "lyrics": "lyrics/song.lrc",
            },
        )
        manifest.save()

        self.assertEqual(IMPORTER.export_library(manifest), 1)
        payload = json.loads(IMPORTER.PLAYLIST_JSON_PATH.read_text(encoding="utf-8"))
        track = payload["tracks"][0]
        self.assertEqual(track["syncKey"], "artist - song")
        self.assertEqual(track["sizeBytes"], 5)
        self.assertEqual(track["cover"], "cover/song.jpg")
        self.assertEqual(track["lyrics"], "lyrics/song.lrc")

    def test_remove_by_filename_removes_owned_assets_and_exports(self):
        audio = self.audio / "Artist - Song.m4a"
        audio.write_bytes(b"audio")
        cover = self.cover / "song.jpg"
        cover.write_bytes(b"cover")
        lyrics = self.lyrics / "song.lrc"
        lyrics.write_text("[00:01.00]Song\n", encoding="utf-8")
        manifest = IMPORTER.Manifest(IMPORTER.MANIFEST_PATH)
        manifest.add(
            "artist - song",
            {
                "artist": "Artist",
                "title": "Song",
                "fileName": audio.name,
                "duration": 120,
                "cover": "cover/song.jpg",
                "lyrics": "lyrics/song.lrc",
            },
        )
        manifest.save()
        IMPORTER.export_library(manifest)

        self.assertEqual(IMPORTER.remove_library_track(audio.name), 0)
        self.assertFalse(audio.exists())
        self.assertFalse(cover.exists())
        self.assertFalse(lyrics.exists())
        self.assertEqual(json.loads(IMPORTER.PLAYLIST_JSON_PATH.read_text())["tracks"], [])

    def test_attach_lyrics_updates_manifest_and_export(self):
        audio = self.audio / "Artist - Song.m4a"
        audio.write_bytes(b"audio")
        manifest = IMPORTER.Manifest(IMPORTER.MANIFEST_PATH)
        manifest.add(
            "artist - song",
            {
                "artist": "Artist",
                "title": "Song",
                "fileName": audio.name,
                "duration": 120,
            },
        )
        manifest.save()

        self.assertEqual(
            IMPORTER.attach_lyrics("artist - song", "[00:01.00]Song\n"),
            0,
        )
        lyrics = self.lyrics / "Artist - Song.lrc"
        self.assertEqual(lyrics.read_text(encoding="utf-8"), "[00:01.00]Song\n")
        record = IMPORTER.Manifest(IMPORTER.MANIFEST_PATH).tracks["artist - song"]
        self.assertEqual(record["lyrics"], "lyrics/Artist - Song.lrc")

    def test_retry_reads_only_failure_entries(self):
        IMPORTER.FAILED_PATH.write_text(
            json.dumps(
                {
                    "failures": [
                        {
                            "artist": "Artist",
                            "title": "Failed song",
                            "duration": 123,
                            "durationIsHint": True,
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        tracks = IMPORTER.retry_failed_tracks()

        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0].display, "Artist - Failed song")
        self.assertTrue(tracks[0].duration_is_hint)


if __name__ == "__main__":
    unittest.main()
