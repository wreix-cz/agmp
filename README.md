<div align="center">

# Local Music

**Your playlists. Your device. Fully offline playback.**

A local-first playlist importer and music player for desktop and Android, built with
plain HTML, CSS and JavaScript.

[Desktop](#desktop) · [Android](#android) · [Importer](#importer-reference) · [Features](#feature-overview) · [Contributing](#contributing)

</div>

> [!NOTE]
> Audio belongs to you and stays in your library. Local Music does not use a cloud database,
> analytics, ads or account system.

## Why Local Music

Local Music turns playlist links or song lists into a searchable, offline library and plays it
through a shared player on the browser, Electron desktop and Capacitor Android.

- Keep the manifest and audio in a folder you control
- Download and transcode tracks once, then play them without a network
- Continue listening through the same UI on desktop or mobile
- Edit the queue, save playlists, track listening history and like tracks
- Sync only the library metadata and media you choose over a local network

## What ships today

| Target | Status | Main entry point |
| --- | --- | --- |
| **Web player** | Working | [`player.html`](player.html) behind a static server |
| **Desktop** | Working build; public release hardening remains | Electron through `desktop/main.js` |
| **Android** | Source and device-import foundations exist; build release validation remains | Capacitor project in [`android/`](android/) |

Desktop AppImage and RPM artifacts can be produced today. Public signing, an automatic updater,
bundled importer tools and a signed Play Store release are not yet complete.

## Feature overview

- Shared Home, Songs, Liked, Stats, Discover and custom-playlist views
- Import from Spotify, YouTube Music, YouTube or a local song list
- Parallel importer with cached search results, retries and stronger candidate matching
- Cover art, synchronized `.lrc` lyrics and lyrics attachment on desktop
- Play next, add to queue, reorder, remove, clear and persisted manual queue
- Off, shuffle and smart-shuffle modes
- Likes, play counts, skips and listened-time statistics
- Playback speed, crossfade, sleep timer, seek, repeat and volume controls
- Keyboard shortcuts and command palette
- LAN pairing and library sync
- Android private-storage imports and collision-safe filenames
- Desktop track deletion and storage readout
- Crash-safe manifest/export writes and offline retry queue

## Project layout

```text
.
├── player.html              Shared player shell
├── ui/
│   ├── engine.js            Playback, queue, persistence and library state
│   ├── ui.js                Rendering and UI interactions
│   ├── mobile.js            Capacitor storage and LAN sync
│   └── app.css              Shared responsive styles
├── importer.py              Playlist, matching, download and export pipeline
├── desktop/
│   ├── main.js              Electron process and local library server
│   └── preload.js           Restricted desktop bridge
├── scripts/sync-web.mjs     Generates the Capacitor web bundle
├── tests/test_importer.py   Offline importer regression tests
├── library/                 Local, generated/user library data
├── android/                 Capacitor Android project
├── dist/                    Generated desktop installers
└── AGENT_PROMPT.md          Full project handoff and implementation status
```

`library/`, `android/build`, `dist/`, `node_modules/`, `.toolchain/` and `www/` are local/generated
paths and are excluded from Git. Never commit private music, credentials or signing keys.

## Requirements

### Importer

| Dependency | Purpose |
| --- | --- |
| Python 3.10+ | Runs `importer.py` |
| ffmpeg / ffprobe | Transcoding, loudness normalization and duration checks |
| yt-dlp | Playlist metadata, search and downloading |
| JavaScript runtime | yt-dlp YouTube challenge solving; Deno or Node 22+ |
| Spotify API credentials | Optional; required for complete Spotify playlist pagination |

### Desktop

- Node.js 20+
- npm
- Electron dependencies from `package.json`

### Android

- JDK 17–21
- Android SDK and platform/build tools
- Capacitor CLI

> [!IMPORTANT]
> The desktop player and Android app do not require yt-dlp or ffmpeg after audio is already in the
> library. Importing playlist links does require those tools.

## Setup

Clone the repository and install JavaScript dependencies:

```bash
git clone https://github.com/wreix-cz/agmp.git
cd agmp
npm install
```

Install the importer dependencies:

```bash
python3 -m pip install -U "yt-dlp[default]"
```

Install ffmpeg:

```bash
# Fedora / RHEL
sudo dnf install ffmpeg

# Debian / Ubuntu
sudo apt install ffmpeg

# macOS
brew install ffmpeg

# Windows
winget install Gyan.FFmpeg
```

Verify the tools:

```bash
python3 importer.py --dry-run
python3 -m py_compile importer.py
ffmpeg -version
node --version
```

## Quick start

### 1. Create a song list

Use [`songs.txt`](songs.txt), or add a JSON file such as `tracks.json`:

```text
Clover - Pretty Scene Girl!
Daft Punk - Get Lucky | 248
Fleetwood Mac - Dreams
```

The importer supports Spotify, YouTube Music, YouTube, plain title/artist lines and JSON track data.
Plain lines may include a pipe-separated duration hint:

```text
Artist - Title | 3:45
```

### 2. Import a playlist

```bash
python3 importer.py "https://open.spotify.com/playlist/…"
```

Or import `songs.txt`:

```bash
python3 importer.py
```

Useful options:

```bash
python3 importer.py --jobs 4 --sleep 1
python3 importer.py --covers
python3 importer.py --retry-failed
python3 importer.py --dry-run
python3 importer.py --export-only
python3 importer.py --verify
python3 importer.py --recommend 10
```

Run `python3 importer.py --help` for the complete command reference.

### 3. Run the web player

```bash
python3 -m http.server 8125 --bind 127.0.0.1
```

Open <http://127.0.0.1:8125/player.html>.

Because browsers cannot directly read arbitrary local folders, use **Add audio files** or
**Add folder** and select `library/audio`. Tracks are matched using their exported `fileName`.

### 4. Run Electron

```bash
npm start
```

Electron serves the player and local library, exposes the importer IPC bridge and provides
desktop-specific import, delete and lyrics controls.

### 5. Build desktop installers

```bash
npm run dist
```

Generated Linux artifacts are written to `dist/`:

- `dist/Local Music-1.0.0.AppImage`
- `dist/local-music-app-1.0.0.x86_64.rpm`

An AppImage can run directly after making it executable:

```bash
chmod +x "dist/Local Music-1.0.0.AppImage"
"./dist/Local Music-1.0.0.AppImage"
```

## Desktop

The desktop shell adds:

- Local library HTTP server with range requests
- Streaming importer output
- LAN pairing and synchronization
- Storage and deletion controls
- Desktop `.lrc` attachment picker
- OS media-session integration
- Packaged-library and clean-profile behavior
- IPC isolation with no Node.js access in the renderer

Desktop library location:

```text
Source checkout: ./library
Packaged app:    ~/.config/Local Music/library
```

`Ctrl/Cmd+I` starts an import. `Ctrl/Cmd+.` cancels the active import.

## Android

Generate the shared mobile bundle:

```bash
npm run sync:mobile
```

This recreates `www/` from the shared player and copies playlist, audio, cover and lyrics assets.
Do not edit `www/` directly.

Set up a local JDK 17–21 and Android SDK:

```bash
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=/path/to/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
```

Write the SDK location:

```bash
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
```

Build the debug APK:

```bash
npm run mobile:build
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The Android app supports:

- Offline bundled playback
- Capacitor private-storage library files
- Audio-file picker imports
- Collision-safe import names
- LAN sync while both devices are on the same network
- Synced covers and `.lrc` lyrics
- Restart persistence

A public Android release still requires JDK/SDK pinning, signed APK/AAB builds and device validation.
The JDK 25 host currently used for development cannot build this Android project; Gradle rejects
class-file major version 69.

## LAN sync

1. Open Sync on desktop.
2. A six-digit code appears for ten minutes.
3. Enter the code and host/port in the Android app.
4. Download only changed manifest entries and assets.

Sync requests use short-lived bearer tokens. Asset names are restricted to safe library basenames;
separators, null bytes and path-like names are rejected.

Both devices must be on the same network. The desktop server binds to all LAN interfaces on a random
port. Only enable it when you intentionally want to pair a device.

## Importer reference

### Input formats

- Spotify, YouTube Music or YouTube playlist URL
- One `Artist - Title` track per line
- Title/artist with a duration hint: `| 3:45` or `| 225`
- JSON with title, artist, album, duration and optional URL fields

### Matching behavior

The importer:

- Uses flat YouTube search extraction
- Caches search results on disk
- Limits concurrent downloads
- Retries transient failures
- Applies duration pre-filtering and candidate verification
- Uses metadata, ISRC and match-margin information when available
- Records failed candidates for later reconstruction

### Spotify credentials

Without credentials, Spotify import falls back to the public embed page and may be limited to roughly
50 tracks.

For full playlist access:

```bash
export SPOTIFY_CLIENT_ID="your-client-id"
export SPOTIFY_CLIENT_SECRET="your-client-secret"
python3 importer.py "https://open.spotify.com/playlist/…"
```

Create an app in the Spotify Developer Dashboard. Do not commit credentials or place them in
`localStorage`, source files or packaged settings.

### Covers and lyrics

```bash
python3 importer.py --covers
python3 importer.py --attach-lyrics "Artist - Title" /path/to/file.lrc
python3 importer.py --remove "Artist - Title"
```

Cover and lyrics files are stored separately and referenced by the manifest and playlist exports.
Removal only deletes assets owned by the selected manifest entry.

## Player controls

| Control | Default behavior |
| --- | --- |
| Play / Pause | `Space` |
| Previous / Next | `P` / `N` |
| Seek backward / forward | `←` / `→` |
| Search | `/` or `Ctrl/Cmd+K` |
| Shuffle | `S`; cycles off, shuffle and smart |
| Repeat | `R`; cycles off, all and one |
| Queue | Open the queue drawer |
| Sleep timer | 15, 30 or 60 minutes |
| Speed | 1×, 1.25×, 1.5× or 2× |
| Crossfade | 2–12 seconds using a second audio element |
| Escape | Close dialogs, menus and drawers |

The player also exposes browser Media Session controls for supported platforms.

## Persistence

Local web/Electron storage is kept separately from the library:

| Key | Contents |
| --- | --- |
| `localMusic.session.v2` | Current track, position, queue, shuffle, repeat, volume and playback timers |
| `localMusic.stats.v1` | Likes, play counts, skips, listened seconds and timestamps |
| `localMusic.playlists.v1` | Custom playlist metadata and track keys |

Desktop and mobile libraries are stored independently of these browser stores. LAN sync does not
upload likes, custom playlists or listening statistics.

## Testing and verification

Run importer tests:

```bash
python3 -m unittest discover -s tests -v
```

Check Python and JavaScript syntax:

```bash
python3 -m py_compile importer.py
for file in ui/*.js desktop/*.js scripts/*.mjs; do node --check "$file"; done
```

Verify exports and the live library:

```bash
python3 importer.py --export-only
python3 importer.py --verify
npm run sync:mobile
npm run dist
```

Release smoke checks should cover:

- clean desktop and Android storage
- restart persistence
- playlist create, rename and delete
- smart shuffle after a mid-track toggle
- queue insertion, reorder, remove and clear
- cover and `.lrc` rendering
- desktop import/delete/LAN sync
- Android import/playback/sync/reinstall
- no unexpected network or console errors

## Known limitations

- The live Chromium environment may reject some AAC/M4A streams despite `ffprobe` recognizing them as AAC-LC. MP3 or Opus/WebM compatibility is desirable for public playback builds.
- Mobile binary transfer currently uses base64 through the Filesystem plugin and may use substantial
  temporary memory for large files.
- Embedded title/artist metadata is not extracted from device imports yet.
- Android and LAN sync require real emulator or physical-device testing.
- The current host JDK 25 cannot build Android Gradle projects; JDK 17–21 is required.
- Public desktop signing, an updater, bundled importer binaries and signed Android release tooling
  remain unfinished.
- Cover and lyrics UI paths have code and tests, but the live library may not contain cover or
  `.lrc` assets.

## Troubleshooting

| Problem | Resolution |
| --- | --- |
| `yt-dlp is not installed` | `python3 -m pip install -U "yt-dlp[default]"` |
| `ffmpeg` or `ffprobe` missing | Install ffmpeg and reopen the terminal so PATH updates |
| YouTube formats missing or HTTP 403 | Install Deno or Node 22+; optionally use browser cookies |
| Spotify import stops near 50 tracks | Configure Spotify API credentials |
| Private YouTube playlist imports nothing | Supply browser cookies with `--cookies-from-browser` |
| Player says audio is missing | In the web player, select `library/audio` using Add folder |
| Queue is empty | Serve the player over HTTP and ensure `library/playlist.json` exists |
| Cover or lyrics missing | Generate covers or attach a `.lrc` sidecar |
| Desktop sync is refused | Confirm both devices share a LAN and regenerate the pairing code |
| Android build cannot find JDK/SDK | Export JDK 17–21 and Android SDK paths, then write `android/local.properties` |
| AppImage FUSE error | Install FUSE or run with `APPIMAGE_EXTRACT_AND_RUN=1` |

## Privacy

Local Music keeps library, preference and listening data on the local device. The importer contacts
Spotify and YouTube for metadata/audio. LAN sync deliberately stays local and is not an internet
service. No account, telemetry service or cloud database is required.

## Safety and rights

Download and keep only content you are authorized to use. Transmitting copyrighted material outside
your local network or publishing installers containing media can create legal obligations. The
repository excludes the current local library and generated release assets by default.

## Contributing

Before changing importer behavior, run the offline tests and verify the real 54-track manifest when
available. Before changing shared UI behavior, test the browser, Electron and mobile targets when
possible.

See [`AGENT_PROMPT.md`](AGENT_PROMPT.md) for the complete handoff, completed v1.1 work and remaining
shipping-readiness tasks.
