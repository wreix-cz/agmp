# Handoff prompt — Local Music App: v1.1 complete, shipping-readiness pass

You are taking over a working, shipped application. Read this whole document, then study the code
before you change a single line. Nothing here is hypothetical: every path, command and constant below
was taken from the repository as it exists today.

Copy everything from the line **"BEGIN PROMPT"** down into the new agent. The sections above it are
context for whoever is handing this off.

---

BEGIN PROMPT

## 0. Your role and your objective

You are a senior full-stack engineer working alone in this repository. Your job is to take the
implemented Local Music App v1.1 (Electron desktop + Capacitor Android, sharing one vanilla-JS player)
through a shipping-readiness pass and produce a safe, repeatable release process for other users.

You have one rule above all others: **understand before you build.** Phase 0 is mandatory reading and
a written findings summary. Do not start Phase 1 until you have done it.

## Handoff status: v1.1 implementation has been completed

The original thirteen-item v1.1 pass is substantially implemented and has passed the verification work
listed below. Do not reimplement existing features described here unless a regression, broken
acceptance criterion, or concrete defect requires it.

**Completed implementation areas:**
- Import matching and throughput: flat YouTube extraction, disk cache, bounded workers, retries,
  duration pre-filtering, stronger scoring, runner-up margins, and fallback searches. The labelled
  matching fixture reached 100%; ten-track import improved from 437.64 to 97.83 seconds (~4.5x).
- LAN sync: Electron pairing/server, Capacitor sync client, bearer tokens, path validation, asset
  transfer, and collision-safe mobile filenames.
- Cover art: importer backfill/download/conversion, playlist metadata, renderer support, sync transfer,
  and owned-cover deletion.
- Queue: Play next, Add to queue, remove, move up/down, Clear, persistence, duplicate prevention, and
  a separate persisted manual queue that survives shuffle-mode changes.
- Likes/stats: liked/stats views, row/player likes, play/skip/listened-time totals, smart-shuffle
  weighting, `likedAt`, `lastPlayedAt`, and backward-compatible `lastPlayed` data.
- Deletion/storage: desktop confirm/delete IPC, safe audio/cover/lyrics ownership checks, export
  refresh, deleted-current-track handling, and mobile storage reporting/import helpers.
- Lyrics: `.lrc` attachment, manifest/export metadata, mobile bundling, parsing, highlighting, seeking,
  metadata-tag filtering, and owned-sidecar deletion.
- Android device import: file picker, common audio formats, private storage, 512 MiB limit,
  collision-safe filenames, filename metadata, and duration probing.
- Playback controls: speed, crossfade foundation, sleep timer, persistence, and accessible UI controls.
- OS/packaging foundations: desktop media shortcuts, second-instance handling, AppImage/RPM packaging,
  mobile web bundle generation, and Capacitor Filesystem.
- Spotify/retry: bearer authorization, richer metadata, ISRC-aware matching, retry reconstruction,
  retry-only CLI behavior, and removal/lyrics CLI operations.
- Tests/documentation: seven focused importer tests; README and NOTES updated; 54-track library and
  exports verified; mobile bundle and desktop packages rebuilt.

**Verification completed:**
- `python3 -m unittest discover -s tests -v`: 7 tests pass.
- JavaScript `node --check`, Pylance/Python syntax checks, and source `git diff --check` pass.
- `python3 importer.py --export-only && python3 importer.py --verify`: all 54 entries verify.
- `npm run sync:mobile`: passes; 54 tracks and 60 audio files, approximately 239.8 MiB.
- `npm run dist`: AppImage and RPM packaging pass.
- Browser smoke test exercised library loading, Songs/Stats, row likes, manual queue insertion, Clear,
  and reload persistence. Chromium rejects the AAC/M4A streams with
  `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`, so reliable browser/Electron playback remains unverified.
- Generated mobile source/CSS/engine files match their source counterparts.

**Environment-blocked or not yet verified:**
- Android builds require JDK 17-21; this host has JDK 25 and fails Gradle with
  `Unsupported class file major version 69`.
- A compatible JDK/Android SDK/emulator and real Android device are unavailable.
- Real LAN pairing/sync HTTP tests and partial/second-sync tests remain.
- Live cover rendering and `.lrc` display/sync remain untested because the live library has no assets.
- Real Electron playback/media-key/clean-profile and Android playback/import tests remain.
- Spotify pagination, 401 re-authentication, and 429 behavior need controlled HTTP fixtures.
- The installer/app is not yet ready for public distribution.

## Next objective: make the app safely and repeatably ship to other people

This is a shipping-readiness pass, not the original v1.1 feature pass. Do not start from a
personal-library assumption. Preserve local-first behavior and the existing vanilla-JS/Electron/
Capacitor architecture unless a concrete packaging problem requires a targeted change.

### Shipping-readiness requirements

1. **Create a first-run/setup experience**
   - Detect missing `python3`, `yt-dlp`, `ffmpeg`, credentials, and library directories.
   - Explain exactly what is missing and provide actionable setup instead of silent failure.
   - Create private desktop and app-private mobile directories automatically.
   - Never package or ship a developer's personal `library/` by default.

2. **Package backend dependencies**
   - A public desktop release cannot assume the current host has Python, yt-dlp, and ffmpeg.
   - Bundle portable dependencies or replace the importer with a packaged Node/Python backend with
     a deterministic installation path. Support Windows, macOS, and Linux paths.

3. **Convert imported audio to a dependable format**
   - Convert/re-transcode imports to browser/Electron/WebView-compatible MP3 or Opus/WebM.
   - Prevent an M4A/AAC variant from shipping if Chromium cannot decode it.
   - Verify clean desktop-browser and Android-WebView playback.

4. **Remove development credentials and secrets**
   - Do not embed Spotify credentials or API keys in source, installers, or browser storage.
   - Implement first-run credential setup or Spotify OAuth with PKCE.
   - `.gitignore` secrets and redact credentials in diagnostics/logs.

5. **Implement release identity and signing**
   - Add unique app/package IDs, author, support URL, license, icons, descriptions, and release metadata.
   - Prepare Windows Authenticode, macOS signing/notarization, Linux package signing/checksums, and
     Android release signing. Never commit secrets or a release keystore.

6. **Add a real updater**
   - Use a signed Electron update feed configured only through build-time configuration.
   - Support verification, download/install state, and safe recovery. Do not claim updater support
     unless the complete flow is implemented.

7. **Complete Android release tooling**
   - Use JDK 17-21, pinned Gradle/Android SDK configuration, release-keystore support, and a
     repeatable local/CI build.
   - Test signed APK/AAB playback, private storage, device import, permissions, reinstall/upgrade,
     restart, LAN sync, lyrics, deletion, and queue state.

8. **Harden LAN sync for public use**
   - Keep pairing opt-in and LAN-only. Continue rejecting path-like names, separators, null bytes,
     bearer misuse, and oversized/partial transfers.
   - Add throttling, pairing expiration, token revocation, firewall instructions, TLS or a documented
     threat model, and wrong-code/expired-code tests.

9. **Add CI and release automation**
   - Run importer tests, JavaScript syntax checks, library verification, desktop builds, Android builds,
     bundle generation, clean-profile smoke tests, and checksum generation.
   - Build/sign targets separately and upload only through an explicit release workflow.
   - Do not commit, push, publish, or create a GitHub release unless the user explicitly requests it.

10. **Create public-support documentation**
    - Replace personal paths and machine assumptions with generic OS instructions.
    - Document first run, backend setup, credentials, directories, reset/migration, privacy,
      uninstall behavior, codec support, LAN sync, Android permissions, limitations, support, and license.

### Shipping acceptance criteria

A public desktop release is ready only when a clean machine can:
- install the signed package without developer tools already installed;
- complete first-run setup and import a playlist;
- hear decoded audio reliably;
- use queue, likes, stats, lyrics, cover art, and deletion;
- restart and restore state;
- pair and sync to Android if Android is included; and
- uninstall without unexpectedly deleting the user's library.

An Android release is ready only when:
- a signed APK or AAB installs on supported Android versions;
- WebView playback/private storage work;
- permissions and denial paths are safe;
- imports, sync, restart, lyrics, deletion, and queue state survive lifecycle changes;
- reinstall/upgrade migration is tested; and
- the Gradle build is repeatable with pinned JDK/SDK dependencies.

Work in small, verifiable increments. Every claim in the final report must be backed by a command
you actually ran or a screen you actually inspected.

---

## 1. What exists today (state of the product)

**Product.** A local-first music app. You paste a Spotify / YouTube Music / YouTube playlist link, a
Python importer resolves the tracks, downloads the audio with `yt-dlp`, transcodes to AAC `.m4a` with
`ffmpeg`, normalizes loudness, writes a library manifest plus playlist exports, and the player plays
it back fully offline.

**Three targets, one UI:**

| Target | How it is built | What is special |
| --- | --- | --- |
| Plain web | open `player.html` over any static server | user picks a folder of audio files |
| Desktop | Electron, `npm run dist` → AppImage + rpm | local library HTTP server, import bridge to Python, menus, single-instance lock |
| Android | Capacitor, `npm run mobile:build` → debug APK | app-private library, LAN sync, and device-audio import; build currently requires JDK 17-21 |

**v1.1 features.** Sidebar navigation, custom playlists, queue add/play-next/reorder/remove/clear,
three shuffle modes with weighted smart shuffle, likes and listening statistics, cover and lyrics
metadata, desktop retry/delete/storage controls, mobile LAN sync/device import, playback speed,
crossfade/sleep controls, media shortcuts, command palette foundations, and a responsive player.

**Current library state.** 54 tracks, 208.8 MiB, AAC 192k. `library/playlist.json` is the contract
between the importer and the player.

**Distribution state.** Desktop AppImage (~127 MB) and RPM (~91 MB) have been rebuilt with the final
source bundle. No public-signed installer or mobile release APK/AAB is currently complete. Desktop
and mobile build/dependency tooling remains local and has not been hardened for clean-user machines.

**Shipping gaps remaining.** Desktop/Mobile builds still assume developer tooling; release credentials,
signing, updater infrastructure, and public distribution identity are incomplete. M4A/AAC playback is
not reliable in every Chromium/WebView target, and external Python/yt-dlp/ffmpeg dependencies are not
bundled. Android uses JDK 25 on this host and cannot currently build; real Android playback, device
import, LAN sync, reinstall/upgrade, and signed release testing remain incomplete. Cover and lyrics
code exists, but the live library has no such assets; LAN sync and Spotify edge fixtures need real tests.
Public releases must also exclude personal libraries and developer configuration.

---

## 2. Phase 0 — mandatory code study (do this first)

Read the files in this order. They are small; do not skim them, and do not rely on this document
instead of the code.

1. `README.md` — sections 5 (project layout), 6 (track list formats), 7 (what the importer does),
   8 (command reference), 9 (the player), 10 (verification checklist), 12 (design notes and limits).
2. `player.html` (140 lines) — the whole DOM: sidebar, three views, fixed player bar, queue drawer,
   modal, import bar.
3. `ui/engine.js` (733 lines) — library loading, URL resolution, playback state machine, queue order,
   `smartShuffle`, `buildOrder`, `setShuffleMode`, `notePlayed`, persistence.
4. `ui/ui.js` (1156 lines) — rendering of views/cards/rows, playlist CRUD, per-row menu, modal,
   Discover, the import bridge, keyboard shortcuts.
5. `ui/app.css` (826 lines) — theme tokens, grid, the `[hidden]` rule, the ≤720 px layout, touch rules.
6. `desktop/main.js` (428 lines) and `desktop/preload.js` (43 lines) — the library HTTP server and its
   path guard, MIME map, the importer subprocess bridge, `fetchRecommendations`, menus, IPC surface.
7. `importer.py` (1830 lines) — read it top to bottom, but pay special attention to `Track`,
   `Candidate`, `Manifest`, `score_candidate`, `rank_candidates`, `search_candidates`,
   `download_audio`, `transcode_to_m4a`, `process_track`, `run_import`, `build_recommendations`.
8. `scripts/sync-web.mjs` — how `www/` is assembled.
9. `capacitor.config.json`, `package.json` (scripts + `build.extraResources`).

Then write a short findings note (a markdown file, `NOTES.md`, or your first message — your choice)
that answers, in your own words:

- Where does the player get the library from on each of the three targets, and how are audio URLs
  resolved per target? (Look for `bundledBase` in `engine.js`.)
- Which `localStorage` keys exist and what exactly does each hold? Grep for `localStorage`; the known
  ones are `localMusic.playlists.v1` and `localMusic.session.v2`.
- What is the exact IPC contract in `preload.js`, and which channels does `main.js` handle?
- What does `library/playlist.json` contain per track, and what does `library/manifest.json` key on?
- How does `score_candidate` work, what is the minimum score, and where do noise penalties apply?
- What happens on interrupt, on failure and on re-run (idempotency, atomic writes, `failed.json`)?
- Which Android WebView restrictions already forced workarounds? (There are comments; find them:
  `[hidden]`, `setChildren`, unicode-regex, `aspect-ratio` fallbacks.)
- Which parts of the code are generated and must never be hand-edited?

Report the note and stop only if one of your findings contradicts this document. Otherwise continue.

---

## 3. Repository map — every file and directory, and what it means

```text
local-music-app/
├── README.md                  User documentation and the verification checklist. KEEP IT CURRENT.
├── AGENT_PROMPT.md            This file. Not shipped; do not bundle it.
├── package.json               Scripts + Electron/Capacitor dependency set + electron-builder config.
│                              `build.files` ships desktop/, `build.extraResources` ships player.html,
│                              ui/ and importer.py next to the binary. Any new runtime file the
│                              desktop app needs MUST be added to extraResources or it will be missing
│                              in the installed build.
├── package-lock.json          Commit-quality: never hand-edit; use npm.
├── capacitor.config.json      Mobile shell: appId, appName, webDir = www. Source of truth for the
│                              Android app identity.
├── songs.txt                  Default track list for `python3 importer.py` with no arguments
│                              (`Artist - Title`, optional `| 4:08` duration hint).
├── importer.py                The whole backend: track-list parsing, playlist-link resolution
│                              (Spotify embed + Spotify Web API, YouTube via yt-dlp), candidate
│                              scoring, download, ffmpeg transcode + loudnorm, atomic manifest and
│                              export writes, `--verify`, `--recommend`. Single file, ~1830 lines.
│                              This is where the import speed and accuracy work happens.
├── player.html                The app shell. Markup only (sidebar, views, player bar, queue drawer,
│                              modal dialog, import bar). Loads ui/app.css, ui/engine.js, ui/ui.js.
│                              It is the ONLY HTML file; the mobile build copies it to www/index.html.
├── build/icon.png             App icon, used by electron-builder and the .desktop launcher.
├── ui/
│   ├── app.css                Dark theme tokens, layout grid, responsive rules, `[hidden]` override,
│   │                          `hover:none` touch rules. No preprocessor, no framework.
│   ├── engine.js              Non-UI logic: library fetch, per-target audio URL base, <audio>
│   │                          element, queue and order building, shuffle modes and weights, session
│   │                          persistence, library refresh. Exposes a small global API that ui.js uses.
│   └── ui.js                  Rendering and interaction: views, track rows (two buttons: play area +
│                              `⋯` menu), playlist chips and pages, modal, Discover cards, import
│                              progress, keyboard shortcuts. Depends on engine.js's globals.
├── desktop/
│   ├── main.js                Electron main process:
│   │                          - starts a loopback HTTP server that serves player.html, /ui/ and
│   │                            /library/ (with a path-traversal guard and an explicit MIME map)
│   │                          - reads the library from LOCAL_MUSIC_LIBRARY or
│   │                            ~/.config/Local Music/library in packaged builds
│   │                          - spawns `python3 importer.py <args>` and streams stdout to the page
│   │                          - `fetchRecommendations()` runs `importer.py --recommend 12` with a
│   │                            90 s kill timeout and parses JSON from stdout
│   │                          - menus (reload library, open library folder, cancel import),
│   │                            single-instance lock, window lifecycle
│   └── preload.js             The entire privileged surface, exposed with contextIsolation:
│                              `startImport`, `fetchRecommendations`, `onImportEvent`, `onMenuAction`.
│                              Anything new the page needs from the OS goes through here.
├── scripts/
│   └── sync-web.mjs           Builds www/ from the single sources: player.html → index.html,
│                              ui/ → ui/, library/playlist.json + library/audio → bundled library.
│                              Must be updated whenever a new asset type (covers, lyrics, ...) is
│                              added, or the phone build will be missing it.
├── www/                       GENERATED. Do not edit by hand. Wiped and rebuilt every mobile build.
├── android/                   GENERATED Capacitor project (Gradle, manifest, assets/public/).
│                              Edit only when a native capability or permission is genuinely needed
│                              (e.g. cleartext LAN access), and document why in README §3.2.
├── dist/                      GENERATED installers and linux-unpacked/. Safe to delete, not source.
├── .toolchain/                GENERATED local Android/JDK/Gradle/emulator download. Deletable.
├── __pycache__/               Generated bytecode. Ignore.
└── library/                   The library itself. Runtime data, not code.
    ├── audio/                 Downloaded `.m4a` files, named "<Artist> - <Title>.m4a"
    │                          (collision suffix " [<videoId>]"). Served by the desktop server.
    ├── manifest.json          Download ledger, version 1. Keyed by normalized "artist - title";
    │                          each record stores the source video id, file name, duration, size,
    │                          source URL, bitrate. Drives idempotency and re-download.
    ├── playlist.json          The app/player contract: { version, generatedAt, trackCount, tracks[] }
    │                          with title, artist, fileName, path ("audio/..."), duration. Ordered by
    │                          the original track-list order. Additive changes only — the player must
    │                          keep working if an older file is loaded.
    ├── playlist.m3u8          Relative-path playlist for VLC/mpv/Poweramp.
    ├── failed.json            Rejected/failed tracks with reason + top-5 scored candidates, capped 500.
    ├── .tmp/                  Per-download scratch dir; atomic os.replace() out of it.
    └── .cache/                yt-dlp cache and (after your work) search-result cache.
```

**Generated files — never hand-edit:** `www/`, `android/app/src/main/assets/public/`,
`dist/`, `library/*.json` (the importer owns them), `.toolchain/`.

**Not a git repository.** There is no history to diff against and no branch to protect. Keep your own
copies of files you are unsure about, and never run destructive cleanup on `library/`.

---

## 4. Technical constraints you must respect

These are not preferences; they are the reason the app currently works on three targets.

1. **No UI framework, no build step, no CDN.** `player.html` + `ui/*.css|js` are plain files loaded
   directly. Keep it that way. ES modules are acceptable only if you also verify `file://` behaviour
   on desktop and the Capacitor asset loader, and update `sync-web.mjs` if needed.
2. **One UI for all targets.** Feature code goes in `ui/`, never in a target-specific duplicate.
   Target differences are capability checks, not forks.
3. **Audio URL base differs per target.** Non-desktop pages must use the relative `library/audio/`
   base (the `bundledBase` path in `engine.js`). Do **not** detect Capacitor by `window.Capacitor`:
   the native bridge script can be injected after app scripts run.
4. **Android WebView is the hard target.** It is an old Chromium with real gaps. Keep the existing
   defensive patterns: the global `[hidden]{display:none!important}` rule, the `setChildren()`
   fallback for `replaceChildren`, the `[^\w\s\u00C0-\uFFFF]` regex instead of `\p{L}`, and the
   `aspect-ratio`/`inset`/`clamp` fallbacks. New CSS must degrade, not disappear.
5. **No `prompt()` / `confirm()`.** The app has a custom modal; use it.
6. **Pointer and keyboard parity.** Every row action must be reachable by touch and by keyboard; the
   play area and the row menu are separate buttons (this was a TalkBack fix — do not merge them).
7. **Desktop stays sandboxed.** `contextIsolation` on, `nodeIntegration` off, everything through
   `preload.js`. Validate every IPC argument in `main.js`; keep the server's path-traversal guard.
8. **Persistence is `localStorage`, versioned.** Existing keys: `localMusic.playlists.v1`,
   `localMusic.session.v2`. Add new keys under `localMusic.*` with a `.v1` suffix and write a
   migration/read-fallback when you change an existing shape. Never drop a user's playlists on upgrade.
9. **`library/playlist.json` changes must be additive.** The player, the m3u8 export and any older
   copy must keep working. Include a `version` bump only if you truly need one.
10. **Importer writes are atomic and idempotent.** Every JSON write goes through the existing
    temp-file + fsync + `os.replace` helpers. A crash must never leave a half-written track, a corrupt
    manifest, or a lost queue position. Parallelism must not break this — serialize the writers.
11. **No secrets in the repo, no telemetry, no new cloud services.** Spotify credentials come from
    `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` env vars only.
12. **Dependencies.** Keep the dependency count near zero. The only additions you may make without
    asking are `@capacitor/filesystem` (file storage, item 1 and 8) and, if genuinely unavoidable for
    metadata/SAF, one maintained Capacitor plugin — justify it in the report. Python: stdlib only
    unless you can prove a real win; `yt-dlp` and `ffmpeg` are the existing external tools.
13. **No dead code, no placeholder features, no "coming soon" UI.** If a feature cannot be completed
    and verified, do not ship half of it; report why.

---

## 5. Work items

Order matters: **do item 1 (import pipeline) first**, because several later items (cover art, lyrics,
ISRC matching) ride on the metadata it produces, and because it is the one item with a measurable
performance target.

For each item: state the design in two or three sentences, implement, verify, then move on. Do not
batch all thirteen and verify at the end.

---

### Item 1 — Import speed and accuracy (do first)

**Why.** Importing a 50-track playlist currently takes tens of minutes, and a meaningful share of
tracks either match the wrong upload or get rejected outright. This is the single biggest quality
problem in the product; every other feature is worth less than a fast, correct import.

**Step 1 — measure the baseline, before touching anything.** Run a fixed batch (use `--limit 10` on a
real playlist, or a 10-line `songs.txt`) with `--force` so nothing is cached, and record wall-clock
time, time-to-first-download, per-track time, and every chosen candidate with its score. Compare
against `importer.py --verify`. Save the numbers; you will report before/after side by side. Do not
claim a speedup you did not measure.

**Step 2 — restore the correct-match rate to a known value.** Build a labelled fixture of at least 25
tracks where you record the correct video id / channel yourself (10 easy, 10 ambiguous titles, 5
non-Latin/accents/features). Score the current code against it first; that is your accuracy baseline.

**Step 3 — then optimize. Verify each of these ideas against the code; adopt what applies, skip what
does not, and say which you skipped:**

*Speed*
- `ytsearch5:` currently extracts five full video pages per track. Use flat search (`extract_flat`)
  for the candidate list — you get title, duration, channel and id cheaply — filter on duration and
  channel, then extract only the winner. This is usually the largest single win.
- Bound-parallelism with `--jobs N` (default `min(4, cpu_count)`), one `YoutubeDL` instance per worker
  (`YoutubeDL` is not thread-safe). Pipeline search for track *i+1…i+N* while track *i* downloads.
  Keep manifest and export writes on a single serialized path so ordering, atomicity and idempotency
  are unchanged, and keep `playlist.json` in input order regardless of completion order.
- Persist the flat search results in `library/.cache/search.json` keyed by query + expected duration,
  with a TTL, so retries, `--force` re-runs and runner-up fallbacks do not re-search.
- Use yt-dlp's own knobs instead of hand-rolled retries: `retries`, `fragment_retries`,
  `socket_timeout`, `concurrent_fragment_downloads`, `http_chunk_size`, `noplaylist`.
- In `transcode_to_m4a`, skip the re-encode when the source is already AAC at or below the target
  bitrate and normalization is off (`-c:a copy -movflags +faststart`). When encoding is needed, set
  `-threads 0` and avoid a second decode. Measure ffmpeg's share of wall time; if `loudnorm` is a
  large fraction, keep it but make the trade-off explicit in README.
- Drop redundant `ffprobe` calls when yt-dlp already reported a duration.
- Replace the fixed `--sleep 0.6` between every download with a small jittered delay plus 429-aware
  backoff, so rate limits are respected without paying 0.6 s × N for nothing. Keep the flag working
  and document the new default.

*Accuracy*
- Pre-filter candidates by duration from the flat result before scoring (>60 s off = drop).
- Carry real durations into scoring from every source that has them (the YouTube playlist listing and
  the Spotify API both do). Duration is the strongest disambiguator you have; use it everywhere.
- Normalize harder before comparing: `feat.`/`ft.`/`&`/`and`, `(Official Video)`, `(Official Audio)`,
  `(Lyric Video)`, `- Remastered`, year suffixes, trailing `, Pt. 2`, full-width punctuation, and
  smart quotes. Keep the existing accent folding.
- Treat `- Topic` channels and artist-channel uploads as strong positives; treat `VEVO`, `Official`,
  label channels as positives; keep and extend the noise vocabulary (live, remix, cover, slowed,
  reverb, 8D, nightcore, sped up, instrumental, karaoke, reaction, tutorial, 1 hour, loop, mashup,
  full album, bass boosted, chipmunk, + lyric video when audio is wanted).
- Two-stage matching: if the best score is under `--min-score`, retry with a narrower query
  (quoted artist+title, then title + duration, then artist + `"Topic"`), then fail. Record why.
- Verify after download: stream exists, decodable, duration within ~5 s of expected. If not, fall back
  to the next candidate instead of keeping a wrong file.
- Expose confidence: log chosen candidate, score, and the margin over the runner-up. When the margin
  is small, mark the track `needsReview` in the manifest/exports so the UI can show it (item 6 can
  surface it) — but only if it is genuinely shown somewhere; otherwise just log it.

**Acceptance.** With the same 10-track batch and `--force`, wall-clock time improves by at least 2×
(report the actual number), and correct-match rate on your labelled fixture improves or stays at 100%
with no regression. `--verify` passes, `playlist.json` order is unchanged, and interrupting a
parallel import with Ctrl+C leaves a valid manifest and no half-written file.

---

### Item 2 — Library sync over LAN (replace the 213 MB APK rebuild)

**Why.** Today, adding one song to the phone means copying megabytes of audio through Gradle and
reinstalling an APK. Sync once over Wi-Fi and the phone is current in seconds.

**Scope.** Desktop exposes a pairing endpoint on its existing HTTP server: a short-lived code (shown in
the UI, 6 digits, expires) plus a token, over the LAN. The phone, in a new "Sync" panel, enters
`ip:port` + code (or opens a `localmusic://sync?...` link / QR if you can do it cheaply), asks for the
manifest, downloads only missing or changed tracks, writes them to app storage, and refreshes the
library without a restart.

**Implementation notes.** Use `@capacitor/filesystem` for storage and read/write of `playlist.json`.
Fetch with a native HTTP path (`CapacitorHttp`) so you avoid mixed-content/CORS friction against a
plain-HTTP LAN host; if you go through the WebView instead, you must configure the network security
config for cleartext on private ranges and explain the trade-off. Play downloaded files through
`Capacitor.convertFileSrc()`. Handle: desktop offline, wrong code, expired code, partial download,
re-sync, deleted-on-desktop tracks, and files that already exist. Cap concurrency (2–3) and stream to
disk rather than buffering whole files in base64 memory. The bundled APK library stays as a fallback
for a first run with no desktop around.

**Acceptance.** On the emulator (host reachable at `10.0.2.2`), add one track on the desktop, sync, and
the phone plays it without an APK rebuild; a second sync transfers zero bytes; a wrong code is refused
with a clear message and no partial writes.

---

### Item 3 — Cover art

**Why.** A music app without artwork does not read as a real app. The data is already there: yt-dlp
returns a thumbnail for every candidate.

**Scope.** The importer saves each track's thumbnail as `library/cover/<slug>.jpg` (reuse
`slug_filename`), records `cover` in the manifest record and in `playlist.json` per track, and
`sync-web.mjs` copies the cover directory. The UI shows art in the player bar, in track rows, on
Discover/Home cards, and on the playlist page — with a deterministic gradient+initials fallback when
a cover is missing so layout never jumps. Lazy-load and `object-fit: cover`; respect `prefers-reduced-motion`.

**Acceptance.** All 54 existing tracks have a cover after a `--export-only`-style backfill (add a
`--covers` maintenance path if the manifest has the source ids but no files), no console 404s, correct
rendering at phone width, and the empty-library and missing-cover states both look intentional.

---

### Item 4 — Queue control: play next, add to queue, reorder

**Why.** A queue you cannot touch is a playlist with extra steps. This is table stakes for daily use and
it is currently missing.

**Scope.** Row menu and player bar get "Play next" and "Add to queue". The queue drawer supports
reordering the manual queue (drag on pointer devices; move-up/move-down buttons that are reachable by
keyboard and TalkBack on touch) plus "remove from queue". The manual queue is separate from the
auto-generated order: tracks inserted by hand play in insertion order at the front of the remaining
queue, survive a shuffle-mode change, and are not duplicated. Clear queue lives in the drawer.

**Acceptance.** Insert two tracks while a third is playing in both shuffle modes; verify order, no
duplicates, correct behaviour at the end of a track, after next/prev, and after a reload (persisted in
the session).

---

### Item 5 — Likes, play counts, and a stats view

**Why.** The smart shuffle currently guesses from recency alone; likes and counts turn it from a gimmick
into something that actually learns, and they give the app a "Top tracks / Top artists / Recently
played" surface people open on purpose.

**Scope.** Heart control in rows and the player bar, a "Liked" view in the sidebar, and stats stored per
track key: `{ plays, skips, lastPlayedAt, likedAt }` under `localMusic.stats.v1` (+ `likes` inside it or
a sibling key — pick one and document it). Feed the weights in `smartShuffle`: disliked/skipped tracks
down, liked and frequently played up, still keeping artist variety and the recent-play penalty. A skip
counter only when the track ends before ~50% (do not count seeking as skipping). Home gets a stats
strip: top artists, top tracks, listening time from durations × plays.

**Acceptance.** Play/skip/like feed through to the order in a deterministic, testable way; counts survive
reload; a fresh library still shuffles sensibly with zero history.

---

### Item 6 — In-app track delete and storage readout

**Why.** A library you can only grow is a library you eventually abandon. Deleting a bad download from
inside the app removes a whole terminal step.

**Scope.** Desktop: delete from the row menu and the queue, behind the custom modal (irreversible
warning), removing the file, the cover, the manifest record, the failed entry and both exports, all
atomically — implement it as an importer subcommand (`--remove <key>`) rather than reimplementing the
library format in JavaScript. Update the player immediately without a full reload. Phone: read-only
storage figure (library size from `playlist.json` + `navigator.storage.estimate()`); deleting bundled
assets from a signed APK is not a real feature — do not pretend otherwise. Surface failed imports
(`library/failed.json`) with their reason and a retry action on desktop.

**Acceptance.** Deleting while the track plays moves to the next track cleanly; `--verify` stays green;
a deleted track is gone from Home/Songs/search/queue after a refresh; a cancelled confirm changes nothing.

---

### Item 7 — Offline synced lyrics

**Why.** The app is offline-first and people listen to lyrics. Doing this without any network call is
both the right architecture and a differentiator.

**Scope.** Sidecar `.lrc` files in `library/lyrics/` named after the audio file, loaded by the player and
bundled by `sync-web.mjs`. Parse `[mm:ss.xx]` timestamps (multiple per line, `[offset:]`, metadata tags
ignored), highlight the active line, auto-scroll without fighting the user's manual scroll, tap a line
to seek, and hide the panel when no lyrics exist. Add a desktop path to attach a lyrics file to a track
(small modal + file pick) and have the importer/manifest track ownership so sync copies it. No network
lookup, no bundled lyrics of copyrighted songs.

**Acceptance.** A track with an `.lrc` file shows synced, seekable lyrics on desktop and on the emulator,
including after a seek and a pause; a track without lyrics shows no empty panel; the layout holds at
phone width and in landscape.

---

### Item 8 — Import audio from device storage (Android)

**Why.** The APK currently ships a frozen library; a user with their own files has no way in. This makes
the phone app usable as a real player for music you already own.

**Scope.** A "Import from device" action in the mobile UI that opens the system file picker (SAF),
copies the chosen files into app storage (so playback survives the picker's permission grant), reads
title/artist/duration from tags where possible or falls back to a `Artist - Title` filename parse plus
`<audio>` metadata, appends them to the device library (`playlist.json` in app storage, merged with the
synced/bundled list), and refreshes the UI. Handle: cancel, unsupported file, huge file, duplicate
(by filename+duration), and a pick that returns a URI the WebView cannot read directly.

**Acceptance.** Pick an MP3 and a FLAC pushed to the emulator's shared storage; both appear, play, and
survive an app restart; duplicates are skipped with a message; the bundled library is untouched; the
desktop UI is unaffected.

---

### Item 9 — Playback controls: crossfade, sleep timer, speed

**Why.** These are the small controls that make a desktop player feel native. None of them exist.

**Scope.** Crossfade (off / 2 / 4 / 6 s) via two `<audio>` elements with preloading and a gain ramp —
`<audio>` cannot do true gapless, so do not claim gapless; crossfade only. Sleep timer (15/30/60 min,
"end of track") with a visible countdown and a clean pause, persisted. Playback speed 0.75–1.5× in 0.25
steps, persisted. All three must interact correctly with shuffle, repeat-one, seek, and track change
(directly or via the crossfade path).

**Acceptance.** With crossfade on, consecutive tracks overlap by the configured amount with no click or
double-play; sleep timer fires at the right moment and cancels cleanly; speed resets nothing and survives
a reload; all three work on the emulator.

---

### Item 10 — OS media controls and packaging hygiene

**Why.** Media keys and the OS media panel are the difference between "a web page in a window" and "an
app". Auto-update and code signing need infrastructure you do not have, so be honest about them.

**Scope.** Renderer: `navigator.mediaSession` metadata (title, artist, album, artwork from the cover
file) and action handlers for play/pause/prev/next/seekto/stop; verify it populates the MPRIS panel on
Linux. Main: `globalShortcut` for MediaPlayPause/MediaNextTrack/MediaPreviousTrack, unregistered on quit
and only when the window exists, forwarding through the existing IPC surface (add the channels to
`preload.js`). Packaging: desktop entry name, icon, category, `StartupWMClass`, and a single-instance
focus behaviour that is actually correct. For auto-update: `electron-updater` needs a published feed URL
and a code-signing setup you do not have — do **not** ship a fake updater. Document the two prerequisites
(feed URL + signing key) in README and leave the build config untouched unless the user supplies them.

**Acceptance.** Media keys control playback, the MPRIS panel shows correct metadata and artwork, a second
launch focuses the running window, and the packaged AppImage still starts from a clean profile.

---

### Item 11 — Finish the Spotify import path and add a retry queue

**Why.** The embed page only exposes ~50 entries; the Web API path exists but is a fallback rather than a
first-class feature, and there is no way to retry just the failures.

**Scope.** Prefer the Web API whenever `SPOTIFY_CLIENT_ID`/`SECRET` are present, with `limit=100`
pagination, one re-auth on 401, `Retry-After` on 429, `is_local`/non-track skipping, and stable input
order. Capture `external_ids.isrc` and `duration_ms` per track; use the duration in scoring (item 1) and
the ISRC as a strong identity signal where a second source is available. Add `--retry-failed` (retry only
entries in `failed.json`, with a bounded attempt count and exponential backoff, clearing entries on
success) and make the desktop import bar able to trigger it. Show a clear, non-blocking warning when it
falls back to the embed page, and make the truncation visible in the log ("first 50 of N"). Credentials
stay in env vars, never in the repo or `localStorage`.

**Acceptance.** With credentials set, a >50-track playlist imports in full and in order; without them, the
fallback path still works and says so; `--retry-failed` re-attempts exactly the failed set; the run exits
with the documented codes.

---

### Item 12 — Tests for the importer

**Why.** Scoring and parsing are pure logic with a lot of edge cases, and every change in item 1 will
silently break them unless something checks.

**Scope.** `tests/` with stdlib `unittest`, no network, no ffmpeg, no yt-dlp: `songs.txt` parsing
(comments, blank lines, en dash, bullet, duration hints, duplicates, no separator), `tracks.json`
(seconds, `duration_ms`, `artists[]`, bare array), Spotify/YouTube URL recognition and rejection of
track links, `slug_filename`/`track_key` normalization (accents, emoji, 120-char cap, FAT-illegal chars,
collision suffix), `score_candidate` (perfect match wins, live/remix/cover/sped-up are penalized, "Live
Forever" is not penalized for "live", duration mismatch loses, empty-title robust), manifest idempotency
(missing file triggers re-download, present file skips, `--force` overrides), export shape and m3u8
relative paths. Run with `python3 -m unittest discover -s tests -v` and wire it into README §10.

**Acceptance.** Tests pass on a clean checkout with no network; they fail if you reintroduce a known bug
(demonstrate one such revert-and-restore for the report); runtime under a few seconds.

---

### Item 13 — Global search / command palette

**Why.** 54 tracks is already past the point where scanning rows is pleasant, and it gets worse with
device imports. One keystroke to any track, playlist or action is the highest-leverage navigation fix.

**Scope.** `Ctrl/Cmd+K` (and a search field in the phone top bar) opens one overlay that fuzzy-matches
tracks (title, artist, album), playlists and commands ("Play next", "Add to queue", "Shuffle", "Open
Discover", "Sync", "Sleep timer"). Arrow keys + Enter, Escape closes and restores focus, `aria-*` roles
for the listbox, and touch-sized targets on the phone. Selecting a track plays it in context; selecting a
playlist opens it. Do not duplicate the existing Songs-view search logic — factor the matcher into one
place and use it in both.

**Acceptance.** Opens and closes without leaking focus or timers; results are keyboard-navigable and
correct on accented and partial queries; commands actually execute; works at 360 px width on the emulator.

---

## 6. Verification protocol

Run only what each item needs, but do run it. Never report an unverified claim as verified.

**Python / importer**
```bash
python3 -m py_compile importer.py
python3 -m unittest discover -s tests -v          # after item 12
python3 importer.py --dry-run
python3 importer.py --export-only && python3 importer.py --verify
python3 importer.py --recommend 4                 # must print JSON on stdout only
```

**Desktop**
```bash
npm start                                         # or: npx electron . --remote-debugging-port=9333
```
Check: library loads with no console errors, playback works, import bar streams, new UI features behave,
and the packaged build still contains everything (`npm run dist`, then launch the AppImage on a clean
`HOME`-level library path at least once).

**Android** (toolchain is local and deletable):
```bash
export JAVA_HOME=$PWD/.toolchain/jdk
export ANDROID_HOME=$PWD/.toolchain/sdk
export ANDROID_SDK_ROOT=$PWD/.toolchain/sdk
export GRADLE_USER_HOME=$PWD/.toolchain/gradle-home
npm run mobile:build
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb logcat | grep -i capacitor               # local asset requests must appear here
```
Emulator (headless, KVM):
```bash
ANDROID_AVD_HOME=$PWD/.toolchain/avd .toolchain/sdk/emulator/emulator \
  -avd lm35 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect \
  -no-snapshot -memory 3072 -partition-size 4096
```
UI automation: `adb shell uiautomator dump /sdcard/ui.xml` (WebView `aria-label`s show up in `text=`),
`adb shell input tap x y`. Screenshots are 864 px wide while the device is 1080 px — scale by 1.25.
No physical phone is attached; if one appears, prefer it and say so.

**Cross-cutting checks before you report**
- No console errors on desktop, no red logcat lines on Android.
- Existing behaviour survives: playlist create/rename/delete, smart shuffle mid-track, queue drawer,
  repeat modes, session restore, Discover, and the three shuffle modes on 54 tracks.
- The library is not corrupted by any new write path: `--verify` green at the end.
- `README.md` updated for anything user-visible (layout §5, CLI §8, player §9, verification §10,
  troubleshooting §11 if you added a new failure mode).

---

## 7. Definition of done

The v1.1 feature implementation is considered present unless a regression is found. The additional
shipping pass is done only when a clean desktop or Android target can install, configure, import, play,
persist state, update safely where implemented, and uninstall or migrate without developer-only files.
No shipping claim is complete without the command or screen evidence supporting it.

Final report format:

1. **Findings summary** from Phase 0 (the note you wrote).
2. **v1.1 status**: per implemented area, files touched, verification performed, and remaining gaps.
3. **Shipping changes**: design, files touched, verification command/outcome, and blockers.
4. **Library/build artifacts**: APK/AAB path and size, AppImage/RPM sizes, signed artifact paths and
   checksums, whether installed builds were launched, and which targets remain unsupported.
5. **Not verified / not done**, stated plainly, with environment or missing-capability reasons.
6. **Recommended next steps** in priority order (short list, no work started).

Do not commit anything, do not push, do not publish or sign with a real certificate unless the user
explicitly authorizes the external action. Do not create or expose a personal keystore. Do not delete
`library/`, `.toolchain/`, existing installers, or user data.

END PROMPT
