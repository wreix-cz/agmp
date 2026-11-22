#!/usr/bin/env python3
"""importer.py - local-first playlist importer, downloader and library builder.

Reads "artist - title" entries from a plain text file (songs.txt) or JSON file
(tracks.json), optionally pulls a Spotify playlist through the Web API, searches
YouTube / YouTube Music with yt-dlp, scores the candidates, downloads the best
audio stream, transcodes it to a normalized .m4a with ffmpeg, embeds metadata,
and writes an idempotent library manifest plus player-ready exports.

Nothing is uploaded anywhere. No cloud database, no always-on server, no ads.

Typical use:
    python3 importer.py https://open.spotify.com/playlist/<id>
    python3 importer.py https://music.youtube.com/playlist?list=<id>
    python3 importer.py                        # songs.txt -> library/
    python3 importer.py --input tracks.json
    python3 importer.py --export-only          # rebuild playlist.json / .m3u8
    python3 importer.py --verify               # check library integrity

Exit codes: 0 success, 1 partial failures (see library/failed.json),
2 environment or configuration problem, 130 interrupted.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Optional

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #

APP_DIR = Path(__file__).resolve().parent
# The desktop app points this at its writable user-data folder when packaged.
LIBRARY_DIR = Path(os.environ.get("LOCAL_MUSIC_LIBRARY") or (APP_DIR / "library"))
AUDIO_DIR = LIBRARY_DIR / "audio"
COVER_DIR = LIBRARY_DIR / "cover"
LYRICS_DIR = LIBRARY_DIR / "lyrics"
TMP_DIR = LIBRARY_DIR / ".tmp"
CACHE_DIR = LIBRARY_DIR / ".cache"
SEARCH_CACHE_PATH = CACHE_DIR / "search.json"

MANIFEST_PATH = LIBRARY_DIR / "manifest.json"
PLAYLIST_JSON_PATH = LIBRARY_DIR / "playlist.json"
PLAYLIST_M3U8_PATH = LIBRARY_DIR / "playlist.m3u8"
FAILED_PATH = LIBRARY_DIR / "failed.json"

DEFAULT_SONGS_PATH = APP_DIR / "songs.txt"
DEFAULT_JSON_PATH = APP_DIR / "tracks.json"

MANIFEST_VERSION = 2
DEFAULT_BITRATE = "192k"
# Chromium/Electron and Android WebView decode 48 kHz stereo AAC everywhere;
# 96 kHz (which ffmpeg's loudnorm stage produces if it is left unconstrained)
# doubles storage for no audible gain and fails on some Bluetooth/WebView paths.
TARGET_SAMPLE_RATE = 48000
TARGET_CHANNELS = 2
DEFAULT_SEARCH_RESULTS = 5
DEFAULT_MIN_SCORE = 25.0
DEFAULT_JOBS = min(4, max(1, os.cpu_count() or 1))
DEFAULT_SLEEP = 0.15
SEARCH_CACHE_TTL = 24 * 60 * 60
DURATION_VERIFY_TOLERANCE = 5.0
DURATION_HINT_TOLERANCE = 10.0
DOWNLOAD_ATTEMPTS = 3
MAX_FAILURE_RECORDS = 500
USER_AGENT = "local-music-app/1.0 (offline personal playlist importer)"

VERBOSE = False
RUN_STARTED = 0.0
FIRST_DOWNLOAD_RECORDED = False
FIRST_DOWNLOAD_LOCK = threading.Lock()
FAILURE_LOCK = threading.RLock()


# --------------------------------------------------------------------------- #
# Logging helpers
# --------------------------------------------------------------------------- #

def log(message: str, level: int = 1) -> None:
    """Print progress. Level 2 messages only appear with --verbose."""
    if level == 1 or VERBOSE:
        print(message, flush=True)


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr, flush=True)


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr, flush=True)


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def as_float(value: Any, default: float = 0.0) -> float:
    """Tolerant numeric coercion for values read back from JSON."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Text normalisation, parsing and filenames
# --------------------------------------------------------------------------- #

NOISE_PATTERNS: tuple[tuple[str, float, str], ...] = (
    (r"\blive\b", 26.0, "live"),
    (r"\bremix\b", 20.0, "remix"),
    (r"\bcover\b", 20.0, "cover"),
    (r"\bslowed\b", 26.0, "slowed"),
    (r"\breverb\b", 22.0, "reverb"),
    (r"\b8d\b", 30.0, "8d"),
    (r"\bnightcore\b", 30.0, "nightcore"),
    (r"\bsped\s*up\b", 24.0, "sped-up"),
    (r"\bspeed\s*up\b", 24.0, "speed-up"),
    (r"\binstrumental\b", 24.0, "instrumental"),
    (r"\bkaraoke\b", 30.0, "karaoke"),
    (r"\breaction\b", 35.0, "reaction"),
    (r"\btutorial\b", 30.0, "tutorial"),
    (r"\blesson\b", 30.0, "lesson"),
    (r"\bhow\s+to\s+play\b", 30.0, "how-to-play"),
    (r"\b1\s*hour\b", 30.0, "1-hour"),
    (r"\bloop(?:ed)?\b", 20.0, "loop"),
    (r"\bmashup\b", 16.0, "mashup"),
    (r"\bfull\s+album\b", 35.0, "full-album"),
    (r"\balbum\s+stream\b", 35.0, "album-stream"),
    (r"\bteaser\b", 30.0, "teaser"),
    (r"\bpreview\b", 16.0, "preview"),
    (r"\bbass\s*boost(?:ed)?\b", 20.0, "bass-boost"),
    (r"\bchipmunk\b", 30.0, "chipmunk"),
    (r"\b(?:ringtone|notification)\b", 30.0, "ringtone"),
    (r"\blyric(?:s)?\s+video\b", 8.0, "lyric-video"),
)


def strip_accents(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def normalize_text(value: str) -> str:
    """Lowercase, accent-folded, punctuation-free form used for matching."""
    if not value:
        return ""
    text = strip_accents(str(value))
    text = text.replace("\u2019", "'").replace("\u2018", "'").replace("&", " and ")
    text = re.sub(r"\((?:[^()]*)\)|\[[^\[\]]*\]", " ", text)
    text = re.sub(r"\b(?:feat|ft|featuring)\.?\s+[^,;]+", " ", text)
    text = text.casefold()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def normalize_for_scoring(value: str) -> str:
    """Normalize a title while retaining useful version qualifiers.

    ``normalize_text`` intentionally removes parenthesized content for stable
    manifest keys. Candidate ranking needs a little more information: remix,
    live and similar qualifiers must remain visible long enough to be
    penalized.
    """
    if not value:
        return ""
    text = strip_accents(str(value))
    text = (
        text.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .replace("\uff08", "(")
        .replace("\uff09", ")")
        .replace("\uff0c", ",")
        .replace("&", " and ")
    )
    text = re.sub(r"\b(?:feat|ft|featuring)\.?\b", " and ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:official\s+(?:music\s+)?video|official\s+audio)\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\bremaster(?:ed)?(?:\s+\d{4})?\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*-\s*(?:19|20)\d{2}\s*$", " ", text)
    text = re.sub(r"\bpt\.?\s*2\b", " pt 2 ", text, flags=re.IGNORECASE)
    text = text.casefold()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def normalize_for_noise(value: str) -> str:
    """Keep title qualifiers so the noise vocabulary can inspect them."""
    if not value:
        return ""
    text = strip_accents(str(value))
    text = (
        text.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .replace("\uff08", "(")
        .replace("\uff09", ")")
        .replace("\uff0c", ",")
        .replace("&", " and ")
    )
    text = text.casefold()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def track_key(artist: str, title: str) -> str:
    artist_part = normalize_text(artist)
    title_part = normalize_text(title)
    combined = f"{artist_part} - {title_part}".strip(" -")
    return combined or title_part or artist_part


def slug_filename(artist: str, title: str) -> str:
    base = f"{artist or ''} - {title}".strip(" -")
    base = base.replace("/", "-").replace("\\", "-")
    base = re.sub(r'[<>:"|?*\x00-\x1f]', "", base)
    base = re.sub(r"\s+", " ", base).strip().strip(".")
    if len(base) > 120:
        base = base[:120].rstrip(" .-")
    return f"{base or 'track'}.m4a"


DURATION_HINT_RE = re.compile(r"\s*[|;,]\s*(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)\s*$")


def extract_duration_hint(line: str) -> tuple[Optional[float], str]:
    """Split a trailing "| 3:45" / "3:45" hint off a song line."""
    match = DURATION_HINT_RE.search(line)
    if not match:
        return None, line
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2))
    seconds = int(match.group(3))
    total = hours * 3600 + minutes * 60 + seconds
    return float(total), line[: match.start()].rstrip()


def parse_songs_txt(path: Path) -> list["Track"]:
    tracks: list[Track] = []
    raw_text = path.read_text(encoding="utf-8-sig")
    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", line)
        line = re.sub(r"\s+[\u2013\u2014]\s+", " - ", line)
        line = line.replace("\t", " - ")
        duration, line = extract_duration_hint(line)

        if " - " in line:
            artist, title = line.split(" - ", 1)
        else:
            artist, title = "", line
        artist = re.sub(r"\s+", " ", artist).strip(" -")
        title = re.sub(r"\s+", " ", title).strip()
        if not title:
            continue
        tracks.append(
            Track(
                artist=artist,
                title=title,
                duration=duration,
                origin="songs.txt",
                duration_is_hint=duration is not None,
            )
        )
    return tracks


def parse_tracks_json(path: Path) -> list["Track"]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(payload, dict):
        items = payload.get("tracks") or payload.get("songs") or []
    elif isinstance(payload, list):
        items = payload
    else:
        raise ValueError("tracks JSON must be a list or an object with a 'tracks' list")

    tracks: list[Track] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        artist = item.get("artist") or item.get("channel") or ""
        if not artist and isinstance(item.get("artists"), list):
            names = []
            for entry in item["artists"]:
                if isinstance(entry, dict) and entry.get("name"):
                    names.append(str(entry["name"]))
                elif isinstance(entry, str):
                    names.append(entry)
            artist = " & ".join(names)
        title = item.get("title") or item.get("name") or item.get("track") or ""
        artist = str(artist).strip()
        title = str(title).strip()
        if not title:
            continue
        duration: Optional[float] = None
        if item.get("duration") is not None:
            try:
                duration = float(item["duration"])
            except (TypeError, ValueError):
                duration = None
        elif item.get("duration_ms") is not None:
            try:
                duration = float(item["duration_ms"]) / 1000.0
            except (TypeError, ValueError):
                duration = None
        source_id = item.get("source_id") or item.get("spotifyId") or item.get("id")
        tracks.append(
            Track(
                artist=artist,
                title=title,
                duration=duration,
                source_id=str(source_id) if source_id else None,
                isrc=str(item.get("isrc") or "") or None,
                album=str(item["album"]) if item.get("album") else None,
                origin=str(path.name),
            )
        )
    return tracks


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #

@dataclass
class Track:
    artist: str
    title: str
    duration: Optional[float] = None
    source_id: Optional[str] = None
    isrc: Optional[str] = None
    album: Optional[str] = None
    origin: str = "local"
    order: int = 0
    duration_is_hint: bool = False

    @property
    def key(self) -> str:
        return track_key(self.artist, self.title)

    @property
    def display(self) -> str:
        if self.artist:
            return f"{self.artist} - {self.title}"
        return self.title

    def search_query(self) -> str:
        return f"{self.artist} {self.title}".strip()


@dataclass
class Candidate:
    video_id: str
    title: str
    channel: str
    duration: float
    url: str
    view_count: int = 0
    thumbnail: Optional[str] = None
    isrc: Optional[str] = None
    score: float = 0.0
    notes: list[str] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.video_id,
            "title": self.title,
            "channel": self.channel,
            "duration": round(self.duration, 1) if self.duration else None,
            "score": round(self.score, 2),
            "notes": self.notes[:8],
            "url": self.url,
            "thumbnail": self.thumbnail,
            "isrc": self.isrc,
        }


class ImporterError(RuntimeError):
    """Fatal, user-facing problem."""


class SpotifyError(RuntimeError):
    """A Spotify request failed; the public embed page is worth trying instead."""


class DownloadFailure(RuntimeError):
    def __init__(self, message: str, transient: bool = False) -> None:
        super().__init__(message)
        self.transient = transient


def duration_tolerance(track: Track) -> float:
    """Return the verification tolerance for authoritative or hand-entered durations."""
    return DURATION_HINT_TOLERANCE if track.duration_is_hint else DURATION_VERIFY_TOLERANCE


# --------------------------------------------------------------------------- #
# Filesystem helpers
# --------------------------------------------------------------------------- #

def fsync_dir(path: Path) -> None:
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        fsync_dir(path.parent)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        fsync_dir(path.parent)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def ensure_layout() -> None:
    for directory in (LIBRARY_DIR, AUDIO_DIR, COVER_DIR, LYRICS_DIR, TMP_DIR, CACHE_DIR):
        directory.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------- #
# Manifest
# --------------------------------------------------------------------------- #

class Manifest:
    """Idempotent record of downloaded tracks, keyed by normalized artist-title."""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = path or MANIFEST_PATH
        self.lock = threading.RLock()
        self.data: dict[str, Any] = {"version": MANIFEST_VERSION, "updatedAt": None, "tracks": {}}
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            warn(f"manifest is unreadable ({exc}); starting a fresh one at {self.path.name}")
            backup = self.path.with_name(f"{self.path.name}.corrupt-{int(time.time())}")
            try:
                shutil.copy2(self.path, backup)
                warn(f"old manifest kept at {backup.name}")
            except OSError:
                pass
            return
        if not isinstance(payload, dict):
            warn("manifest root is not an object; ignoring it")
            return
        tracks = payload.get("tracks")
        if not isinstance(tracks, dict):
            tracks = {}
        clean_tracks: dict[str, Any] = {}
        for key, record in tracks.items():
            if isinstance(record, dict) and record.get("fileName"):
                clean_tracks[str(key)] = record
        self.data = {
            "version": MANIFEST_VERSION,
            "updatedAt": payload.get("updatedAt"),
            "tracks": clean_tracks,
        }

    def save(self) -> None:
        with self.lock:
            self.data["version"] = MANIFEST_VERSION
            self.data["updatedAt"] = iso_now()
            atomic_write_json(self.path, self.data)

    @property
    def tracks(self) -> dict[str, Any]:
        return self.data["tracks"]

    def find(self, track: Track) -> Optional[dict[str, Any]]:
        with self.lock:
            record = self.tracks.get(track.key)
            if isinstance(record, dict):
                return record
            if track.source_id:
                for candidate in self.tracks.values():
                    source = candidate.get("source") or {}
                    if str(source.get("id") or "") == str(track.source_id):
                        return candidate
        return None

    def record_for_filename(self, filename: str) -> Optional[dict[str, Any]]:
        with self.lock:
            for record in self.tracks.values():
                if str(record.get("fileName", "")).casefold() == filename.casefold():
                    return record
        return None

    def add(self, key: str, record: dict[str, Any]) -> None:
        with self.lock:
            self.tracks[key] = record

    def filename_in_use(self, filename: str, video_id: str) -> bool:
        with self.lock:
            record = self.record_for_filename(filename)
            if not record:
                return False
            source = record.get("source") or {}
            return str(source.get("id") or "") != str(video_id)

    def ordered_records(self) -> list[dict[str, Any]]:
        def sort_key(record: dict[str, Any]) -> tuple[float, str, str]:
            try:
                order = float(record.get("order", 10 ** 9))
            except (TypeError, ValueError):
                order = 10 ** 9
            return (
                order,
                str(record.get("artist") or "").casefold(),
                str(record.get("title") or "").casefold(),
            )

        with self.lock:
            return sorted(self.tracks.values(), key=sort_key)


# --------------------------------------------------------------------------- #
# Failure log
# --------------------------------------------------------------------------- #

def load_failures() -> dict[str, Any]:
    if not FAILED_PATH.exists():
        return {"version": MANIFEST_VERSION, "updatedAt": None, "failures": []}
    try:
        payload = json.loads(FAILED_PATH.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and isinstance(payload.get("failures"), list):
            return payload
    except (OSError, json.JSONDecodeError):
        pass
    return {"version": MANIFEST_VERSION, "updatedAt": None, "failures": []}


def record_failure(track: Track, reason: str, candidates: Optional[list[Candidate]] = None) -> None:
    with FAILURE_LOCK:
        payload = load_failures()
        failures = [entry for entry in payload["failures"] if isinstance(entry, dict)]
        failures = [entry for entry in failures if entry.get("key") != track.key]
        failures.append(
            {
                "key": track.key,
                "artist": track.artist,
                "title": track.title,
                "duration": track.duration,
                "sourceId": track.source_id,
                "isrc": track.isrc,
                "album": track.album,
                "origin": track.origin,
                "order": track.order,
                "durationIsHint": track.duration_is_hint,
                "reason": reason,
                "attemptedAt": iso_now(),
                "candidates": [candidate.summary() for candidate in (candidates or [])][:5],
            }
        )
        payload["failures"] = failures[-MAX_FAILURE_RECORDS:]
        payload["version"] = MANIFEST_VERSION
        payload["updatedAt"] = iso_now()
        atomic_write_json(FAILED_PATH, payload)


def clear_failure(key: str) -> None:
    with FAILURE_LOCK:
        if not FAILED_PATH.exists():
            return
        payload = load_failures()
        failures = [entry for entry in payload["failures"] if isinstance(entry, dict)]
        filtered = [entry for entry in failures if entry.get("key") != key]
        if len(filtered) == len(failures):
            return
        payload["failures"] = filtered
        payload["updatedAt"] = iso_now()
        atomic_write_json(FAILED_PATH, payload)


def remove_library_track(key: str) -> int:
    """Remove one manifest entry and its owned files, then refresh both exports."""
    manifest = Manifest()
    normalized_key = str(key or "").strip()
    record = manifest.tracks.get(normalized_key)
    if not isinstance(record, dict):
        record = manifest.record_for_filename(normalized_key)
        if record:
            normalized_key = next(
                (record_key for record_key, candidate in manifest.tracks.items() if candidate is record),
                normalized_key,
            )
    if not isinstance(record, dict):
        raise ImporterError(f"track key not found: {normalized_key}")

    filename = str(record.get("fileName") or "")
    audio_path = (AUDIO_DIR / filename).resolve()
    if audio_path.parent != AUDIO_DIR.resolve():
        raise ImporterError("manifest fileName points outside the audio directory")

    cover = str(record.get("cover") or "")
    cover_path = (LIBRARY_DIR / cover).resolve() if cover else None
    if cover_path and not str(cover_path).startswith(str(COVER_DIR.resolve()) + os.sep):
        raise ImporterError("manifest cover points outside the cover directory")
    lyrics = str(record.get("lyrics") or "")
    lyrics_path = (LIBRARY_DIR / lyrics).resolve() if lyrics else None
    if lyrics_path and not str(lyrics_path).startswith(str(LYRICS_DIR.resolve()) + os.sep):
        raise ImporterError("manifest lyrics points outside the lyrics directory")

    try:
        if audio_path.exists():
            audio_path.unlink()
        if cover_path and cover_path.exists():
            cover_path.unlink()
        if lyrics_path and lyrics_path.exists():
            lyrics_path.unlink()
        manifest.tracks.pop(normalized_key, None)
        clear_failure(normalized_key)
        manifest.save()
        export_library(manifest)
    except OSError as exc:
        raise ImporterError(f"could not remove {normalized_key}: {exc}") from exc

    print(f"Removed {record.get('artist') or 'Unknown artist'} - {record.get('title') or normalized_key}")
    return 0


def attach_lyrics(key: str, content: str) -> int:
    """Attach one user-provided LRC sidecar to an existing manifest entry."""
    normalized_key = str(key or "").strip()
    if not normalized_key:
        raise ImporterError("lyrics attachment needs a track key")
    if len(content.encode("utf-8")) > 2 * 1024 * 1024:
        raise ImporterError("lyrics file is too large (maximum 2 MiB)")

    manifest = Manifest()
    record = manifest.tracks.get(normalized_key)
    if not isinstance(record, dict):
        record = manifest.record_for_filename(normalized_key)
        if record:
            normalized_key = next(
                (record_key for record_key, candidate in manifest.tracks.items() if candidate is record),
                normalized_key,
            )
    if not isinstance(record, dict):
        raise ImporterError(f"track key not found: {normalized_key}")

    filename = Path(str(record.get("fileName") or "track.m4a")).with_suffix(".lrc").name
    path = LYRICS_DIR / filename
    atomic_write_text(path, content)
    record["lyrics"] = f"lyrics/{filename}"
    manifest.save()
    export_library(manifest)
    clear_failure(normalized_key)
    print(f"Attached lyrics to {record.get('artist') or 'Unknown artist'} - {record.get('title') or normalized_key}")
    return 0


def retry_failed_tracks() -> list[Track]:
    payload = load_failures()
    tracks: list[Track] = []
    for entry in payload.get("failures", []):
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        if not title:
            continue
        tracks.append(
            Track(
                artist=str(entry.get("artist") or "").strip(),
                title=title,
                duration=as_float(entry.get("duration")) or None,
                source_id=str(entry.get("sourceId") or "") or None,
                isrc=str(entry.get("isrc") or "") or None,
                album=str(entry.get("album") or "") or None,
                origin=str(entry.get("origin") or "retry-failed"),
                order=int(as_float(entry.get("order"), len(tracks))),
                duration_is_hint=bool(entry.get("durationIsHint")),
            )
        )
    return tracks


# --------------------------------------------------------------------------- #
# Library export (playlist.json + playlist.m3u8)
# --------------------------------------------------------------------------- #

def export_library(manifest: Manifest) -> int:
    records = [record for record in manifest.ordered_records() if record.get("fileName")]
    tracks: list[dict[str, Any]] = []
    m3u_lines: list[str] = ["#EXTM3U", "#PLAYLIST:Local Music Library"]

    for record in records:
        filename = str(record.get("fileName"))
        duration = as_float(record.get("duration"))
        title = str(record.get("title") or Path(filename).stem)
        artist = str(record.get("artist") or "Unknown artist")
        exported = {
            "title": title,
            "artist": artist,
            "fileName": filename,
            "path": f"audio/{filename}",
            "duration": round(duration, 2),
            "syncKey": track_key(artist, title),
        }
        try:
            audio_stat = (AUDIO_DIR / filename).stat()
            exported["sizeBytes"] = int(audio_stat.st_size)
            exported["modifiedAt"] = int(audio_stat.st_mtime)
        except OSError:
            pass
        for field_name in ("album", "cover", "lyrics", "needsReview"):
            if field_name in record and record.get(field_name) not in (None, ""):
                exported[field_name] = record[field_name]
        tracks.append(exported)
        seconds = int(round(duration))
        minutes, secs = divmod(seconds, 60)
        m3u_lines.append(f"#EXTINF:{minutes}:{secs:02d},{artist} - {title}")
        m3u_lines.append(f"audio/{filename}")

    atomic_write_json(
        PLAYLIST_JSON_PATH,
        {
            "version": MANIFEST_VERSION,
            "generatedAt": iso_now(),
            "trackCount": len(tracks),
            "tracks": tracks,
        },
    )
    atomic_write_text(PLAYLIST_M3U8_PATH, "\n".join(m3u_lines) + "\n")
    return len(tracks)


def backfill_covers(cookies_from_browser: Optional[str]) -> int:
    """Fetch thumbnails for existing manifest records without downloading audio."""
    manifest = Manifest()
    records = manifest.ordered_records()
    if not records:
        print("No manifest records need cover art.")
        return 0

    ensure_ytdlp()
    options = base_options(cookies_from_browser)
    options.update({"skip_download": True, "noplaylist": True, "ignoreerrors": True})
    added = 0
    with make_ytdlp(options) as ydl:
        for record in records:
            existing_cover = str(record.get("cover") or "")
            if existing_cover and (LIBRARY_DIR / existing_cover).is_file():
                continue
            source = record.get("source") or {}
            source_id = str(source.get("id") or "").strip()
            if not source_id:
                warn(f"no YouTube source id for cover art: {record.get('title') or 'untitled'}")
                continue
            track = Track(
                artist=str(record.get("artist") or ""),
                title=str(record.get("title") or ""),
                album=str(record.get("album") or "") or None,
                origin=str(record.get("origin") or "library"),
            )
            try:
                info = ydl.extract_info(
                    f"https://www.youtube.com/watch?v={urllib.parse.quote(source_id)}",
                    download=False,
                )
            except Exception as exc:  # noqa: BLE001 - yt-dlp has multiple extractor errors
                warn(f"could not fetch cover metadata for {track.display}: {exc}")
                continue
            candidate = candidate_from_info(info or {})
            cover = download_cover(candidate.thumbnail if candidate else None, track)
            if cover:
                record["cover"] = cover
                added += 1
                log(f"cover: {track.display}")
    if added:
        manifest.save()
        export_library(manifest)
    print(f"Cover art added: {added}; already present: {len(records) - added}")
    return 0 if added or all(str(record.get("cover") or "") for record in records) else 1


# --------------------------------------------------------------------------- #
# Spotify Web API
# --------------------------------------------------------------------------- #

SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_API_BASE = "https://api.spotify.com/v1"
SPOTIFY_EMBED_URL = "https://open.spotify.com/embed/{kind}/{entity_id}"
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)


def parse_spotify_reference(reference: str) -> tuple[str, str]:
    """Return (kind, id) for a Spotify playlist or album link."""
    match = re.search(r"(playlist|album)[/:]([A-Za-z0-9]+)", reference.strip())
    if match:
        return match.group(1), match.group(2)
    raise ValueError(
        "that link does not point at a Spotify playlist or album; "
        "copy the playlist link from Spotify's Share menu"
    )


class SpotifyClient:
    """Minimal client-credentials client (public playlists only, no user login)."""

    def __init__(self, client_id: str, client_secret: str, timeout: float = 30.0) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.timeout = timeout
        self._token: Optional[str] = None
        self._expires_at = 0.0

    def _authenticate(self) -> None:
        body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode("utf-8")
        request = urllib.request.Request(
            SPOTIFY_TOKEN_URL,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            raise SpotifyError(f"Spotify token request failed ({exc.code}): {detail}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise SpotifyError(f"cannot reach Spotify: {exc}") from exc

        token = payload.get("access_token")
        if not token:
            raise SpotifyError("Spotify token response did not contain access_token")
        self._token = str(token)
        self._expires_at = time.time() + float(payload.get("expires_in", 3600)) - 60.0

    def _request(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        if not self._token or time.time() >= self._expires_at:
            self._authenticate()

        url = f"{SPOTIFY_API_BASE}{path}?{urllib.parse.urlencode(params)}"
        for attempt in range(2):
            request = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Accept": "application/json",
                    "User-Agent": USER_AGENT,
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return json.load(response)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:300]
                if exc.code == 401 and attempt == 0:
                    self._token = None
                    self._authenticate()
                    continue
                if exc.code == 429 and attempt == 0:
                    retry_after = exc.headers.get("Retry-After") if exc.headers else None
                    try:
                        delay = min(30.0, max(1.0, float(retry_after or 3)))
                    except (TypeError, ValueError):
                        delay = 3.0
                    warn(f"Spotify rate limit reached; retrying in {delay:.0f}s")
                    time.sleep(delay)
                    continue
                raise SpotifyError(f"Spotify HTTP {exc.code}: {detail}") from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                raise SpotifyError(f"cannot reach Spotify: {exc}") from exc
            except json.JSONDecodeError as exc:
                raise SpotifyError(f"Spotify returned invalid JSON: {exc}") from exc

        raise SpotifyError("Spotify request failed after retry")

    def playlist_items(self, playlist_id: str, max_items: int = 1000) -> list[Track]:
        """Fetch playlist items using the 2026 /items schema, with legacy fallback."""
        tracks: list[Track] = []
        offset = 0
        page_size = 100

        while offset < max_items:
            params = {
                "limit": page_size,
                "offset": offset,
                "additional_types": "track",
            }
            payload = self._request(f"/playlists/{playlist_id}/items", params)
            entries = payload.get("items")
            if not isinstance(entries, list):
                entries = []

            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                item = entry.get("item")
                if not isinstance(item, dict):
                    item = entry.get("track")  # legacy schema
                if not isinstance(item, dict):
                    continue
                # Local files in the playlist have no YouTube equivalent.
                if entry.get("is_local") or item.get("is_local"):
                    continue
                item_type = item.get("type")
                if item_type and item_type != "track":
                    continue

                name = item.get("name")
                if not isinstance(name, str) or not name.strip():
                    continue

                artists: list[str] = []
                for artist in item.get("artists") or []:
                    if isinstance(artist, dict) and artist.get("name"):
                        artists.append(str(artist["name"]))
                    elif isinstance(artist, str):
                        artists.append(artist)

                duration: Optional[float] = None
                duration_ms = item.get("duration_ms")
                if isinstance(duration_ms, (int, float)) and duration_ms > 0:
                    duration = float(duration_ms) / 1000.0

                album_name = None
                album = item.get("album")
                if isinstance(album, dict) and album.get("name"):
                    album_name = str(album["name"])
                external_ids = item.get("external_ids")
                isrc = (
                    str(external_ids.get("isrc") or "").strip() or None
                    if isinstance(external_ids, dict)
                    else None
                )

                tracks.append(
                    Track(
                        artist=" & ".join(artists),
                        title=name.strip(),
                        duration=duration,
                        source_id=str(item.get("id") or "") or None,
                        isrc=isrc,
                        album=album_name,
                        origin="spotify",
                    )
                )
                if len(tracks) >= max_items:
                    break

            if len(entries) < page_size:
                break
            offset += page_size

        return tracks


def fetch_spotify_tracks(entity_id: str, client_id: str, client_secret: str) -> list[Track]:
    return SpotifyClient(client_id, client_secret).playlist_items(entity_id)


def primary_artist(subtitle: Any) -> str:
    """Turn the embed page's \"Artist, Artist\" subtitle into one searchable name."""
    if not isinstance(subtitle, str):
        return ""
    first = subtitle.replace("\u00a0", " ").split(",")[0]
    first = re.split(r"\s+[\u2022\u00b7]\s+", first)[0]
    return re.sub(r"\s+", " ", first).strip()


def fetch_spotify_embed_tracks(kind: str, entity_id: str) -> list[Track]:
    """Public playlists/albums without credentials: read the embed page's JSON.

    The embed exposes the first entries of a playlist (~50), which covers phone
    playlists; longer ones need SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.
    """
    url = SPOTIFY_EMBED_URL.format(kind=kind, entity_id=entity_id)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": BROWSER_USER_AGENT, "Accept-Language": "en"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            html = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise SpotifyError(f"Spotify returned HTTP {exc.code} for that link") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SpotifyError(f"cannot reach Spotify: {exc}") from exc

    match = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S
    )
    if not match:
        raise SpotifyError("the Spotify page did not contain track data")
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise SpotifyError(f"the Spotify page returned invalid JSON: {exc}") from exc

    entity: Any = payload
    for key in ("props", "pageProps", "state", "data", "entity"):
        entity = entity.get(key) if isinstance(entity, dict) else None
    if not isinstance(entity, dict):
        raise SpotifyError("the Spotify page had no playlist or album data")

    entries = entity.get("trackList")
    if not isinstance(entries, list):
        raise SpotifyError("the Spotify page had no track list")

    tracks: list[Track] = []
    total_entries = int(as_float(entity.get("total"), 0)) if entity.get("total") is not None else len(entries)
    if total_entries < len(entries):
        total_entries = len(entries)
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("entityType") or "track") != "track":
            continue
        title = str(entry.get("title") or entry.get("name") or "").strip()
        if not title:
            continue
        duration = as_float(entry.get("duration")) / 1000.0
        tracks.append(
            Track(
                artist=primary_artist(entry.get("subtitle")),
                title=title,
                duration=duration or None,
                origin="spotify",
            )
        )
    if total_entries > len(tracks) or len(entries) >= 50:
        warn(f"Spotify credentials unavailable; using public embed fallback (first {len(tracks)} of {total_entries} track(s))")
    return tracks


def load_spotify_tracks(reference: str) -> list[Track]:
    """Full playlist with credentials when configured, public embed page otherwise."""
    try:
        kind, entity_id = parse_spotify_reference(reference)
    except ValueError as exc:
        raise ImporterError(str(exc)) from exc

    client_id = os.environ.get("SPOTIFY_CLIENT_ID", "").strip()
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET", "").strip()

    # Prefer the Web API for complete playlist pagination; albums are small
    # enough for the public embed page.
    if kind == "playlist" and client_id and client_secret:
        try:
            tracks = fetch_spotify_tracks(entity_id, client_id, client_secret)
            if tracks:
                log(f"Spotify: {len(tracks)} track(s) from the Web API")
                return tracks
            warn("Spotify returned an empty playlist; trying the public page instead.")
        except SpotifyError as exc:
            warn(f"Spotify Web API failed ({exc}); trying the public page instead.")
    elif kind == "playlist":
        warn("Spotify credentials are not set; falling back to the public embed page (limited to the first ~50 tracks).")

    try:
        tracks = fetch_spotify_embed_tracks(kind, entity_id)
    except SpotifyError as exc:
        raise ImporterError(
            f"could not read that Spotify link: {exc}.\n"
            "Check that it is public and still exists. For playlists longer than about 50 "
            "tracks, set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET "
            "(https://developer.spotify.com/dashboard) and import the link again."
        ) from exc

    if not tracks:
        raise ImporterError("that Spotify playlist looks empty or private")
    log(f"Spotify: {len(tracks)} track(s) from the public playlist page")
    return tracks


def track_from_entry(entry: Any) -> Optional[Track]:
    """Map a yt-dlp playlist entry (or a plain video) onto a Track."""
    if not isinstance(entry, dict):
        return None
    raw_title = str(entry.get("title") or "").strip()
    if not raw_title:
        return None

    artist = ""
    title = raw_title
    if " - " in raw_title:
        left, right = raw_title.split(" - ", 1)
        if left.strip() and right.strip():
            artist, title = left.strip(), right.strip()
    if not artist:
        channel = str(entry.get("channel") or entry.get("uploader") or entry.get("artist") or "")
        artist = re.sub(r"\s*-\s*Topic\s*$", "", channel, flags=re.I).strip()

    duration: Optional[float] = None
    try:
        if entry.get("duration") is not None:
            duration = float(entry["duration"])
    except (TypeError, ValueError):
        duration = None

    video_id = entry.get("id")
    return Track(
        artist=artist,
        title=title,
        duration=duration,
        source_id=str(video_id) if video_id else None,
        origin="playlist",
    )


def fetch_playlist_tracks(reference: str, cookies_from_browser: Optional[str]) -> list[Track]:
    """Read a YouTube / YouTube Music playlist (or single video) with yt-dlp."""
    opts = base_options(cookies_from_browser)
    opts.update(
        {
            "skip_download": True,
            "extract_flat": "in_playlist",
            "noplaylist": False,
            "ignoreerrors": True,
        }
    )
    try:
        with make_ytdlp(opts) as ydl:
            info = ydl.extract_info(reference, download=False)
    except Exception as exc:  # noqa: BLE001 - yt-dlp raises many error types
        raise ImporterError(f"could not read that playlist link: {exc}") from exc

    if not isinstance(info, dict):
        raise ImporterError("that link did not resolve to a playlist")

    entries = info.get("entries")
    if entries is None:
        entries = [info]

    tracks = [track for track in (track_from_entry(entry) for entry in entries) if track]
    playlist_title = str(info.get("title") or "").strip()
    if playlist_title:
        log(f'Playlist "{playlist_title}": {len(tracks)} track(s)')
    return tracks


def load_reference_tracks(reference: str, cookies_from_browser: Optional[str]) -> list[Track]:
    """One link in, a track list out: Spotify link or anything yt-dlp can list."""
    text = reference.strip().strip("'\"")
    if not text:
        raise ImporterError("the playlist link is empty")
    lowered = text.casefold()
    if lowered.startswith("spotify:") or "open.spotify.com" in lowered:
        return load_spotify_tracks(text)
    if re.match(r"https?://", text, re.I):
        return fetch_playlist_tracks(text, cookies_from_browser)
    raise ImporterError(
        f"not a playlist link: {text}\n"
        "Paste an open.spotify.com, music.youtube.com or youtube.com playlist URL, "
        "or pass --input songs.txt."
    )


# --------------------------------------------------------------------------- #
# Candidate search and scoring
# --------------------------------------------------------------------------- #

def _similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def score_candidate(candidate: Candidate, wanted: Track, expected_duration: Optional[float]) -> float:
    notes: list[str] = []
    want_title = normalize_for_scoring(wanted.title)
    want_artist = normalize_for_scoring(wanted.artist)
    want_full = normalize_for_scoring(f"{wanted.artist} {wanted.title}")
    wanted_noise = normalize_for_noise(f"{wanted.artist} {wanted.title}")
    cand_title = normalize_for_scoring(candidate.title)
    cand_noise = normalize_for_noise(candidate.title)
    cand_channel = normalize_for_scoring(candidate.channel)

    similarity = _similarity(cand_title, want_full)
    score = 55.0 * similarity

    if want_title and cand_title == want_title:
        score += 30.0
        notes.append("exact title")
    elif want_title and want_title in cand_title:
        score += 8.0
        notes.append("title contained")
    elif want_title and cand_title and cand_title in want_title:
        score += 7.0
        notes.append("short title")

    if want_artist:
        if want_artist in cand_title:
            score += 8.0
            notes.append("artist in title")
        if want_artist in cand_channel:
            score += 10.0
            notes.append("artist in channel")

    if wanted.isrc and candidate.isrc:
        if wanted.isrc.casefold() == candidate.isrc.casefold():
            score += 24.0
            notes.append("isrc exact")
        else:
            score -= 12.0
            notes.append("isrc mismatch")

    if "topic" in cand_channel:
        score += 8.0
        notes.append("topic channel")
    elif "official" in cand_channel:
        score += 5.0
        notes.append("official channel")
    if "vevo" in cand_channel:
        score += 4.0
        notes.append("vevo")

    if "official audio" in cand_title:
        score += 6.0
        notes.append("official audio")
    elif "official music video" in cand_title or "official video" in cand_title:
        score += 3.0
    if "lyric" in cand_title:
        score -= 2.0

    if expected_duration and candidate.duration > 0:
        difference = abs(candidate.duration - expected_duration)
        if difference <= 2:
            score += 12.0
            notes.append("duration exact")
        elif difference <= 5:
            score += 8.0
        elif difference <= 10:
            score += 3.0
        elif difference <= 20:
            score -= 6.0
        elif difference <= 45:
            score -= 18.0
            notes.append("duration off")
        else:
            score -= 40.0
            notes.append("duration mismatch")
    elif candidate.duration > 0:
        if candidate.duration > 900:
            score -= 40.0
            notes.append("very long")
        elif candidate.duration > 600:
            score -= 15.0
        elif candidate.duration < 30:
            score -= 30.0
            notes.append("too short")

    for pattern, penalty, label in NOISE_PATTERNS:
        if re.search(pattern, cand_noise) and not re.search(pattern, wanted_noise):
            score -= penalty
            notes.append(f"penalty: {label}")

    if candidate.view_count:
        score += min(4.0, math.log10(candidate.view_count + 1))

    candidate.notes = notes
    candidate.score = score
    return score


def rank_candidates(
    candidates: Iterable[Candidate], wanted: Track, expected_duration: Optional[float]
) -> list[Candidate]:
    ranked = []
    for candidate in candidates:
        if (
            expected_duration
            and candidate.duration > 0
            and abs(candidate.duration - expected_duration) > 60
        ):
            candidate.notes = ["duration pre-filter"]
            continue
        ranked.append(candidate)
    for candidate in ranked:
        score_candidate(candidate, wanted, expected_duration)
    ranked.sort(key=lambda item: item.score, reverse=True)
    return ranked


# --------------------------------------------------------------------------- #
# yt-dlp integration
# --------------------------------------------------------------------------- #

def ensure_ytdlp() -> Any:
    try:
        import yt_dlp  # noqa: WPS433 (lazy import keeps --verify/--export-only dependency-free)
    except ImportError as exc:
        raise ImporterError(
            "yt-dlp is not installed. Install it with:\n"
            '  python3 -m pip install -U "yt-dlp[default]"\n'
            "(the [default] extra bundles the EJS challenge solver scripts; a JS runtime "
            "such as Deno or Node 22+ is still recommended)"
        ) from exc
    return yt_dlp


@lru_cache(maxsize=1)
def detect_js_runtime() -> Optional[str]:
    # Prioritised the way yt-dlp prioritises them: deno, node, quickjs, bun.
    for name in ("deno", "node", "quickjs", "bun"):
        if shutil.which(name):
            return name
    return None


def js_runtime_options() -> dict[str, Any]:
    runtime = detect_js_runtime()
    if not runtime:
        return {}
    return {
        "js_runtimes": {runtime: {"path": None}},
        "remote_components": ["ejs:github"],
    }


def make_ytdlp(opts: dict[str, Any]) -> Any:
    yt_dlp = ensure_ytdlp()
    try:
        return yt_dlp.YoutubeDL(opts)
    except TypeError:
        # Older yt-dlp builds do not know the JS-runtime options.
        cleaned = {key: value for key, value in opts.items() if key not in ("js_runtimes", "remote_components")}
        return yt_dlp.YoutubeDL(cleaned)


def base_options(cookies_from_browser: Optional[str]) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 25,
        "retries": 3,
        "fragment_retries": 3,
        "extractor_retries": 2,
        "concurrent_fragment_downloads": 4,
        "http_chunk_size": 10 * 1024 * 1024,
        "cachedir": str(CACHE_DIR),
        "ignoreerrors": False,
        "no_color": True,
    }
    runtime = js_runtime_options()
    if runtime:
        opts.update(runtime)
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser,)
    return opts


def candidate_from_info(info: dict[str, Any]) -> Optional[Candidate]:
    if not isinstance(info, dict):
        return None
    video_id = info.get("id")
    title = info.get("title")
    if not video_id or not title:
        return None

    live_status = str(info.get("live_status") or "")
    if live_status in {"is_live", "is_upcoming", "post_live"} or info.get("is_live"):
        return None

    duration_raw = info.get("duration")
    try:
        duration = float(duration_raw) if duration_raw is not None else 0.0
    except (TypeError, ValueError):
        duration = 0.0

    if duration > 7200:
        return None

    raw_url = info.get("webpage_url") or info.get("url")
    url = (
        str(raw_url)
        if isinstance(raw_url, str) and raw_url.startswith(("http://", "https://"))
        else f"https://www.youtube.com/watch?v={video_id}"
    )
    channel = info.get("channel") or info.get("uploader") or info.get("artist") or ""
    views = info.get("view_count")
    try:
        view_count = int(views) if views is not None else 0
    except (TypeError, ValueError):
        view_count = 0

    return Candidate(
        video_id=str(video_id),
        title=str(title),
        channel=str(channel),
        duration=duration,
        url=str(url),
        view_count=view_count,
        thumbnail=str(info.get("thumbnail") or "") or None,
        isrc=str(info.get("isrc") or "") or None,
    )


def _search_cache_key(query: str, expected_duration: Optional[float], count: int) -> str:
    expected = round(float(expected_duration), 1) if expected_duration else None
    return json.dumps({"query": query, "duration": expected, "count": count}, sort_keys=True)


def _candidate_from_cache(payload: Any) -> Optional[Candidate]:
    if not isinstance(payload, dict):
        return None
    return candidate_from_info(payload)


def load_search_cache() -> dict[str, Any]:
    if not SEARCH_CACHE_PATH.exists():
        return {"version": 1, "entries": {}}
    try:
        payload = json.loads(SEARCH_CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "entries": {}}
    if not isinstance(payload, dict) or not isinstance(payload.get("entries"), dict):
        return {"version": 1, "entries": {}}
    return payload


def read_cached_search(
    query: str, expected_duration: Optional[float], count: int
) -> Optional[list[Candidate]]:
    payload = load_search_cache()
    entry = payload["entries"].get(_search_cache_key(query, expected_duration, count))
    if not isinstance(entry, dict):
        return None
    if time.time() - as_float(entry.get("savedAt")) > SEARCH_CACHE_TTL:
        return None
    candidates = [_candidate_from_cache(item) for item in entry.get("candidates", [])]
    return [candidate for candidate in candidates if candidate is not None] or None


def write_cached_search(
    query: str,
    expected_duration: Optional[float],
    count: int,
    candidates: list[Candidate],
) -> None:
    payload = load_search_cache()
    entries = payload.setdefault("entries", {})
    entries[_search_cache_key(query, expected_duration, count)] = {
        "savedAt": time.time(),
        "candidates": [
            {
                "id": candidate.video_id,
                "title": candidate.title,
                "channel": candidate.channel,
                "duration": candidate.duration,
                "webpage_url": candidate.url,
                "view_count": candidate.view_count,
                "thumbnail": candidate.thumbnail,
                "isrc": candidate.isrc,
            }
            for candidate in candidates
        ],
    }
    cutoff = time.time() - SEARCH_CACHE_TTL
    payload["entries"] = {
        key: value
        for key, value in entries.items()
        if isinstance(value, dict) and as_float(value.get("savedAt")) >= cutoff
    }
    try:
        atomic_write_json(SEARCH_CACHE_PATH, payload)
    except OSError as exc:
        warn(f"could not save search cache: {exc}")


def search_candidates(
    wanted: Track,
    count: int,
    cookies_from_browser: Optional[str],
    expected_duration: Optional[float] = None,
    query_override: Optional[str] = None,
) -> tuple[list[Candidate], Optional[str]]:
    """Search ytsearchN with cheap flat extraction and a disk cache."""
    opts = base_options(cookies_from_browser)
    opts.update(
        {
            "skip_download": True,
            "extract_flat": True,
            "ignoreerrors": True,
        }
    )
    query = query_override or wanted.search_query()
    if not query:
        return [], "track has neither artist nor title"

    cached = read_cached_search(query, expected_duration, count)
    if cached is not None:
        log(f"    search cache hit ({len(cached)} candidate(s))", level=2)
        return cached, None

    try:
        with make_ytdlp(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{count}:{query}", download=False)
    except Exception as exc:  # noqa: BLE001 - yt-dlp raises many error types
        return [], f"search failed: {exc}"

    entries = (info or {}).get("entries") or []
    candidates: list[Candidate] = []
    for entry in entries:
        candidate = candidate_from_info(entry)
        if candidate:
            candidates.append(candidate)
    if not candidates:
        return [], "no search results"
    write_cached_search(query, expected_duration, count, candidates)
    return candidates, None


# --------------------------------------------------------------------------- #
# Download + transcode
# --------------------------------------------------------------------------- #

def find_ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise ImporterError(
            "ffmpeg was not found on PATH. Install it first, e.g. 'sudo apt install ffmpeg' "
            "or 'brew install ffmpeg'."
        )
    return path


def find_ffprobe() -> Optional[str]:
    return shutil.which("ffprobe")


def run_command(command: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def probe_duration(path: Path) -> Optional[float]:
    ffprobe = find_ffprobe()
    if not ffprobe:
        return None
    try:
        result = run_command(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        value = float(result.stdout.strip())
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def probe_audio_info(path: Path) -> dict[str, Any]:
    ffprobe = find_ffprobe()
    if not ffprobe:
        return {}
    try:
        result = run_command(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name,bit_rate,sample_rate,channels:format=duration",
                "-of",
                "json",
                str(path),
            ],
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    if result.returncode != 0:
        return {}
    try:
        payload = json.loads(result.stdout)
    except (TypeError, ValueError):
        return {}
    streams = payload.get("streams") if isinstance(payload, dict) else None
    stream = streams[0] if isinstance(streams, list) and streams else {}
    fmt = payload.get("format") if isinstance(payload, dict) else {}
    info: dict[str, Any] = {}
    if isinstance(stream, dict):
        info.update(stream)
    if isinstance(fmt, dict) and fmt.get("duration") is not None:
        info["duration"] = fmt.get("duration")
    return info


def bitrate_to_bps(value: str) -> Optional[int]:
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([kmg]?)\s*", str(value), re.IGNORECASE)
    if not match:
        return None
    multiplier = {"": 1, "k": 1000, "m": 1000_000, "g": 1000_000_000}[match.group(2).casefold()]
    return int(float(match.group(1)) * multiplier)


def download_audio(candidate: Candidate, work_dir: Path, cookies_from_browser: Optional[str]) -> Path:
    opts = base_options(cookies_from_browser)
    opts.update(
        {
            "format": "bestaudio/best",
            "outtmpl": str(work_dir / "source.%(ext)s"),
            "overwrites": True,
            "continuedl": True,
            "writethumbnail": False,
            "postprocessors": [],
        }
    )
    try:
        with make_ytdlp(opts) as ydl:
            ydl.download([candidate.url])
    except Exception as exc:  # noqa: BLE001
        message = str(exc)
        lowered = message.casefold()
        transient = any(
            token in lowered
            for token in (
                "timed out",
                "timeout",
                "connection reset",
                "connection aborted",
                "temporary failure",
                "http error 5",
                "http error 429",
                "too many requests",
                "fragment",
                "unable to download",
            )
        )
        raise DownloadFailure(f"yt-dlp download failed: {message}", transient=transient) from exc

    sources = sorted(work_dir.glob("source.*"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not sources:
        raise DownloadFailure("yt-dlp reported success but left no file behind", transient=True)
    return sources[0]


def transcode_to_m4a(
    source: Path,
    destination: Path,
    track: Track,
    candidate: Candidate,
    bitrate: str,
    normalize: bool,
) -> None:
    ffmpeg = find_ffmpeg()
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-map_metadata",
        "-1",
        "-metadata",
        f"title={track.title}",
        "-metadata",
        f"artist={track.artist or 'Unknown artist'}",
        "-metadata",
        f"album={track.album or 'Local Library'}",
        "-metadata",
        f"comment=Imported from {candidate.url}",
        "-metadata",
        "encoded_by=local-music-app",
        "-movflags",
        "+faststart",
    ]
    target_bitrate = bitrate_to_bps(bitrate)
    source_info = probe_audio_info(source)
    source_bitrate = as_float(source_info.get("bit_rate"))
    if (
        not normalize
        and source.suffix.casefold() in {".m4a", ".mp4", ".aac"}
        and str(source_info.get("codec_name") or "").casefold() == "aac"
        and int(as_float(source_info.get("sample_rate"))) == TARGET_SAMPLE_RATE
        and int(as_float(source_info.get("channels"))) in (1, TARGET_CHANNELS)
        and target_bitrate
        and source_bitrate
        and source_bitrate <= target_bitrate
    ):
        command.extend(["-c:a", "copy"])
    else:
        command.extend(
            [
                "-c:a",
                "aac",
                "-b:a",
                bitrate,
                "-profile:a",
                "aac_low",
                "-threads",
                "0",
            ]
        )
    if normalize:
        command.extend(["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"])
    # Must come after the filter chain: loudnorm otherwise leaves a 96 kHz stream.
    command.extend(["-ar", str(TARGET_SAMPLE_RATE), "-ac", str(TARGET_CHANNELS)])
    command.append(str(destination))

    try:
        result = run_command(command, timeout=1800)
    except subprocess.TimeoutExpired as exc:
        raise DownloadFailure("ffmpeg timed out while transcoding", transient=True) from exc
    except OSError as exc:
        raise ImporterError(f"could not run ffmpeg: {exc}") from exc

    if result.returncode != 0 or not destination.exists() or destination.stat().st_size < 1024:
        detail = (result.stderr or "").strip().splitlines()
        reason = detail[-1] if detail else f"ffmpeg exited with {result.returncode}"
        raise DownloadFailure(f"transcode failed: {reason}", transient=False)


def cover_filename(track: Track) -> str:
    return Path(slug_filename(track.artist, track.title)).with_suffix(".jpg").name


def download_cover(thumbnail: Optional[str], track: Track) -> Optional[str]:
    """Download and normalize one candidate thumbnail without failing the audio import."""
    if not thumbnail:
        return None
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        warn(f"ffmpeg is unavailable; skipping cover art for {track.display}")
        return None

    destination = COVER_DIR / cover_filename(track)
    source = COVER_DIR / f".{destination.stem}.{uuid.uuid4().hex}.source"
    converted = COVER_DIR / f".{destination.stem}.{uuid.uuid4().hex}.jpg"
    try:
        request = urllib.request.Request(thumbnail, headers={"User-Agent": BROWSER_USER_AGENT})
        with urllib.request.urlopen(request, timeout=30) as response:
            with open(source, "wb") as handle:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
        result = run_command(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-frames:v",
                "1",
                "-q:v",
                "3",
                str(converted),
            ],
            timeout=120,
        )
        if result.returncode != 0 or not converted.exists() or converted.stat().st_size < 512:
            detail = (result.stderr or "").strip().splitlines()
            warn(f"could not convert cover art for {track.display}: {detail[-1] if detail else 'ffmpeg failed'}")
            return None
        os.replace(converted, destination)
        fsync_dir(COVER_DIR)
        return f"cover/{destination.name}"
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        warn(f"could not download cover art for {track.display}: {exc}")
        return None
    finally:
        source.unlink(missing_ok=True)
        converted.unlink(missing_ok=True)


def choose_filename(manifest: Manifest, track: Track, video_id: str) -> str:
    base = slug_filename(track.artist, track.title)
    if not manifest.filename_in_use(base, video_id):
        return base
    stem = base[:-4] if base.endswith(".m4a") else base
    suffixed = f"{stem} [{video_id}].m4a"
    if not manifest.filename_in_use(suffixed, video_id):
        return suffixed
    return f"{stem} [{video_id}-{uuid.uuid4().hex[:6]}].m4a"


# --------------------------------------------------------------------------- #
# Per-track pipeline
# --------------------------------------------------------------------------- #

@dataclass
class ImportResult:
    downloaded: int = 0
    skipped: int = 0
    failed: int = 0
    failed_tracks: list[str] = field(default_factory=list)


def narrow_search_queries(track: Track) -> list[str]:
    queries: list[str] = []
    artist = track.artist.strip()
    title = track.title.strip()
    if artist and title:
        queries.append(f'"{artist}" "{title}"')
    if title and track.duration:
        queries.append(f'"{title}" {int(round(track.duration))} seconds')
    if artist:
        queries.append(f'{artist} "{title}" Topic')
    return list(dict.fromkeys(query for query in queries if query.strip()))


def note_first_download() -> None:
    global FIRST_DOWNLOAD_RECORDED
    with FIRST_DOWNLOAD_LOCK:
        if FIRST_DOWNLOAD_RECORDED:
            return
        FIRST_DOWNLOAD_RECORDED = True
        if RUN_STARTED:
            log(f"    first download after {time.perf_counter() - RUN_STARTED:.1f}s")


def jittered_sleep(base: float) -> None:
    if base <= 0:
        return
    time.sleep(random.uniform(base * 0.5, base * 1.5))


def process_track(
    track: Track,
    manifest: Manifest,
    args: argparse.Namespace,
) -> str:
    """Download one track. Returns 'downloaded', 'skipped' or 'failed'."""
    existing = manifest.find(track)
    if existing and not args.force:
        existing_path = AUDIO_DIR / str(existing.get("fileName", ""))
        if existing_path.exists() and existing_path.stat().st_size > 1024:
            log(f"    cached: {existing_path.name}")
            if track.album and not existing.get("album"):
                existing["album"] = track.album
            return "skipped"
        warn(f"manifest entry exists but the file is missing ({existing_path.name}); re-downloading")

    started = time.perf_counter()
    candidates, search_error = search_candidates(
        track,
        args.results,
        args.cookies_from_browser,
        expected_duration=track.duration,
    )
    if search_error:
        record_failure(track, search_error)
        fail(f"    {search_error}")
        return "failed"

    ranked = rank_candidates(candidates, track, track.duration)
    best = ranked[0] if ranked else None
    if best is None or best.score < args.min_score:
        for query in narrow_search_queries(track):
            narrowed, narrow_error = search_candidates(
                track,
                args.results,
                args.cookies_from_browser,
                expected_duration=track.duration,
                query_override=query,
            )
            if narrow_error:
                continue
            ranked = rank_candidates(
                {candidate.video_id: candidate for candidate in [*candidates, *narrowed]}.values(),
                track,
                track.duration,
            )
            best = ranked[0] if ranked else None
            if best and best.score >= args.min_score:
                break

    if best is None:
        record_failure(track, "no usable candidates after duration filtering", candidates)
        fail("    no usable candidates")
        return "failed"

    margin = best.score - ranked[1].score if len(ranked) > 1 else best.score
    needs_review = len(ranked) > 1 and margin < args.review_margin
    log(
        f"    best: {best.title} [{best.channel}] ({int(best.duration)}s, score {best.score:.1f}, "
        f"margin {margin:.1f})"
    )
    for candidate in ranked[1:4]:
        log(
            f"      runner-up: {candidate.title} [{candidate.channel}] score {candidate.score:.1f}",
            level=2,
        )

    if best.score < args.min_score:
        record_failure(
            track,
            f"best candidate below threshold ({best.score:.1f} < {args.min_score:.1f}); "
            "narrow searches did not improve confidence",
            ranked,
        )
        fail(f"    best score {best.score:.1f} is below --min-score {args.min_score:.1f}; skipping")
        return "failed"

    last_error: Optional[DownloadFailure] = None
    candidates_to_try = [candidate for candidate in ranked[: args.candidate_attempts] if candidate.score >= args.min_score]
    for candidate_index, candidate in enumerate(candidates_to_try):
        work_dir = TMP_DIR / uuid.uuid4().hex
        work_dir.mkdir(parents=True, exist_ok=True)
        try:
            for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
                try:
                    log(
                        f"    downloading candidate {candidate_index + 1}/{len(candidates_to_try)} "
                        f"(attempt {attempt}/{DOWNLOAD_ATTEMPTS})...",
                        level=1 if attempt == 1 else 2,
                    )
                    note_first_download()
                    source = download_audio(candidate, work_dir, args.cookies_from_browser)
                    source_info = probe_audio_info(source)
                    source_duration = (
                        as_float(source_info.get("duration"))
                        or candidate.duration
                        or probe_duration(source)
                    )
                    if (
                        track.duration
                        and source_duration
                        and abs(source_duration - track.duration) > duration_tolerance(track)
                    ):
                        raise DownloadFailure(
                            f"candidate duration {source_duration:.1f}s differs from expected "
                            f"{track.duration:.1f}s",
                            transient=False,
                        )

                    with manifest.lock:
                        filename = choose_filename(manifest, track, candidate.video_id)
                    final_path = AUDIO_DIR / filename
                    temp_output = work_dir / f"{filename}.part.m4a"
                    log("    transcoding to m4a...", level=2)
                    transcode_to_m4a(
                        source,
                        temp_output,
                        track,
                        candidate,
                        args.bitrate,
                        not args.no_normalize,
                    )
                    final_duration = probe_duration(temp_output) or source_duration or track.duration or candidate.duration
                    if find_ffprobe() and not final_duration:
                        raise DownloadFailure("transcoded audio has no readable duration", transient=False)
                    if (
                        track.duration
                        and final_duration
                        and abs(final_duration - track.duration) > duration_tolerance(track)
                    ):
                        raise DownloadFailure(
                            f"transcoded duration {final_duration:.1f}s differs from expected "
                            f"{track.duration:.1f}s",
                            transient=False,
                        )

                    cover = download_cover(candidate.thumbnail, track)
                    if not cover and existing:
                        previous_cover = str(existing.get("cover") or "")
                        previous_path = LIBRARY_DIR / previous_cover
                        if previous_cover and previous_path.is_file():
                            cover = previous_cover

                    # os.replace is atomic: the previous file survives until this point.
                    with manifest.lock:
                        os.replace(temp_output, final_path)
                        fsync_dir(AUDIO_DIR)
                        record = {
                            "key": track.key,
                            "artist": track.artist,
                            "title": track.title,
                            "album": track.album,
                            "duration": round(float(final_duration or 0.0), 2),
                            "fileName": filename,
                            "source": {
                                "provider": "youtube",
                                "id": candidate.video_id,
                                "url": candidate.url,
                                "channel": candidate.channel,
                                "isrc": candidate.isrc,
                            },
                            "score": round(candidate.score, 2),
                            "matchMargin": round(margin, 2),
                            "needsReview": needs_review,
                            "isrc": track.isrc,
                            "sizeBytes": final_path.stat().st_size,
                            "downloadedAt": iso_now(),
                            "origin": track.origin,
                            "order": track.order,
                        }
                        if cover:
                            record["cover"] = cover
                        manifest.add(track.key, record)
                        manifest.save()
                    clear_failure(track.key)
                    log(f"    saved: {filename} ({time.perf_counter() - started:.1f}s)")
                    return "downloaded"
                except DownloadFailure as exc:
                    last_error = exc
                    if not exc.transient or attempt >= DOWNLOAD_ATTEMPTS:
                        break
                    delay = min(20.0, (2 ** attempt) + random.random())
                    warn(f"transient failure ({exc}); retrying in {delay:.1f}s")
                    time.sleep(delay)
                except OSError as exc:
                    last_error = DownloadFailure(f"filesystem error: {exc}", transient=False)
                    break
            if last_error:
                warn(f"candidate {candidate.video_id} rejected: {last_error}")
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    message = str(last_error) if last_error else "all ranked candidates failed verification"
    record_failure(track, message, ranked)
    fail(f"    {message}")
    return "failed"


# --------------------------------------------------------------------------- #
# Library verification
# --------------------------------------------------------------------------- #

def library_orphans(manifest: Manifest) -> list[Path]:
    """Audio files on disk that no manifest record points at (e.g. renamed or removed)."""
    if not AUDIO_DIR.is_dir():
        return []
    with manifest.lock:
        known = {
            str(record.get("fileName") or "").casefold()
            for record in manifest.tracks.values()
        }
    return [
        path
        for path in sorted(AUDIO_DIR.iterdir())
        if path.is_file() and not path.name.startswith(".") and path.name.casefold() not in known
    ]


def prune_orphans(manifest: Manifest) -> int:
    orphans = library_orphans(manifest)
    if not orphans:
        print("No orphan audio files: every file in library/audio is referenced by the manifest.")
        return 0
    freed = 0
    removed = 0
    for path in orphans:
        try:
            size = path.stat().st_size
            path.unlink()
        except OSError as exc:
            warn(f"could not delete {path.name}: {exc}")
            continue
        freed += size
        removed += 1
        print(f"PRUNED   {path.name} ({size / (1024 * 1024):.1f} MiB, not in manifest)")
    export_library(manifest)
    print(f"Removed {removed} orphan file(s), freed {freed / (1024 * 1024):.1f} MiB")
    return 0 if removed == len(orphans) else 1


def reencode_library(sample_rate: int = TARGET_SAMPLE_RATE, bitrate: str = DEFAULT_BITRATE) -> int:
    """Re-encode existing library files to the playback-friendly format, in place and atomically."""
    manifest = Manifest()
    records = manifest.ordered_records()
    if not records:
        print("Library is empty: nothing to re-encode.")
        return 1
    ffmpeg = find_ffmpeg()
    changed = 0
    skipped = 0
    failed = 0
    freed = 0
    print(f"Re-encoding {len(records)} file(s) to {sample_rate} Hz stereo AAC {bitrate}")
    print("-" * 78)
    for record in records:
        filename = str(record.get("fileName") or "")
        path = AUDIO_DIR / filename
        label = f"{record.get('artist') or 'Unknown'} - {record.get('title') or filename}"
        if not filename or not path.is_file():
            print(f"MISSING  {label}")
            failed += 1
            continue
        info = probe_audio_info(path)
        rate = int(as_float(info.get("sample_rate")))
        channels = int(as_float(info.get("channels")))
        if (
            str(info.get("codec_name") or "").casefold() == "aac"
            and rate == sample_rate
            and channels in (1, TARGET_CHANNELS)
            and path.suffix.casefold() == ".m4a"
        ):
            skipped += 1
            continue

        before = path.stat().st_size
        temp = TMP_DIR / f".{path.stem}.{uuid.uuid4().hex}.reencode.m4a"
        source = record.get("source") or {}
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(path),
            "-vn",
            "-map_metadata",
            "-1",
            "-metadata",
            f"title={record.get('title') or ''}",
            "-metadata",
            f"artist={record.get('artist') or 'Unknown artist'}",
            "-metadata",
            f"album={record.get('album') or 'Local Library'}",
            "-metadata",
            f"comment=Imported from {source.get('url') or 'local file'}",
            "-metadata",
            "encoded_by=local-music-app",
            "-c:a",
            "aac",
            "-b:a",
            bitrate,
            "-profile:a",
            "aac_low",
            "-ar",
            str(sample_rate),
            "-ac",
            str(TARGET_CHANNELS),
            "-threads",
            "0",
            "-movflags",
            "+faststart",
            str(temp),
        ]
        try:
            result = run_command(command, timeout=1800)
        except (OSError, subprocess.TimeoutExpired) as exc:
            warn(f"{label}: {exc}")
            temp.unlink(missing_ok=True)
            failed += 1
            continue
        if result.returncode != 0 or not temp.is_file() or temp.stat().st_size < 1024:
            detail = (result.stderr or "").strip().splitlines()
            warn(f"{label}: {detail[-1] if detail else 'ffmpeg failed'}")
            temp.unlink(missing_ok=True)
            failed += 1
            continue
        duration = probe_duration(temp) or as_float(record.get("duration"))
        with manifest.lock:
            os.replace(temp, path)
            fsync_dir(AUDIO_DIR)
            record["duration"] = round(float(duration or 0.0), 2)
            record["sizeBytes"] = path.stat().st_size
            record["sampleRate"] = sample_rate
            record["reencodedAt"] = iso_now()
            manifest.save()
        freed += before - record["sizeBytes"]
        changed += 1
        log(
            f"re-encoded: {filename} "
            f"({before / (1024 * 1024):.2f} -> {record['sizeBytes'] / (1024 * 1024):.2f} MiB)"
        )
    print("-" * 78)
    if changed:
        export_library(manifest)
    print(
        f"Re-encoded {changed}; already {sample_rate} Hz {skipped}; failed {failed}; "
        f"size change {freed / (1024 * 1024):+.1f} MiB"
    )
    return 0 if failed == 0 else 1


def verify_library(manifest: Manifest) -> int:
    records = manifest.ordered_records()
    if not records:
        print("Library is empty: library/manifest.json has no tracks yet.")
        print('Run "python3 importer.py" to build it.')
        return 1

    problems = 0
    print(f"Verifying {len(records)} manifest entries in {AUDIO_DIR}")
    print("-" * 78)
    for record in records:
        filename = str(record.get("fileName") or "")
        path = AUDIO_DIR / filename
        label = f"{record.get('artist') or 'Unknown'} - {record.get('title') or filename}"
        if not path.exists():
            print(f"MISSING  {label}")
            print(f"         expected file: {path.name}")
            problems += 1
            continue
        size = path.stat().st_size
        if size < 1024:
            print(f"TRUNCATED {label} ({size} bytes)")
            problems += 1
            continue
        duration = probe_duration(path)
        stored = as_float(record.get("duration"))
        duration_text = f"{duration:.1f}s" if duration else "duration unknown"
        note = ""
        if duration and stored and abs(duration - stored) > 3:
            note = f" (manifest says {stored:.1f}s)"
        print(f"OK       {label}  [{size / (1024 * 1024):.1f} MiB, {duration_text}]{note}")

    for path in library_orphans(manifest):
        print(f"ORPHAN   {path.name} ({path.stat().st_size / (1024 * 1024):.1f} MiB, not in manifest)")
        problems += 1
    if library_orphans(manifest):
        print("         remove these with --prune-orphans")

    print("-" * 78)
    try:
        exported = export_library(manifest)
        print(f"Exports refreshed: playlist.json ({exported} tracks) and playlist.m3u8")
    except OSError as exc:
        warn(f"could not refresh exports: {exc}")
        problems += 1

    if problems:
        fail(f"{problems} problem(s) found. Re-run the importer (without --force) to refill missing files.")
        return 1
    print("All tracks verified.")
    return 0


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="importer.py",
        description="Build a fully offline music library from a playlist file or Spotify playlist.",
        epilog=(
            "Examples:\n"
            "  python3 importer.py https://open.spotify.com/playlist/<id>\n"
            "  python3 importer.py https://music.youtube.com/playlist?list=<id>\n"
            "  python3 importer.py\n"
            "  python3 importer.py --input tracks.json --limit 10\n"
            "  python3 importer.py --export-only\n"
            "  python3 importer.py --verify\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "link",
        nargs="?",
        help="Spotify or YouTube (Music) playlist/album link to import",
    )
    parser.add_argument(
        "--input",
        type=Path,
        help="songs.txt or tracks.json to import (default: songs.txt, else tracks.json)",
    )
    parser.add_argument(
        "--source",
        choices=("auto", "songs", "json"),
        default="auto",
        help="local track list to use when no playlist link is given (default: auto)",
    )
    parser.add_argument(
        "--playlist",
        metavar="URL",
        help="same as the positional playlist link",
    )
    parser.add_argument("--limit", type=int, default=0, help="import at most N tracks (0 = all)")
    parser.add_argument("--results", type=int, default=DEFAULT_SEARCH_RESULTS, help="search results to score (default: 5)")
    parser.add_argument("--min-score", type=float, default=DEFAULT_MIN_SCORE, help="reject candidates below this score (default: 25)")
    parser.add_argument("--bitrate", default=DEFAULT_BITRATE, help="AAC bitrate for the m4a output (default: 192k)")
    parser.add_argument("--no-normalize", action="store_true", help="skip EBU R128 loudness normalisation")
    parser.add_argument("--force", action="store_true", help="re-download tracks even if they are already in the library")
    parser.add_argument("--dry-run", action="store_true", help="print the resolved track list without downloading")
    parser.add_argument("--export-only", action="store_true", help="only regenerate playlist.json and playlist.m3u8")
    parser.add_argument("--verify", action="store_true", help="check the library files and refresh exports")
    parser.add_argument(
        "--prune-orphans",
        action="store_true",
        help="delete audio files in library/audio that the manifest does not reference",
    )
    parser.add_argument(
        "--reencode",
        action="store_true",
        help=f"re-encode library files to {TARGET_SAMPLE_RATE} Hz stereo AAC in place",
    )
    parser.add_argument("--covers", action="store_true", help="backfill missing cover art from manifest source ids")
    parser.add_argument("--remove", metavar="KEY", help="remove one normalized track key and its owned files")
    parser.add_argument("--attach-lyrics", metavar="KEY", help="read an LRC sidecar from stdin and attach it to a track")
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="retry exactly the entries currently recorded in library/failed.json",
    )
    parser.add_argument(
        "--recommend",
        nargs="?",
        const=12,
        type=int,
        metavar="N",
        help="print N online recommendations as JSON (YouTube Music radio for your newest tracks)",
    )
    parser.add_argument("--cookies-from-browser", metavar="BROWSER", help="pass cookies from a browser (chrome, firefox, edge, ...) for restricted videos")
    parser.add_argument(
        "--sleep",
        type=float,
        default=DEFAULT_SLEEP,
        help="jittered delay between worker downloads in seconds (default: 0.15; 0 disables it)",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=DEFAULT_JOBS,
        help=f"parallel download workers (default: {DEFAULT_JOBS})",
    )
    parser.add_argument(
        "--candidate-attempts",
        type=int,
        default=3,
        help="ranked candidates to try when download verification fails (default: 3)",
    )
    parser.add_argument(
        "--review-margin",
        type=float,
        default=8.0,
        help="mark a manifest entry needsReview when the top score margin is below this value",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="show extra detail")
    return parser


def resolve_input(args: argparse.Namespace) -> Path:
    if args.input:
        return args.input
    if args.source == "json":
        return DEFAULT_JSON_PATH
    if args.source == "songs":
        return DEFAULT_SONGS_PATH
    if DEFAULT_SONGS_PATH.exists():
        return DEFAULT_SONGS_PATH
    return DEFAULT_JSON_PATH


def load_track_list(args: argparse.Namespace) -> list[Track]:
    reference = (args.playlist or args.link or "").strip()
    if args.retry_failed:
        tracks = retry_failed_tracks()
        if not tracks:
            raise ImporterError("library/failed.json has no retryable entries")
    elif reference:
        tracks = load_reference_tracks(reference, args.cookies_from_browser)
        if not tracks:
            raise ImporterError("that playlist did not contain any usable track")
    else:
        path = resolve_input(args)
        if not path.exists():
            raise ImporterError(
                f"track list not found: {path}\n"
                f'Create {DEFAULT_SONGS_PATH.name} with one "Artist - Title" per line, '
                "or pass --input <file>."
            )
        suffix = path.suffix.casefold()
        if suffix not in {".json", ".txt", ".m3u", ".m3u8", ""}:
            raise ImporterError(f"unsupported track list format: {path.suffix} (use .txt or .json)")
        try:
            tracks = parse_tracks_json(path) if suffix == ".json" else parse_songs_txt(path)
        except (OSError, ValueError) as exc:
            raise ImporterError(f"could not read {path.name}: {exc}") from exc

    # De-duplicate by normalized key while preserving order.
    seen: set[str] = set()
    unique: list[Track] = []
    for index, track in enumerate(tracks):
        if not track.title.strip():
            continue
        if track.key in seen:
            log(f"Skipping duplicate entry: {track.display}", level=2)
            continue
        seen.add(track.key)
        track.order = index
        unique.append(track)

    if args.limit and args.limit > 0:
        unique = unique[: args.limit]

    return unique


def run_import(args: argparse.Namespace) -> int:
    global FIRST_DOWNLOAD_RECORDED, RUN_STARTED
    manifest = Manifest()
    tracks = load_track_list(args)

    if not tracks:
        raise ImporterError("the track list is empty; add at least one line to songs.txt")

    # Keep each list's own order, but never reshuffle tracks that are already in
    # the library: a newly imported playlist appends after what is there.
    offset = len(manifest.tracks)
    for index, track in enumerate(tracks):
        if manifest.find(track) is None:
            track.order = offset + index

    log(f"Loaded {len(tracks)} track(s) to import")
    log(f"Library: {LIBRARY_DIR}")

    if args.dry_run:
        print()
        for index, track in enumerate(tracks, 1):
            duration = f"  [{int(track.duration)}s]" if track.duration else ""
            print(f"{index:>3}. {track.display}{duration}   (key: {track.key})")
        print()
        print("Dry run only: nothing was downloaded.")
        return 0

    ensure_ytdlp()
    find_ffmpeg()
    runtime = detect_js_runtime()
    if runtime:
        log(f"JS runtime for yt-dlp: {runtime}")
    else:
        warn(
            "no JavaScript runtime found (deno/node/quickjs). YouTube may withhold some formats. "
            "Install Deno (recommended) or Node 22+ for full support."
        )

    started = time.time()
    RUN_STARTED = time.perf_counter()
    FIRST_DOWNLOAD_RECORDED = False
    result = ImportResult()
    total = len(tracks)

    def process_one(index: int, track: Track) -> tuple[int, str]:
        log("")
        log(f"[{index}/{total}] {track.display}")
        outcome = process_track(track, manifest, args)
        if outcome != "skipped":
            jittered_sleep(args.sleep)
        return index, outcome

    try:
        worker_count = min(args.jobs, total)
        log(f"Workers: {worker_count}")
        if worker_count == 1:
            outcomes = [process_one(index, track) for index, track in enumerate(tracks, 1)]
        else:
            executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=worker_count,
                thread_name_prefix="local-music-import",
            )
            futures = [
                executor.submit(process_one, index, track)
                for index, track in enumerate(tracks, 1)
            ]
            try:
                outcomes = [future.result() for future in concurrent.futures.as_completed(futures)]
            except KeyboardInterrupt:
                for future in futures:
                    future.cancel()
                executor.shutdown(wait=False, cancel_futures=True)
                raise
            else:
                executor.shutdown(wait=True)

        for _, outcome in outcomes:
            if outcome == "downloaded":
                result.downloaded += 1
            elif outcome == "skipped":
                result.skipped += 1
            else:
                result.failed += 1
        result.failed_tracks = [
            track.display
            for track in tracks
            if manifest.find(track) is None
        ][: result.failed]
    except KeyboardInterrupt:
        warn("interrupted; saving what has been downloaded so far")
        manifest.save()
        export_library(manifest)
        elapsed = time.time() - started
        print(f"\nInterrupted after {elapsed:.1f}s. Library has {len(manifest.tracks)} track(s).")
        return 130

    exported = export_library(manifest)
    manifest.save()
    elapsed = time.time() - started

    print()
    print("=" * 72)
    print(f"Downloaded: {result.downloaded}   Already present: {result.skipped}   Failed: {result.failed}")
    print(f"Library: {len(manifest.tracks)} track(s), playlist export holds {exported} track(s)")
    print(f"Elapsed: {elapsed:.1f}s")
    print(f"Audio:   {AUDIO_DIR}")
    print(f"Exports: {PLAYLIST_JSON_PATH.name}, {PLAYLIST_M3U8_PATH.name}")

    if result.failed:
        print(f"Failures: {FAILED_PATH} ({result.failed} entr(y/ies))")
        for display in result.failed_tracks[:10]:
            print(f"  - {display}")
        if len(result.failed_tracks) > 10:
            print(f"  ... and {len(result.failed_tracks) - 10} more")
        print("\nRe-run the importer to retry failures; successful tracks are skipped automatically.")
        return 1

    print("\nDone. Open the player:")
    print("  python3 -m http.server 8000")
    print("  http://localhost:8000/player.html")
    return 0


def build_recommendations(limit: int, cookies_from_browser: Optional[str]) -> list[dict[str, Any]]:
    """Related tracks for the newest library entries, via YouTube Music radio."""
    manifest = Manifest()
    records = [
        record
        for record in manifest.tracks.values()
        if isinstance(record, dict) and str((record.get("source") or {}).get("id") or "").strip()
    ]
    if not records:
        raise ImporterError("no track with a YouTube source in the library yet; import a playlist first")

    # Newest downloads are the best guess at what the listener wants next.
    seeds = sorted(records, key=lambda record: str(record.get("downloadedAt") or ""), reverse=True)[:3]
    known_ids = {str((record.get("source") or {}).get("id")) for record in records}

    options = base_options(cookies_from_browser)
    options.update(
        {
            "skip_download": True,
            "extract_flat": "in_playlist",
            "noplaylist": False,
            "ignoreerrors": True,
        }
    )

    picks: list[dict[str, Any]] = []
    seen: set[str] = set()

    with make_ytdlp(options) as ydl:
        for seed in seeds:
            if len(picks) >= limit:
                break
            video_id = str((seed.get("source") or {}).get("id"))
            reference = f"https://www.youtube.com/watch?v={video_id}&list=RDAMVM{video_id}"
            try:
                info = ydl.extract_info(reference, download=False)
            except Exception as exc:  # noqa: BLE001 - yt-dlp raises many error types
                warn(f"skipping radio for {seed.get('artist')} - {seed.get('title')}: {exc}")
                continue

            entries = info.get("entries") if isinstance(info, dict) else None
            for entry in entries or []:
                if len(picks) >= limit:
                    break
                track = track_from_entry(entry)
                if not track or not track.source_id:
                    continue
                if track.source_id in known_ids or track.source_id in seen:
                    continue
                if manifest.find(track) is not None:
                    continue
                duration = track.duration or 0.0
                if duration and not 30 <= duration <= 900:
                    continue
                seen.add(track.source_id)
                picks.append(
                    {
                        "videoId": track.source_id,
                        "title": track.title,
                        "artist": track.artist or str(seed.get("artist") or ""),
                        "duration": round(float(duration), 1),
                        "url": f"https://music.youtube.com/watch?v={track.source_id}",
                        "seed": f"{seed.get('artist')} - {seed.get('title')}",
                    }
                )

    return picks


def run_recommend(args: argparse.Namespace) -> int:
    """Print recommendations as JSON; logs go to stderr so stdout stays parseable."""
    limit = max(1, min(int(args.recommend), 30))
    ensure_ytdlp()
    with contextlib.redirect_stdout(sys.stderr):
        picks = build_recommendations(limit, args.cookies_from_browser)
    print(json.dumps(picks, ensure_ascii=False))
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    global VERBOSE
    parser = build_parser()
    args = parser.parse_args(argv)
    VERBOSE = bool(args.verbose)

    if args.limit < 0:
        parser.error("--limit must be 0 or greater")
    if args.results < 1:
        parser.error("--results must be at least 1")
    if args.sleep < 0:
        parser.error("--sleep must not be negative")
    if args.jobs < 1:
        parser.error("--jobs must be at least 1")
    if args.candidate_attempts < 1:
        parser.error("--candidate-attempts must be at least 1")
    if args.review_margin < 0:
        parser.error("--review-margin must not be negative")

    try:
        ensure_layout()
        if args.recommend is not None:
            return run_recommend(args)
        if args.remove:
            if args.input or args.link or args.playlist or args.retry_failed or args.attach_lyrics:
                parser.error("--remove cannot be combined with an input, playlist link, or --retry-failed")
            return remove_library_track(args.remove)
        if args.attach_lyrics:
            if args.input or args.link or args.playlist or args.retry_failed or args.remove:
                parser.error("--attach-lyrics cannot be combined with an input, playlist link, --remove, or --retry-failed")
            return attach_lyrics(args.attach_lyrics, sys.stdin.read())
        if args.covers:
            if args.input or args.link or args.playlist or args.retry_failed:
                parser.error("--covers cannot be combined with an input, playlist link, or --retry-failed")
            return backfill_covers(args.cookies_from_browser)
        if args.reencode:
            if args.input or args.link or args.playlist or args.retry_failed or args.remove or args.attach_lyrics:
                parser.error("--reencode cannot be combined with an import, --remove, or --attach-lyrics")
            return reencode_library(bitrate=args.bitrate)
        if args.prune_orphans:
            if args.input or args.link or args.playlist or args.retry_failed:
                parser.error("--prune-orphans cannot be combined with an input or playlist link")
            return prune_orphans(Manifest())
        if args.export_only:
            manifest = Manifest()
            count = export_library(manifest)
            manifest.save()
            print(f"Exported {count} track(s) to {PLAYLIST_JSON_PATH.name} and {PLAYLIST_M3U8_PATH.name}")
            return 0
        if args.verify:
            return verify_library(Manifest())
        return run_import(args)
    except ImporterError as exc:
        fail(str(exc))
        return 2
    except OSError as exc:
        fail(f"filesystem error: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
