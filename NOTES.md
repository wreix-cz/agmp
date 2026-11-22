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

# P0 verification pass (2026-11-22)

Measured on this host: Electron 45.4.1 with the repo's own library server, plus the Android 15 KVM
emulator (`lm35`) with the bundled Temurin 21 toolchain.

## Fixed

- **Every imported track was 96 kHz AAC.** `transcode_to_m4a` ran `loudnorm` without a resampler, so
  ffmpeg's loudnorm stage chose the output rate. All 60 files measured `aac,96000,2`. Encoding now
  forces `-ar 48000 -ac 2 -profile:a aac_low` after the filter chain, the `-c:a copy` fast path is
  only taken when the source is already 48 kHz, and `--reencode` rewrote the existing library in
  place (54 files, 0 failures, now all `aac,48000,2`). File size is unchanged — the bitrate is fixed,
  so 96 kHz cost decode work and compatibility, not disk.
- **Android could not sync at all.** Pairing failed with `Cleartext HTTP traffic to 10.0.2.2 not
  permitted`: Capacitor's manifest had no cleartext allowance. Added
  `res/xml/network_security_config.xml` plus `android:usesCleartextTraffic` /
  `android:networkSecurityConfig`. Verified end to end afterwards (see below).
- **`needsReview` never reached the UI.** Both track mappers in `engine.js` copied only a fixed field
  list, dropping the flag, so the marker could not render and the Songs search could not match it.
  Added it to both, plus a `review` tag on the row and a `needs review` search token.
- **6 orphan audio files (30.8 MiB)** were invisible to the app but shipped in the APK and every
  mobile bundle. `--verify` now reports them and `--prune-orphans` deletes them.

## Verified

- 7 importer unit tests pass; `--verify` green with 0 orphans after pruning.
- Electron: 54/54 tracks decode and play (`canplaythrough`, real `play()` advancing). The earlier
  `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` report came from a codec-less headless Chromium and a wrong
  `/audio/` URL prefix, not from the files.
- Electron UI: 54/54 rows show cover art, the `review` filter matches exactly 5 tracks, an attached
  `.lrc` renders its 5 lines and highlights the correct one at 50 s.
- Android emulator, clean install: 54 tracks, 54 covers, 5 review flags, playback advancing.
- Android playlist modal (create + add/remove), likes, manual queue (insert, reorder, remove) and a
  cold restart that restored 56 tracks, the playlist, the like and the current track.
- LAN sync against the desktop over `10.0.2.2`: pairing accepted, 55 entries transferred, the synced
  track plays; a second sync transferred **0 bytes**; a wrong pairing code is refused with HTTP 403.
- Device import through the SAF picker: an MP3 pushed to `Download/` imported with a probed duration,
  `deviceOnly: true`, and played from app-private storage.
- Test artifacts removed afterwards: the sync-test track and the temporary `.lrc` are gone, the
  library is back to 54 tracks.

## Still open

- `moveQueueKey` swaps inside the full `state.order`, so moving a manual item past the last manual
  entry silently drops it to the end of the manual block. Works, but the boundary behaviour is odd.
- First sync copies everything: the bundled APK library is not treated as already-synced storage.
- Android release signing, JDK/SDK pinning for CI, and Play-sized (slim) builds remain P1.

# Account sync (2026-11-22)

Scope decided with the user: likes, play counts and playlists sync; **audio does not**. The account is
the index, the devices keep the music.

## Shape

- `service/worker.js` — Cloudflare Worker on Freebuff Sites (preview environment), D1 for state,
  Sign in with Freebuff for identity. Schema is created idempotently on the first request because the
  deployed D1 has no SQL console.
- Device linking: `POST /api/device/start` → six-digit code → browser approves at `/link` (same-origin
  form, requires a Freebuff session) → `POST /api/device/poll` mints a 32-byte bearer token once.
  Codes expire in ten minutes, are single-use, and starts are capped at 12 per IP per hour.
- Each request is scoped by `devices.sub`; the client never sends an account id. Sign-out revokes the
  calling device row.
- Merge rules: likes are kept as a decision (`liked_at`, `decision_at`) so an unlike beats an older
  like; stats take the max of `plays`/`skips`/`seconds` so a play is never double-counted; playlists
  are last-writer-wins by `updated_at` with `deleted_at` tombstones.
- Track identity is the importer's `syncKey`, falling back to the file name. Playlist refs with no
  local file stay in `playlist.pending` and are re-sent on the next push, so importing the audio later
  restores them.

## Client

- `ui/account.js` owns sign-in, the debounced push after a local change, the push-on-launch and
  status. There is no separate read call: a push returns the merged account state.
- `desktop/account.js` performs all desktop HTTP from the main process and stores the token encrypted
  with `safeStorage`; `preload.js` exposes only the five operations, never the token.
- `ui/mobile.js` does the same through CapacitorHttp and stores the token in app-private storage;
  `@capacitor/browser` opens the sign-in page.
- The sync dialog is now the account panel (Sign in / Sync now / Sign out / LAN pairing) and reports
  how many account entries have no audio on this device.

## Verified

- Local Worker on `wrangler dev` + desktop renderer over CDP, with two device tokens for two accounts:
  signed-out `POST /api/state` → 401; unknown/expired device code → 404/410; second use of a code → 410;
  second account cannot see the first account's rows.
- Two-device convergence: like pushed, playlist created, then from the "phone" an unlike, a playlist
  delete and a new playlist with one resolvable and one missing ref. The desktop picked all of it up on
  the next sync: 0 likes, `From phone` present with 1 key, 1 pending, delete applied.
- Merge fix found by this pass: a device that already held a like decision did not re-apply the like
  after local likes were lost; `applyAccountState` now derives the like set from the winning decision.
- Panel renders correctly (signed-in line, missing-entry hint, correct button visibility).
- Artifacts rebuilt: `app-debug.apk` (230,783,669 B, includes `capacitor-browser`), AppImage
  (127,769,129 B) and RPM (91,573,289 B); `desktop/account.js` is inside `app.asar`.

## Not verified

- A real Freebuff sign-in from the desktop or Android app. The preview browser has no Freebuff session
  and redirected to the login page, so the callback → token → first sync run still needs a person to
  approve a code.
- Production deployment, the Android release build and a physical device.
