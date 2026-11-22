# Next steps — Local Music App

Written after auditing the v1.1 handoff in `AGENT_PROMPT.md` and checking its claims against the
running code. Where this document disagrees with the handoff, **this document is the measured one** —
each correction below says how it was verified.

---

## 1. Verified state (2026-11-22)

| Claim in the handoff | What I measured | Verdict |
| --- | --- | --- |
| 7 importer tests pass | `python3 -m unittest discover -s tests -v` → 7 ok, 0.006 s | **true** |
| Library and exports valid | `playlist.json` v2, 54 tracks; manifest v2, 54 records | **true** |
| "Chromium rejects AAC/M4A, playback unverified" | In Electron 45.4.1, all **54/54** tracks fire `canplaythrough`, `play()` advances (`t=1.43`), 0 errors, over the app's own library server | **false — test artifact** |
| "Android build blocked: JDK 25, `class file major version 69`" | `JAVA_HOME=.toolchain/jdk npm run mobile:build` → **BUILD SUCCESSFUL in 2m 9s**; APK rebuilt 261.7 MB, today 14:17 | **false — use the bundled Temurin 21** |
| "Cover art implemented" | `library/cover/` empty; `playlist.json` has **0** cover keys; `library/lyrics/` empty | **code exists, never run on real data** |
| "54 tracks" | `library/audio/` holds **60** files → 6 orphans, ~20 MB dead weight in the APK | **data drift, unhandled** |
| Secrets / personal library not shipped | `.gitignore` covers `library/`, `dist/`, `.toolchain/`, `.env*`, `build/`; 72 files tracked, none of them data or keys | **true** |
| First-run setup exists | no dependency probing in `desktop/main.js`; `importer.py` only fails at first use | **not started** |

### The two failures that were really harness bugs

1. **Playback.** The earlier probe requested `/audio/<file>`; the desktop server only serves
   `/library/audio/<file>` (`/audio/…` → 404 → `MEDIA_ELEMENT_ERROR: Format error`). Retested through
   the real prefix: 54/54 play. The `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` note almost certainly came
   from a headless Chromium build without proprietary codecs — Electron ships AAC.
2. **Android.** The host default `java` is 25, but `.toolchain/jdk` is Temurin 21 and Gradle is happy
   with it. The environment was never actually blocked; `JAVA_HOME` just was not set.

### Real defects confirmed by inspection

* **Every file is AAC at 96 kHz.** `transcode_to_m4a` appended `loudnorm` as the last filter and never
  resampled; ffmpeg's loudnorm stage leaves a 96 kHz stream. (Measured later: file size is unchanged,
  because the bitrate is fixed — the cost is decode work and compatibility on some Bluetooth/WebView
  paths, not disk.) Not a playback blocker in Electron, but not a format worth shipping.
  **Fixed in P0.2** with `-ar 48000 -ac 2` after the filter chain plus `--reencode`.
* **5 of 54 tracks carry `needsReview: true`** and nothing in the UI appears to surface it (worth
  confirming), so low-confidence matches are silent.
* **6 orphan audio files** exist with no manifest/playlist record, and `sync-web.mjs` copies the whole
  directory — so the APK and phone library contain tracks the app will never show.

---

## 2. Plan

Ordering rule: finish the things that decide whether v1.1 is real before adding anything new. Each
item lists the check that closes it.

### P0 — prove v1.1 actually works — **DONE 2026-11-22**

All five items below were executed and verified on the Electron app and the Android 15 emulator.
Details and the four defects found along the way are in `NOTES.md` (§ P0 verification pass). The
short version: 54/54 tracks play in Electron and on the phone, covers and lyrics render, the review
flag is visible and searchable, the library is normalized to 48 kHz, orphans are gone, and LAN sync
plus device import both work end to end after fixing an Android cleartext block that had made sync
impossible. Remaining follow-ups from this pass are listed at the end of `NOTES.md`.

**P0.1 Android end-to-end on the emulator (highest value, nothing else can substitute).** — **done.**
Verified: playback, playlist create/add/remove, likes, manual queue insert/reorder/remove, covers,
lyrics, review flags, cold-restart persistence, LAN sync (including a 0-byte second sync and a 403 on
a wrong code), SAF device import, and a clean-install run. Fixed two blockers found here: the Android
cleartext ban on sync and `needsReview` being dropped by the engine's track mapper.
The APK now contains the v1.1 UI and the toolchain works, so the largest unknown in the handoff is
finally testable. Install fresh (`adb uninstall` first, not `-r`, to test a clean install), then:
playback of a 54-track library, playlist create/add/remove, smart shuffle, queue insert/reorder/clear,
likes + stats persistence, lyric display after pushing an `.lrc` into app storage, device import after
pushing an MP3, LAN pairing against the desktop at `10.0.2.2`, and a force-stop + relaunch to prove
state restore. Capture logcat for media errors. **Closes when** each of those is either seen working
or filed as a specific bug.

**P0.2 Normalize the audio pipeline.** — **done.** `-ar 48000 -ac 2 -profile:a aac_low` after the
filter chain; the copy fast path now requires a 48 kHz source; `--reencode` backfilled the library
(54 files, 0 failures). Storage did **not** shrink — the bitrate is fixed, so the win is decode cost
and device compatibility, not disk. Add `-ar 48000 -ac 2` after the filter chain (also covers the
`-c:a copy` fast path, which must not silently keep 96 kHz), make the AAC profile explicit
(`-profile:a aac_low`), and add a backfill command (`--reencode` or fold into `--verify --repair`) so
existing libraries can be normalized in place, atomically, with the manifest updated. **Closes when**
a re-encoded sample is `48000 Hz` per `ffprobe`, plays in Electron and on the emulator, and the
library shrinks by the expected amount (report the number).

**P0.3 Exercise the untested asset paths.** — **done.** 54 covers downloaded and rendered in Electron
rows and on the phone; an `.lrc` was attached, rendered (5 lines) and highlighted at the right line,
then removed again so the shipped library carries no test sidecar. Backfill covers for the 54 tracks (the importer code
exists; run it, then look at Home/Songs/player bar on desktop and phone) and attach 2–3 `.lrc` files so
lyrics rendering, seeking and sync transfer are actually observed rather than assumed. **Closes when**
a screenshot-free manual pass confirms art and lyrics render, and that a track without either still
looks intentional.

**P0.4 Fix library drift.** — **done.** 6 orphans (30.8 MiB) found, reported by `--verify` as a
problem, and deleted with the new `--prune-orphans`; the APK dropped accordingly. Add orphan detection to `--verify` (files on disk with no manifest record,
records with no file, duplicate `fileName`) and a `--prune-orphans` action. Re-run sync so the APK no
longer ships invisible tracks. **Closes when** `--verify` reports 0 orphans and the APK size drops.

**P0.5 Surface `needsReview`.** — **done.** Both `engine.js` mappers now carry the flag, rows show a
`review` tag, and typing `review` in the Songs search lists exactly the 5 flagged tracks. If the UI really ignores it, show a small marker on the row plus a
filter in Songs; otherwise downgrade the flag to the importer log. **Closes when** the 5 flagged tracks
are visible or the flag is removed.

### P1.0 Account sign-in and cloud sync — the cross-device target — **implemented 2026-11-22**

**What exists today is not this.** Sync is a LAN-only pull: the desktop opens a short-lived pairing
code, the phone posts it to `127.0.0.1`-adjacent `http://<lan-ip>:44441`, gets a 30-minute bearer
token, and downloads `manifest.json` + audio/covers/lyrics. There is no identity, nothing leaves the
house, the phone cannot push anything back, and playlists/likes/stats never move between devices.

The target the user asked for: **sign in once, and the same library and user state is on every
device.** That needs a tiny hosted service; it cannot be built with the LAN server.

**Shape (offline-first, cloud as the meeting point):**

* One Worker (Freebuff Sites) serves the API and holds the data. Identity is **Sign in with Freebuff**,
  so "your account" is literally the Freebuff account on both the PC and the phone — no password store
  to run, no email verification to build.
* D1: `accounts(user_id)`, `devices(account_id, device_id, name, last_seen)`,
  `device_tokens(token_hash, account_id, device_id, revoked)`,
  `tracks(account_id, sync_key, title, artist, album, duration, size_bytes, content_hash, cover, lyrics, updated_at, deleted_at)`,
  `playlists`, `playlist_items`, `likes`, `play_stats`, all keyed by `account_id` and merged with
  per-row `updated_at` + tombstones so a delete on one device does not resurrect from the other.
* R2: `audio/<account>/<sync_key>.m4a`, `cover/…`, `lyrics/…`. Content hash (`sha256`) is the sync key
  for file bodies, so a re-import that produces identical bytes costs no transfer.
* Sign-in is a **device-code flow**, which is the only flow Electron and a Capacitor WebView share
  safely: app calls `POST /auth/device/start`, shows the code + `https://<service>/link`, opens the
  system browser, polls `POST /auth/device/poll`. The Worker runs the real OIDC exchange with
  `@freebuff/auth` and mints a per-device bearer token. The token is stored with Electron
  `safeStorage` on desktop and Capacitor Preferences on Android; never in `localStorage` or a log.
* Every API call is scoped by the token's `account_id`; the client never sends a user id. Mutations
  require same-origin or a token, and `/auth/device/*` is rate-limited.
* Sync loop (both directions, resumable, no blocking UI): push new/changed tracks and state → pull the
  manifest → download missing audio/assets → reconcile. Audio is never streamed for playback; it is
  cached locally, so the app stays usable offline exactly as now.
* The LAN transfer stays as the **fast path** for a big first sync on the same network. It is an
  optimisation, not the mechanism.

**Two sub-decisions and my recommendation:**

1. **Audio in the cloud?** Recommended **yes** (R2). ~215 MB per user; the free 10 GB covers a small
   number of accounts comfortably. Without it, "signed in on PC and phone" only syncs playlists and
   likes, and the phone still needs the desktop online on the same Wi-Fi to get a song.
2. **Only one account (yours)?** A single-user deployment is the honest first version: it removes
   multi-tenant risk while the sync protocol is new, and Sign in with Freebuff still gives a real
   login screen. Multi-user is a deployment decision later, not a rewrite.

**Implemented.** The scoped decision was metadata only — the user asked for liked songs, playlists
and the like to sync so they can bring the audio over themselves, so no R2 bucket exists and the
service stores no files. Shipped in this pass:

* `service/` Worker (`service/worker.js`) on Freebuff Sites, preview environment published at
  `https://local-music-sync-o7uah6-preview.freebuff.site`, with D1 state and Sign in with Freebuff.
  Tables are created on the first request, so nothing needs a SQL console.
* Device-code sign-in for both clients: the browser approves a six-digit code at `/link`; the app
  polls and receives a random 32-byte bearer token. Desktop tokens are `safeStorage`-encrypted in
  `userData/account.json`; Android tokens live in app-private storage. The renderer never holds one.
* `ui/account.js` (transport + status) and `ui/engine.js` (`accountSnapshot`, `applyAccountState`,
  like/unlike decisions, playlist `updatedAt`, `deletedAt` tombstones, pending unresolved refs).
* Desktop IPC in `desktop/account.js`, Android transport in `ui/mobile.js` with CapacitorHttp and
  `@capacitor/browser` for the sign-in page.
* New account panel in the sync dialog: sign in, sync now, sign out, LAN pairing, and a line naming
  how many account entries have no local audio yet.

**Verified locally** (`wrangler dev`, two device tokens, desktop renderer over CDP): signed-out API is
401; device codes expire and can be consumed once; a second account sees only its own rows; a like,
an unlike, a created playlist and a deleted playlist all propagate between two devices in both
directions; playlist refs with no local file survive as pending and are counted in the UI.

**Not verified:** a real Freebuff sign-in from the app — the preview browser has no Freebuff session,
so the flow stops at the login page. Production deployment is untouched (preview only).

### P1 — shipping-readiness foundation (3–5 days)

**P1.1 `importer.py --doctor`.** One JSON report: python version, yt-dlp present/version, ffmpeg
present/version, JS runtime for yt-dlp, library dir writable, Spotify creds present, disk space.
Reuse the existing `ensure_ytdlp`/`find_ffmpeg`. Desktop renders it as a setup panel with copyable
fix commands; mobile shows a read-only note. **Closes when** a machine with `ffmpeg` removed produces
an actionable screen instead of a stack trace.

**P1.2 Stop requiring a developer toolchain.** Ship the backend instead of documenting it: build
`importer` with PyInstaller, ship a static ffmpeg and the standalone yt-dlp binary, and point
`desktop/main.js` at `process.resourcesPath` before falling back to `PATH`. That single change
removes Python, ffmpeg and yt-dlp from the user's install path and is a prerequisite for Windows and
macOS builds. **Closes when** the AppImage imports one track on a machine with no Python on `PATH`.

**P1.3 First-run library.** New installs must start empty and create `~/.config/Local Music/library`
(or the mobile app-private dir) on first launch — never ship a personal library. **Closes when** a
clean `HOME` starts to an empty state with a working "import your first playlist" path.

**P1.4 Secrets and credentials.** Confirm nothing is baked into the build; move Spotify setup to a
first-run field or PKCE flow; redact tokens in logs and import output. **Closes when** grepping the
built AppImage and the APK for credential material returns nothing.

**P1.5 Release identity and signing.** Real `appId`, author, license, support URL, descriptions;
Linux checksums; Android release keystore + `assembleRelease`; document exactly which certificates the
user must supply for Windows/macOS. **Closes when** a versioned, checksummed artifact set is produced
by one command and the signing gaps are written down, not implied.

**P1.6 Android distribution reality check.** The APK is 261 MB because the whole library is inside it.
Google Play caps a base module around 200 MB, so as it stands the app is sideload-only. Decide
explicitly: ship slim (empty library + LAN sync / device import) as the Play-targeted build, and keep
a personal "full" build for sideloading. **Closes when** there is a documented, reproducible slim
build and its size is recorded.

**P1.7 Updater — only with a real feed.** `electron-updater` needs a hosted, signed feed. Do not add a
caretaker implementation. **Closes when** a feed URL exists and one signed update installs, or the
feature stays documented as absent.

### P2 — hardening and automation (ongoing)

* **P2.1 LAN sync under test:** wrong code, expired code, revoked token, mid-transfer disconnect,
  second sync transfers zero bytes, path-like names rejected. Throttle pairing attempts.
* **P2.2 Spotify fixtures:** local mock server for pagination beyond 100, 401 re-auth, 429
  `Retry-After`, and the fallback-to-embed path; assert order and count.
* **P2.3 CI:** importer tests, `node --check` on every JS file, `--verify` against a small fixture
  library (committed as 3 tiny generated files, not real music), desktop build, Android debug build
  with pinned JDK 21, checksums. Upload nothing; the release step stays manual.
* **P2.4 Public docs:** first run, backend, directories, reset/migration, privacy, uninstall (must not
  delete the library), codec support, Android permissions, sync threat model, limitations, license.
* **P2.5 Matching telemetry in the library:** keep the chosen score and margin in the manifest (already
  there) and add a `--report-matches` view so future accuracy work has data instead of anecdotes.

---

## 3. Recommended sequence

1. P0.1 (Android proof) — because it can invalidate or confirm the rest.
2. P0.2 + P0.4 (audio normalization, library drift) — cheap, mechanical, unblocks clean rebuilds.
3. P0.3 + P0.5 (covers, lyrics, review flags) — mostly running code that already exists.
4. P1.1 + P1.2 + P1.3 (doctor, bundled backend, empty first run) — this is what makes it installable
   by someone else.
5. P1.4 + P1.5 + P1.6 (secrets, signing, slim build) — the distribution gate.
6. P2.x continuously after the first public build.

**Do not** re-implement v1.1 features. **Do not** re-encode everything to MP3: the format is fine and
Electron decodes it; fix the sample rate instead. **Do not** touch the updater until there is a feed.

---

## 4. Definition of done for a public build

A clean machine with no developer tools: installs the package, sees a setup screen that either passes
or tells the user exactly what to fix, imports a playlist, hears every track, uses queue/likes/stats/
lyrics/cover/delete, restarts with state intact, syncs to Android, and uninstalls without touching the
library. Until each clause has been observed on a machine that is not this one, the app is a personal
build.
