# Phase 0 findings

## Library loading and audio URLs

- The plain page and Capacitor build fetch `library/playlist.json` relative to the page. The
  browser version attaches user-selected `File` objects through the file/folder pickers; the
  generated mobile bundle places the playlist and audio beside `index.html`.
- The desktop preload exposes `libraryBaseUrl`, so the engine streams
  `library/audio/<encoded filename>` from Electron's loopback server. Non-desktop pages use the
  relative `bundledBase` value `library/audio/`; the engine does not depend on a late-injected
  Capacitor global.
- Selected browser files use object URLs and are matched case-insensitively by basename (with a
  stem fallback).

## Persistence

The only existing `localStorage` keys are:

- `localMusic.session.v2`: shuffle mode, repeat mode, last track filename, last position, volume,
  the last 40 played track keys, and an update timestamp.
- `localMusic.playlists.v1`: an array of `{ id, name, keys, createdAt }` playlist records, where
  `keys` are the same track filenames used by the playlist export.

Storage failures are caught and surfaced through a banner; playback continues without persistence.

## Desktop bridge and IPC

`preload.js` exposes `window.localMusic` with `platform`, `libraryBaseUrl`, `startImport(link)`,
`cancelImport()`, `openLibraryFolder()`, `fetchRecommendations(limit)`, `onImportEvent(callback)`,
and `onMenuAction(callback)`. The callable methods use `ipcRenderer.invoke` for
`import:start`, `import:cancel`, `library:open`, and `recommend:fetch`; the two listener helpers
subscribe to `import:event` and `menu:action` and return unsubscribe functions.

`main.js` handles those four invoke channels, validates playlist-link length and scheme before
spawning the importer, streams importer stdout/stderr as `import:event` payloads, and forwards menu
actions as `menu:action`. The HTTP server serves only the player, `ui/`, and the selected
`library/` subtree with a resolved-path traversal guard and explicit MIME types.

## On-disk contracts and importer behavior

`library/playlist.json` contains `{ version, generatedAt, trackCount, tracks[] }`. Each track has
`title`, `artist`, `fileName`, `path` (`audio/<file>`), and `duration`, in manifest order. The
manifest is keyed by the normalized `artist - title` string and stores source identity, filename,
duration, score, size, origin, and input order.

Candidate scoring starts from title similarity (up to 55 points), rewards exact/contained titles,
artist/channel matches, Topic/official/VEVO channels, official audio, and close duration. It applies
the configured noise penalties only when the wanted title does not contain the same noise term, so
`Live Forever` is not penalized for `live`. Live/upcoming entries are discarded, and the default
minimum accepted score is 25.

Writes use temporary files, `fsync`, and `os.replace`. A download is staged under `library/.tmp/`
and moved into `library/audio/` only after transcoding; the manifest and exports are rewritten after
successful tracks. Failures are capped in `failed.json` with the top candidates. A rerun skips a
manifest entry only when its audio file still exists (unless `--force` is used); missing files are
downloaded again. Ctrl+C saves the current manifest and exports and exits 130.

## Compatibility and generated files

The UI keeps the Android WebView workarounds already present: a global `[hidden]` rule,
`setChildren()` when `replaceChildren()` is unavailable, the BMP-safe initials regex instead of
Unicode property escapes, and explicit fallbacks for `aspect-ratio`, `inset`, and `clamp`.

The source files are `player.html`, `ui/`, `desktop/`, `importer.py`, and
`scripts/sync-web.mjs`. `www/`, `android/app/src/main/assets/public/`, `dist/`, `.toolchain/`, and
the importer-owned `library/*.json` files are generated or runtime outputs and must not be edited
by hand. Any new desktop runtime asset must be added to `package.json`'s `build.extraResources`.

## Item 1 measurements

- Baseline command: `python importer.py --input baseline-songs.txt --limit 10 --force --sleep 0
  --verbose`.
- Baseline: 10/10 downloads, 437.64 seconds wall clock; the complete candidate/score/per-track log
  is retained in the session artifact `baseline-import.log`. The baseline library passed
  `python importer.py --verify`.
- Labelled offline fixture: 25 tracks covering easy, ambiguous, remix/live/cover, duration-confuser,
  accent, and non-Latin cases. The original scorer selected 2/25 labelled candidates (8%); the
  revised scorer selected 25/25 (100%).
- Optimized command: the same input and `--force`, with four workers, flat-search caching, and
  `--verbose`. The final run completed 10/10 in 97.83 seconds wall clock (about 4.5x faster than
  baseline); the first-download event occurred at 0.1 seconds. Per-track elapsed times ranged from
  21.6 to 48.3 seconds and the selected candidates, scores, runner-up margins, and transient retry
  are in the session artifact `item1-import-final.log`.
- The ten-line file contains hand-entered duration hints, so importer verification uses a 10-second
  tolerance for those hints while authoritative API/JSON durations retain the approximately
  five-second tolerance. This avoids rejecting the correct upload when a human hint is rounded while
  still rejecting materially wrong versions. The final library contains 54 tracks and passed
  `python importer.py --verify`.
