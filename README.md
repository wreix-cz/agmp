# Local Music App

A local-first personal playlist importer, audio downloader and offline music player.

It ships in three shapes from one source of truth (`player.html`):

| Target | How to run it | What you get |
| --- | --- | --- |
| **Desktop app** | installer in `dist/` (AppImage/deb), or `npm start` (Electron) | a normal windowed app: paste a playlist link, press Import, library loads itself |
| **Mobile app** | APK from `android/` (Capacitor) | native shell around the same player, with bundled files, device imports, and LAN sync |
| **Plain page** | `player.html` behind any static server | exactly what it was before: one file, no build, no dependencies |

Everything lives on your disk: audio files, the download manifest, playlist exports, failure log
and player preferences. There is no server to keep running, no cloud database, no account, no ads,
and no telemetry. After the import has finished, playback needs zero network access.

```
playlist link (Spotify / YouTube Music) or songs.txt / tracks.json
        │
        ▼
  importer.py ── yt-dlp search + scoring ── ffmpeg transcode/normalize ── library/audio/*.m4a
        │                                      ├── library/cover/* + lyrics/*
        └── library/manifest.json  ──►  library/playlist.json + playlist.m3u8
                                                          │
                                                          ▼
                                                     player.html
                                           web / Electron / Capacitor Android
```

---

## 1. Requirements

| Tool | Version | Why |
| --- | --- | --- |
| Python | 3.10+ | runs `importer.py` |
| ffmpeg + ffprobe | 6.0+ | transcode to AAC `.m4a`, loudness normalization, duration checks |
| yt-dlp | current (`2025.11.12`+) | YouTube / YouTube Music search and audio download |
| JS runtime | Deno 2.3+ (recommended), Node 22+, QuickJS, or Bun | yt-dlp needs it to solve YouTube JS challenges and expose the best audio formats |
| Node.js + npm | 20+ | only for the app shells (`npm install`, Electron, Capacitor) |

`yt-dlp` is only needed for importing. `--verify` and `--export-only` work without it. Playing
music needs neither Python nor yt-dlp — only the player and its audio files, so the installed
desktop app and the APK play fine on a machine without the import tools.

## 2. Setup

From this folder:

```bash
# 1. Python dependency (the [default] extra bundles the EJS challenge solver scripts)
python3 -m pip install -U "yt-dlp[default]"

# 2. ffmpeg
#    Debian/Ubuntu:  sudo apt install ffmpeg
#    Fedora:         sudo dnf install ffmpeg
#    macOS:          brew install ffmpeg
#    Windows:        winget install Gyan.FFmpeg
ffmpeg -version

# 3. a JavaScript runtime (Deno recommended)
#    https://docs.deno.com/runtime/getting_started/installation/
deno --version    # or: node --version  (needs 22+)

# 4. optional: the app shells (Electron + Capacitor)
npm install
```

`player.html` itself still has no dependencies and no build step — `npm install` is only needed for
the native shells described in the next section.

## 3. Desktop and mobile apps

The UI is one HTML file, so the "apps" are thin native shells around it: the same `player.html`,
the same CSS, the same JavaScript. Nothing is rewritten or duplicated.

### 3.1 Desktop (Electron)

```bash
npm install      # once: Electron + Capacitor CLI (~270 MB, mostly the Electron binary)
npm start        # run from the source folder

npm run dist     # build the installer -> dist/Local Music-1.0.0.AppImage + dist/*.rpm
```

**Installing it.** `npm run dist` produces two ways to install the same app:

* `dist/Local Music-1.0.0.AppImage` — `chmod +x` it, then double-click or run it. Nothing is
  installed system-wide.
* `dist/local-music-app-1.0.0.x86_64.rpm` — `sudo dnf install ./dist/local-music-app-1.0.0.x86_64.rpm`
  on Fedora/Nobara (`.deb` is the equivalent target on Debian/Ubuntu: change `rpm` to `deb` in the
  `build.linux.target` list), which also adds the *Local Music* entry to your desktop menu.

An installed copy keeps its library in `~/.config/Local Music/library`, because the app bundle is
read-only; the source checkout keeps using `local-music-app/library`. Re-run `npm run dist` after
changing `player.html` or `importer.py`.

What the desktop shell adds on top of the plain page:

* **Paste a link, press Import.** The bar under the header takes a Spotify, YouTube Music or
  YouTube playlist link and imports it. Leave it empty to import `songs.txt` instead. `Ctrl/Cmd+I`
  does the same from the keyboard without touching the mouse.
* **The library loads itself.** The app serves `player.html` and `library/` from a tiny HTTP server
  bound to `127.0.0.1` on a random port, and streams `library/audio/*` with HTTP range requests, so
  seeking works and there is no "Add folder" step. The *Add audio files* / *Add folder* buttons are
  hidden in the app; they only exist for the browser.
* **Live import log.** The importer runs as a separate `python3` process; its output streams into
  the log panel and the queue refreshes when it finishes. `Ctrl/Cmd+.` cancels an import,
  `Ctrl/Cmd+Shift+R` reloads the playlist, `Ctrl/Cmd+L` opens `library/` in your file manager.
* **Separate profile.** Playback state, shuffle/repeat and resume position persist in the app's own
  storage, independent of your browser.
* **LAN sync source.** Click **Sync** to start a short-lived LAN server and display a six-digit
  pairing code. A Capacitor phone can use that code to pull manifest entries, audio, covers, and
  lyrics without exposing the library beyond the local network. The server requires the exchanged
  bearer token for every library request and rejects path-like asset names.
* **Artwork and lyrics.** Imported cover art is shown in the player and song rows when available.
  On desktop, a track's `...` menu can attach a local `.lrc` file; timestamped lines are highlighted
  during playback, multiple timestamps per line are supported, and lines can be clicked to seek.

Security-wise the window is sandboxed with `contextIsolation` (no Node in the renderer) and the
local server only answers for `/player.html` and `/library/**`; any other path — including
`../` traversal attempts — returns 404.

The importer stays a separate process: the app needs `python3`, `yt-dlp` and `ffmpeg` on `PATH`,
like the CLI. If Python is missing, the log panel says so and playback keeps working. A packaged
desktop app keeps its writable library under `~/.config/Local Music/library`; the source checkout
uses the repository's `library/` directory.

### 3.2 Mobile (Capacitor)

A phone cannot run yt-dlp/ffmpeg, so imports still happen on the desktop or CLI. The mobile app is
the offline player and storage client. `scripts/sync-web.mjs` copies `player.html`,
`library/playlist.json`, `library/audio/`, and any `library/cover/` and `library/lyrics/` assets
into `www/`. The installed APK therefore starts with the current library offline; the trade-off is
APK size because bundled audio is copied into the package.

```bash
npm run sync:mobile     # build www/ from player.html + playlist/audio/artwork/lyrics
npx cap add android     # once per platform; android/ is already in this repo
npx cap add ios         # once, on macOS only
npm run mobile:sync     # after every change to player.html or the playlist
npm run mobile:open     # open the native project in Android Studio / Xcode
```

`www/` is generated output — never edit it by hand, edit the source files and re-sync. The
`@capacitor/filesystem` plugin stores synced and device-imported files in the app-private `DATA`
directory, so a picker grant is not needed again after import.

Building an APK needs JDK 17–21 and the Android SDK (platform 36 + build-tools):

```bash
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=/path/to/android-sdk
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
npm run mobile:build    # -> android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The debug APK is signed with the local debug key, so it installs from a file transfer (phone
Settings → allow install from unknown sources) or over `adb`. A Play-Store release build needs your
own signing key.

You can test the exact mobile bundle in a desktop browser without any SDK:

```bash
cd www && python3 -m http.server 8124 --bind 127.0.0.1
# open http://localhost:8124/index.html
```

The phone layout is the same page with `viewport-fit=cover` and safe-area padding, so notches and
the home indicator do not clip the controls.

**Importing files on the phone.** Choose **Import from device** to copy supported audio files
(MP3, M4A, AAC, OGG/Opus, WAV, FLAC, or WebM) into private app storage. The filename is used for
the initial artist/title when embedded tags are unavailable; duration is read through the WebView's
audio metadata. Duplicate names with different durations receive a numbered filename instead of
overwriting an existing track. Files larger than 512 MiB are rejected. The current implementation
uses Capacitor's base64 file API, so very large imports can use substantial temporary memory.

**Syncing from desktop.** Start the desktop app, click **Sync** to display a short-lived LAN address
and six-digit code, then click **Sync library** on the phone and enter both values. Pairing codes
expire after ten minutes; exchanged bearer tokens expire after thirty minutes. The phone compares
`syncKey`, byte size, and modification time and only transfers changed audio; covers and lyrics are
transferred alongside their tracks. Device-only imports are retained when reconciling desktop
content. Both devices must be on the same trusted LAN; the sync server is intentionally not an
internet service.

## 4. Quick start

```bash
# 1. Import straight from a playlist link (Spotify, YouTube Music, YouTube)
python3 importer.py "https://open.spotify.com/playlist/<id>"
#    ...or from songs.txt (one "Artist - Title" per line) with: python3 importer.py

# 2. Start the desktop app (library loads by itself)
npm install && npm start

# 3. Or build the installer: dist/Local Music-1.0.0.AppImage + dist/*.rpm
npm run dist
```

Prefer the browser, or want it on a phone? Serve the folder over localhost — the browser blocks
`fetch()` of local JSON on `file://`:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
# open http://localhost:8000/player.html, then click "Add folder" -> library/audio
```

For the native mobile shell see section 3.2. That is the whole workflow. Re-running
`python3 importer.py` later is safe and only downloads what is still missing.

## 5. Project layout

```text
local-music-app/
├── README.md
├── package.json              # Electron + Capacitor (only for the app shells)
├── capacitor.config.json     # mobile shell config (appId, webDir: www)
├── songs.txt                 # default track list (text)
├── build/icon.png            # app icon used by the installer and the launcher
├── dist/                     # generated installers (AppImage + rpm), safe to delete
├── importer.py               # importer / downloader / library builder
├── player.html               # player shell: sidebar, views, player bar, queue drawer, modal
├── ui/
│   ├── app.css               # dark theme, layout, responsive rules
│   ├── engine.js             # library, playback, queue order, smart shuffle, persistence
│   ├── ui.js                 # views, playlists, menus, Discover, import bridge
│   └── mobile.js             # Capacitor Filesystem imports, LAN sync, native file URLs
├── desktop/
│   ├── main.js               # Electron main: local library server, window, menu, importer bridge
│   └── preload.js            # the only thing the page can call (contextIsolation)
├── scripts/
│   └── sync-web.mjs          # builds www/ for the mobile shell from player.html
├── www/                      # generated: index.html + ui/ + library/playlist.json + library/audio (do not edit)
├── android/                  # generated Capacitor project (Android Studio)
└── library/
    ├── audio/                # downloaded .m4a files
    ├── cover/                # downloaded JPEG/PNG artwork
    ├── lyrics/               # downloaded or attached .lrc sidecars
    ├── manifest.json         # idempotent download records, keyed by artist-title + source id
    ├── playlist.json         # ordered export consumed by player.html
    ├── playlist.m3u8         # relative-path playlist for native players
    └── failed.json           # tracks that could not be imported, with reasons
├── tests/
│   └── test_importer.py      # offline importer and export/removal tests
```

Runtime-only directories (`library/.tmp/`, `library/.cache/`) are created automatically; they hold
partial downloads and yt-dlp's cache and are safe to delete.

## 6. Track list formats

### 6.1 `songs.txt`

```text
# comments and blank lines are ignored
Daft Punk - Get Lucky | 4:08
Fleetwood Mac - Dreams
Nina Simone – Feeling Good        # en dash also works
- The Midnight - Sunset           # bullet is stripped
```

* `Artist - Title` is the canonical form; the first `" - "` splits artist from title.
* A trailing duration hint (`| 3:45`, `| 1:02:33`) is optional but improves candidate scoring a lot.
* A line with no separator is treated as a title with no artist.
* Duplicate entries are de-duplicated by normalized key; the first occurrence wins its queue position.

### 6.2 `tracks.json`

```json
{
  "tracks": [
    { "artist": "Daft Punk", "title": "Get Lucky", "duration": 248 },
    { "artist": "Fleetwood Mac", "title": "Dreams", "duration_ms": 257000 },
    { "title": "Feeling Good", "artists": [{ "name": "Nina Simone" }] },
    { "artist": "The Midnight", "title": "Sunset", "album": "Endless Summer" }
  ]
}
```

A bare JSON array works too. `id` / `source_id` values are stored for matching; `duration` is in
seconds, `duration_ms` in milliseconds. Unknown fields are ignored.

### 6.3 Playlist links

The import source can be a link instead of a file:

```bash
python3 importer.py "https://open.spotify.com/playlist/<id>"
python3 importer.py "https://open.spotify.com/album/<id>"
python3 importer.py "https://music.youtube.com/playlist?list=<id>"
python3 importer.py "https://www.youtube.com/playlist?list=<id>"
```

* **Spotify** links are read from the public playlist/album page (`open.spotify.com/embed/...` JSON),
  so no login and no API keys are needed. That page exposes the first ~50 entries only.
* **YouTube / YouTube Music** links are listed with yt-dlp; private playlists (e.g. *Liked Music*)
  need `--cookies-from-browser firefox` (or chrome/edge).
* Track links (`.../track/<id>`) are rejected with a clear message — a playlist or album is what
  this reads. Single songs belong in `songs.txt`.
* A failed link stops the run with exit code 2 and an explanation; it never silently imports
  `songs.txt` instead.

**Optional: full Spotify playlists.** The embed page is shortened, so a longer playlist needs the
Web API:

1. Create an app at <https://developer.spotify.com/dashboard>.
2. Export the credentials in your shell (never commit them):

   ```bash
   export SPOTIFY_CLIENT_ID="..."
   export SPOTIFY_CLIENT_SECRET="..."
   ```

3. Import the same link. The importer uses the client-credentials flow
   (`GET /v1/playlists/{id}/items`, paginated, one re-auth on expiry, `Retry-After` on 429) and
   skips `is_local` entries and non-track items. If that call fails for any reason (403 for a
   playlist your app does not own is a development-mode restriction, 401, empty result, network)
   it prints a warning and falls back to the public page.

Spotify is only a track-list source. Audio always comes from yt-dlp + ffmpeg.

## 7. What the importer does

### 7.1 Candidate scoring

For each track it runs `ytsearch5:<artist> <title>`, then ranks the results:

| Signal | Effect |
| --- | --- |
| Title similarity (accent-folded, bracketed noise removed) | dominant, 0–55 points |
| Exact title / title contained in candidate title | +22 / +12 |
| Artist in title / artist in channel | +12 / +10 |
| Channel ends in `- Topic`, `official`, `VEVO` | +8 / +5 / +4 |
| "official audio" in title | +6 |
| Duration compared with the expected duration | +12 (≤2s) … −40 (>45s off) |
| Lyric re-upload | −2 |
| `live`, `remix`, `cover`, `slowed`, `reverb`, `8D`, `nightcore`, `sped up`, `instrumental`, `karaoke`, `reaction`, `tutorial`, `1 hour`, `loop`, `mashup`, `full album`, … | −16 … −35 each |
| View count | +0…+4 (tiebreaker only) |

Noise penalties are only applied when the *wanted* title does not itself contain that word (so
"Live Forever" is not punished for "live"). Live and upcoming streams are dropped outright. A result
below `--min-score` (default 25) is treated as a failure instead of downloading a wrong track.

### 7.2 Download, transcode, atomic write

1. yt-dlp downloads `bestaudio/best` into `library/.tmp/<uuid>/`.
2. ffmpeg transcodes to AAC `.m4a` at `--bitrate` (default 192k), strips video and old metadata,
   embeds `title`, `artist`, `album`, `comment` (source URL) and `encoded_by`.
3. Loudness is normalized to EBU R128 (`loudnorm=I=-16:TP=-1.5:LRA=11`) unless `--no-normalize`.
4. The finished file is `os.replace()`d into `library/audio/` — same filesystem, so the move is
   atomic. A crashed import leaves a temp file, never a half-written track under a real name.
5. `library/manifest.json` and both playlist exports are rewritten atomically (temp file + fsync +
   `os.replace`) after every successful track.
6. Transient failures (timeouts, resets, HTTP 5xx/429, fragment errors) are retried up to 3 times
   with exponential backoff and jitter. Permanent failures are recorded and the batch continues.

### 7.3 Idempotency

`manifest.json` is keyed by the normalized `"artist - title"` string, and each record also stores the
source video id. On the next run:

* record exists **and** the audio file exists → skipped (`--force` overrides);
* record exists **but** the file was deleted → re-downloaded;
* new track → searched and downloaded;
* a track that failed last time is simply retried (and removed from `failed.json` on success).

Filenames are `"<Artist> - <Title>.m4a"`, sanitized for FAT/NTFS/exFAT (`/ \ : * ? " < > |` removed,
120-char cap). On a name collision between different videos, ` [<videoId>]` is appended.

### 7.4 Exports

* `library/playlist.json` — `{ version, generatedAt, trackCount, tracks[] }` where each track has
  `title`, `artist`, `fileName`, `path` (`audio/...`), `duration`, `syncKey`, `sizeBytes`,
  `modifiedAt`, and optional `cover` / `lyrics` paths. Ordered by the original track-list order,
  then alphabetically. This is what the web and mobile players load.
* `library/playlist.m3u8` — `#EXTM3U` + `#EXTINF` + **relative** `audio/<file>` paths, so VLC,
  foobar2000, mpv, Poweramp, Musicolet, etc. can read the library without editing.
* `library/failed.json` — `{ failures: [{ key, artist, title, reason, attemptedAt, candidates[] }] }`,
  capped at 500 entries, newest per track. Each entry includes the top 5 scored candidates so you can
  see why a track was rejected.

## 8. Command reference

```text
python3 importer.py [options]

Track list
  LINK                         positional: Spotify / YouTube Music / YouTube playlist link
  --playlist URL               same as LINK
  --input PATH                 songs.txt / tracks.json (default: songs.txt, else tracks.json)
  --source {auto,songs,json}   which local file to use when no link is given
  --limit N                    import at most N tracks

Download
  --results N                  search results to score (default: 5)
  --min-score FLOAT            reject the best candidate below this score (default: 25)
  --bitrate RATE               AAC bitrate (default: 192k)
  --no-normalize               skip loudness normalization
  --force                      re-download tracks already in the manifest
  --cookies-from-browser NAME  e.g. chrome, firefox, edge (restricted/age-gated videos)
  --sleep SECONDS              jittered pause between worker downloads (default: 0.15)
  --jobs N                     bounded parallel download workers
  --candidate-attempts N       ranked candidates to try after verification failures
  --review-margin FLOAT        flag close candidate scores as needsReview

Library
  --dry-run                    print the resolved track list, download nothing
  --export-only                rebuild playlist.json + playlist.m3u8 from the manifest
  --verify                     check every manifest file exists, is non-empty and decodable
  --covers                     backfill missing cover art from stored YouTube source ids
  --retry-failed               retry entries recorded in library/failed.json
  --remove KEY                 remove one track and its owned audio/artwork/lyrics
  --attach-lyrics KEY          read an LRC file from stdin and attach it to a manifest entry
  --recommend [N]              print N online recommendations as JSON (default 12); logs go to stderr
  --verbose, -v                extra detail
```

Exit codes: `0` success, `1` some tracks failed (details in `library/failed.json`), `2` missing tool
or bad configuration, `130` interrupted (partial progress is always saved).

Examples:

```bash
python3 importer.py "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" --dry-run
python3 importer.py "https://music.youtube.com/playlist?list=PLxxxxxxxx" --limit 20
python3 importer.py --dry-run
python3 importer.py --limit 3 --verbose
python3 importer.py --input tracks.json --min-score 35
python3 importer.py --force --cookies-from-browser firefox
python3 importer.py --verify
python3 importer.py --export-only
python3 importer.py --covers
python3 importer.py --retry-failed
python3 importer.py --remove "Artist - Title.m4a"
cat song.lrc | python3 importer.py --attach-lyrics "Artist - Title.m4a"
python3 importer.py --recommend 8
```

## 9. The player

The player is `player.html` (shell markup) plus `ui/app.css`, `ui/engine.js` and `ui/ui.js`: plain
HTML, CSS and vanilla JavaScript, no build step, no framework, no CDN. The same files are the UI for
all three targets; the desktop shell adds the local library server and the import bridge, the mobile
shell adds the native WebView and the bundled library.

Layout: a sidebar (Home / Songs / Liked / Stats / Discover + your playlists), a scrolling content
area, a fixed player bar at the bottom and a slide-in queue drawer. Below 720 px the sidebar becomes
a horizontal strip and the player bar collapses to two rows, so the phone build uses the same markup.

### 9.1 Loading the library

1. Serve the folder (the browser blocks `fetch()` of local JSON on `file://`):

   ```bash
   python3 -m http.server 8000 --bind 127.0.0.1
   ```

2. Open <http://localhost:8000/player.html>. The player fetches `library/playlist.json` and shows
   the full queue, including files that are not attached yet ("file not loaded").
3. Browsers cannot read `library/audio/` by themselves. Click **Add folder** in the sidebar and
   select `library/audio` (or **Add audio files**, or drag files onto the page).
   Tracks are matched by `fileName`, so selection order and batching do not matter — a partial
   selection simply plays that subset, and adding the rest later fills in the queue.
4. If a track has a `cover` or `lyrics` entry, the player loads those local assets. Lyrics panels
   are hidden for tracks without a sidecar; `.lrc` timestamp lines are highlighted and clickable.

If `playlist.json` is missing or empty, any audio files you select become the library, with
`Artist - Title` parsed from each filename.

### 9.2 Controls

| Control | Behaviour |
| --- | --- |
| Play / Pause | also `Space` |
| Previous | if the current track is past 3 s it restarts, otherwise it goes to the previous track |
| Next | next in the current queue order; stops at the end unless Repeat is `All` |
| Seek | click/drag the progress bar, or `←` / `→` (±5 s) |
| Queue | click any row to jump to it; the active row is highlighted and scrolled into view |
| Queue editing | drag a queued row, use its `Play next`, `Add to queue`, or remove controls; manual queue order is persisted |
| Shuffle (`S`) | cycles `Off` → `Shuffle` → `Smart`. Both modes keep the current track first, so playback never jumps when you toggle it mid-song. `Shuffle` is a plain Fisher–Yates shuffle |
| Repeat (`R`) | `Off` → `All` → `One` (a `1` badge appears on the button) |
| Speed | click the speed button to cycle 1x, 1.25x, 1.5x, and 2x |
| Crossfade | click **Fade off** to cycle a 2–12 second crossfade; it uses a second audio element |
| Sleep | click **Sleep** to cycle a 15/30/60 minute timer; playback pauses when it expires |
| Volume | slider (the slider is hidden on narrow screens where the phone's own volume applies) |
| Likes / stats | use a song's `...` menu to like it; **Liked** and **Stats** are local views with play, skip, and listened-time totals |
| `N` / `P` | next / previous |
| `/` | jump to Songs and focus the search box |
| `Esc` | close the modal, the track menu or the queue drawer |

`navigator.mediaSession` is wired for `play`, `pause`, `previoustrack`, `nexttrack`, `stop`,
`seekto`, `seekbackward` and `seekforward`, with `MediaMetadata` (title/artist/album) and
`setPositionState`, so lock-screen, headset and media-key controls work in Chromium-based browsers,
Firefox and Safari where supported.

The command palette is available from **Search** or `Ctrl/Cmd+K`. It can navigate views, toggle
shuffle/repeat, open the queue, set playback speed, and start the sleep timer. The web target
stores likes, statistics, queue/session state, and custom playlists in `localStorage`; these are
device-local and are not part of desktop LAN sync.

### 9.3 Playlists

Custom playlists are local, not files on disk. **New playlist** in the sidebar (or `+ New playlist`
under any song's `⋯` menu) opens a small dialog; the sidebar lists every playlist with its track
count, and a playlist page has **Play**, **Smart shuffle**, **Rename** and **Delete**.

To add or remove a song, open the `⋯` menu on any row: each playlist is listed with a checkmark for
membership, so one click toggles it. Removing a song from a playlist never deletes the audio file.

Playlists are stored in `localStorage` under `localMusic.playlists.v1` as
`[{id, name, keys, createdAt}]`, where `keys` are the same `fileName` values as `playlist.json`. That
means they survive reloads and app restarts, and work offline on the phone. Tracks that are no longer
in the library are ignored when the playlist is rendered.

### 9.4 Smart shuffle and Discover

**Smart shuffle** (`S` until the button turns green with a dot) builds the queue with a weighted pick
instead of a uniform shuffle: each candidate is ~1.4× more likely if its artist differs from the
track before it, and ~2.5× more likely if it was not among the last 10 tracks you played. Recently
played tracks are pushed towards the end, so a shuffled playlist does not immediately repeat what you
just heard. Plain **Shuffle** remains available for a truly random order.

**Discover** needs a network connection and the desktop app: the page asks the desktop bridge for
related tracks, which runs `python3 importer.py --recommend 12`. The importer takes your three newest
library entries and reads the YouTube Music radio for each one (`...&list=RDAMVM<videoId>`), then
filters out anything already in the library. Each card has an **Add** button that runs the normal
import pipeline for that video, so the track is downloaded, normalised and appears in your library.
On the phone the app is fully offline, so the page explains that instead of showing cards.

The same data is available from a terminal:

```bash
python3 importer.py --recommend        # JSON list of 12 picks
python3 importer.py --recommend 5      # fewer picks
```

Stdout is pure JSON (progress goes to stderr), so it can be piped into anything.

### 9.5 Persistence

`localStorage` key `localMusic.session.v2` stores:

* the shuffle mode (`off` / `shuffle` / `smart`) and the repeat mode,
* the last played track (`fileName`) and the playback position in seconds,
* volume, playback speed, crossfade setting, sleep timer, and the current/manual queue,
* the last 40 played tracks, which smart shuffle and "Recently played" use.

`localMusic.stats.v1` stores liked track keys plus per-track play count, skip count, listened
seconds, and last-played time. `localMusic.playlists.v1` stores custom playlists. These stores are
independent of the imported manifest and are intentionally not uploaded during LAN sync.

On reopen the track is restored **paused** at the saved position (browsers forbid autoplay without a
gesture) with a banner telling you where it resumed. State is written on changes, on pause, every
~4 s during playback, and on `pagehide`/tab hide. If storage is blocked (private window, hardened
settings), the player says so and keeps working without persistence.

### 9.6 Opening via `file://`

Double-clicking `player.html` "works" for playback but:

* `fetch('library/playlist.json')` is blocked by CORS on `file://`, so the queue is empty until you
  add files manually (filename-derived titles),
* `localStorage` may be partitioned or unavailable,
* some browsers refuse `blob:` audio loading.

Use the local static server for the intended experience. It only listens on `127.0.0.1`; stop it with
`Ctrl+C`.

### 9.7 Offline

Once the audio files are downloaded and loaded, play/pause/seek/queue clicks do not touch the network.
The page itself comes from your local server, which also works with Wi-Fi/internet disabled. To use the
player with no server at all, keep the audio files and open them directly; the queue/manifest view
needs the JSON fetch, so the local server is the simplest option.

## 10. Verification checklist

Run these from `local-music-app/`. Each step lists what you should see.

```bash
# 1. Syntax / environment
python3 -m py_compile importer.py && echo OK
node --check desktop/main.js && node --check desktop/preload.js
node --check ui/engine.js && node --check ui/ui.js && node --check ui/mobile.js
python3 importer.py --help | head -20

# 2. Offline regression tests
python3 -m unittest discover -s tests -v
#    -> importer matching, export metadata, attachment, retry and safe removal tests pass.

# 3. Track-list parsing, no network
python3 importer.py --dry-run
#    -> "Loaded 6 track(s) to import" and a numbered list, "Dry run only: nothing was downloaded."

# 4. Exports are valid JSON
python3 -c "import json;[json.load(open(p)) for p in ('library/manifest.json','library/playlist.json','library/failed.json')];print('JSON OK')"

# 5. Real download of one track (needs yt-dlp + ffmpeg + a JS runtime)
python3 importer.py --limit 1 --verbose
#    -> "saved: <Artist> - <Title>.m4a"; re-running exits 0 and prints "cached: ..."

# 6. Idempotency + integrity
python3 importer.py --verify
#    -> "OK  <Artist> - <Title>  [x MiB, y s]" and "All tracks verified."

# 7. Exports match the library
python3 -c "import json;d=json.load(open('library/playlist.json'));print(d['trackCount'], d['tracks'][0]['fileName'])"
cat library/playlist.m3u8

# 8. Player
python3 -m http.server 8000 --bind 127.0.0.1
#    open http://localhost:8000/player.html, click "Add folder" -> library/audio
#    press play; then toggle Shuffle twice mid-track (player must not jump),
#    change Repeat to All and let the last track end, seek/prev/next from the queue.
#    Reload the page: same track, same position (paused), same shuffle/repeat state.
#    Disconnect from the network: playback continues unchanged.
```

### 10.1 App shells

```bash
# 8. Desktop app
npm start
#    -> a window opens with the library already queued (no "Add folder")
#    -> paste a playlist link in the bar above the queue, press Import: the log panel streams
#       python3 importer.py ... <link> and the queue refreshes when it finishes
#    -> Ctrl+Shift+R reloads the playlist, Ctrl+L opens library/, Ctrl+. cancels an import
#    -> Sync displays a LAN address and expiring pairing code; the phone can pull changed files
#       and attached cover/lyrics assets. A track menu can attach an .lrc file.

# 9. Installer
npm run dist
chmod +x "dist/Local Music-1.0.0.AppImage" && "dist/Local Music-1.0.0.AppImage"
#    -> the installed app opens with an empty queue until it has a library of its own:
#       ~/.config/Local Music/library (paste a link and import, or copy library/ there)
#    -> a launcher is at ~/Desktop/local-music.desktop and in the application menu

# 10. Mobile bundle
npm run sync:mobile
python3 -c "import json;d=json.load(open('www/library/playlist.json'));print('bundled', d['trackCount'])"
ls www/library/audio | wc -l
npm run mobile:build    # -> android/app/build/outputs/apk/debug/app-debug.apk
unzip -l android/app/build/outputs/apk/debug/app-debug.apk | grep -c 'assets/public/library/audio/'
#    -> http://localhost:8124/index.html shows the queue with the file pickers (no Import bar)
#    -> on Android, use Import from device, restart, and confirm the private copy remains;
#       pair with the desktop Sync dialog and confirm unchanged files are not retransferred
```

## 11. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `yt-dlp is not installed` | `python3 -m pip install -U "yt-dlp[default]"` (use a venv if your distro blocks system pip) |
| `ffmpeg was not found on PATH` | install ffmpeg (see Setup); on Windows reopen the terminal so PATH refreshes |
| "no JavaScript runtime found" / formats missing / HTTP 403 from YouTube | install Deno (recommended) or Node 22+. yt-dlp uses it to solve YouTube's JS challenges. `--cookies-from-browser firefox` also helps for age/region-gated videos |
| Every candidate is rejected | raise detail with `-v`, then lower `--min-score 15`, or improve the entry (add `| 3:45` duration, spell the artist exactly as on the upload) |
| Spotify link imports only the first ~50 tracks | the public embed page is shortened. Create a Spotify app (https://developer.spotify.com/dashboard), then `export SPOTIFY_CLIENT_ID=… SPOTIFY_CLIENT_SECRET=…` to read the full playlist through the Web API |
| Spotify link fails with HTTP 403/404 | the playlist is private or deleted; make it public, or use *Share → Copy link* again. Import needs no Spotify login |
| YouTube Music link imports nothing | private playlists (for example "Liked Music") need your cookies: `python3 importer.py <link> --cookies-from-browser firefox` |
| Track downloads but sounds wrong | inspect `library/failed.json` candidates, add a duration hint, or pin the exact version by editing `songs.txt` title |
| Player shows "file not loaded" | the audio files are not selected yet: **Add folder** → `library/audio` |
| Cover or lyrics are missing | run `python3 importer.py --covers` for stored YouTube artwork, or attach an `.lrc` from a desktop track's `...` menu; confirm the exported path exists under `library/cover/` or `library/lyrics/` |
| Desktop-to-phone sync is refused | both devices must be on the same LAN; regenerate the ten-minute pairing code, use the displayed host/port, and enter the six digits exactly |
| Android device import fails | confirm the file is a supported audio type and below 512 MiB; the current Filesystem bridge buffers the selected file as base64, so retry smaller batches if memory is tight |
| Player queue empty | serve over `http://localhost`, not `file://`, and run the importer first |
| No position/state after reload | storage blocked (private window, browser settings); the banner says so |
| Import interrupted | just run it again; finished tracks are skipped |
| `npm start`: "SUID sandbox helper binary was found, but is not configured correctly" | your distro restricts unprivileged namespaces: run `npm start -- --no-sandbox`, or `sudo chown root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox` |
| Desktop app: "could not run python3" in the import log | Python is not on the app's `PATH`; start the app from a shell where `python3 importer.py --dry-run` works |
| Android build: `JAVA_HOME`/SDK not found | install a JDK 17–21 and the Android SDK, then export `JAVA_HOME`/`ANDROID_HOME` and write `android/local.properties` as shown in 3.2 |
| Installed app: import log says python3/ffmpeg is missing | the installer bundles the player, not the import tools; install Python 3 + `yt-dlp[default]` + ffmpeg for link imports (playback is unaffected) |
| Installed app shows an empty queue | its library is `~/.config/Local Music/library`; import a playlist there once, or copy an existing `library/` folder into it |
| AppImage will not start: "FUSE" error | your system lacks libfuse: `sudo dnf install fuse-libs`, or run `APPIMAGE_EXTRACT_AND_RUN=1 ./dist/Local\ Music-1.0.0.AppImage` |
| `npm start` opens a blank window | the library server failed to bind: check the terminal for the error, then retry |

## 12. Design notes and limits

* **Local-first:** the only network use is the import itself (Spotify metadata + YouTube download).
  Playback, queue state and exports are entirely local.
* **No secrets in the repo:** Spotify credentials come from environment variables.
* **Crash safety:** every JSON/file write is temp-file + `os.replace`, manifest saves happen after each
  successful track, and partial downloads stay in `library/.tmp/`.
* **Politeness and throughput:** downloads use bounded workers (`--jobs`) with `--sleep` jitter;
  transient failures retry with backoff and permanent failures never abort the rest of the batch.
* **One UI, three shells:** `player.html` is served directly by Electron, copied into the Capacitor
  bundle by `scripts/sync-web.mjs`, and still works on its own behind any static server.
* **Narrow bridge:** the page only sees `window.localMusic` (import, menu actions, library base URL,
  storage, lyrics attachment, and sync info). Everything else — file system, process spawning, ports
  and path validation — stays in `desktop/main.js`.
* **Determinism:** queue order follows the input file, then artist/title; the manifest is the single
  source of truth for exports.
* **Known limits:** the mobile bridge currently buffers selected and synced binaries as base64, so
  large transfers use temporary memory; embedded tag extraction is not yet available for device
  imports; and Android `CapacitorHttp`/`convertFileSrc` behavior still needs validation on a
  physical device. Crossfade uses a second HTML audio element and should be tested on each target.
  Spotify full-playlist access still requires client credentials; without them the public embed is
  limited to roughly 50 entries. Packaging and emulator/LAN integration checks are environment
  dependent and are not represented by the offline unit suite.
* **Legal:** download only content you are allowed to keep. This tool is for personal, offline
  copies of playlists you have the rights to.
