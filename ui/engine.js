/* Local Music — playback engine.
 *
 * Owns the library (playlist.json + picked files), URL resolution, the <audio>
 * element, queue order (including smart shuffle), progress persistence and the
 * Media Session integration. Everything here is presentation-agnostic; ui.js
 * renders it and calls into it.
 *
 * Loaded as a classic script, so its top-level bindings are shared with ui.js.
 */

var DESKTOP = window.localMusic || null;
var AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'webm'];
var REPEAT_MODES = ['off', 'all', 'one'];
var SHUFFLE_MODES = ['off', 'shuffle', 'smart'];
var STORAGE_KEY = 'localMusic.session.v2';
var PLAYLISTS_KEY = 'localMusic.playlists.v1';
var ACCOUNT_KEY = 'localMusic.account.v1';
var STATS_KEY = 'localMusic.stats.v1';
var MAX_CROSSFADE_SECONDS = 12;

var el = {
  audio: document.getElementById('audio'),
  audioNext: document.getElementById('audioNext'),
  banner: document.getElementById('banner'),
  bannerBody: document.getElementById('bannerBody'),
  bannerClose: document.getElementById('bannerClose'),
  coverText: document.getElementById('coverText'),
  npTitle: document.getElementById('npTitle'),
  npArtist: document.getElementById('npArtist'),
  likeBtn: document.getElementById('likeBtn'),
  playBtn: document.getElementById('playBtn'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  shuffleBtn: document.getElementById('shuffleBtn'),
  repeatBtn: document.getElementById('repeatBtn'),
  seek: document.getElementById('seek'),
  timeCurrent: document.getElementById('timeCurrent'),
  timeTotal: document.getElementById('timeTotal'),
  volume: document.getElementById('volume'),
  volValue: document.getElementById('volValue'),
  queueBtn: document.getElementById('queueBtn'),
  queueCount: document.getElementById('queueCount'),
  queueDrawer: document.getElementById('queueDrawer'),
  queueList: document.getElementById('queueList'),
  queueEmpty: document.getElementById('queueEmpty'),
  queueClose: document.getElementById('queueClose'),
  queueClear: document.getElementById('queueClear'),
  queueTitle: document.getElementById('queueTitle'),
  view: document.getElementById('view'),
  playlistNav: document.getElementById('playlistNav'),
  summary: document.getElementById('librarySummary'),
  status: document.getElementById('statusLine'),
  filePicker: document.getElementById('filePicker'),
  folderPicker: document.getElementById('folderPicker'),
  addFilesBtn: document.getElementById('addFilesBtn'),
  addFolderBtn: document.getElementById('addFolderBtn'),
  reloadLibrary: document.getElementById('reloadLibrary'),
  importBar: document.getElementById('importBar'),
  playlistUrl: document.getElementById('playlistUrl'),
  importBtn: document.getElementById('importBtn'),
  importPanel: document.getElementById('importPanel'),
  importTitle: document.getElementById('importTitle'),
  importLog: document.getElementById('importLog'),
  importClose: document.getElementById('importClose'),
  modal: document.getElementById('modal'),
  modalTitle: document.getElementById('modalTitle'),
  modalBody: document.getElementById('modalBody'),
  modalInput: document.getElementById('modalInput'),
  modalOk: document.getElementById('modalOk'),
  modalCancel: document.getElementById('modalCancel'),
  lyricsPanel: document.getElementById('lyricsPanel'),
  lyricsStatus: document.getElementById('lyricsStatus'),
  lyricsBody: document.getElementById('lyricsBody'),
  storageReadout: document.getElementById('storageReadout'),
  deviceImportBtn: document.getElementById('deviceImportBtn'),
  deviceFilePicker: document.getElementById('deviceFilePicker'),
  lyricsPicker: document.getElementById('lyricsPicker'),
  syncLibraryBtn: document.getElementById('syncLibraryBtn'),
  retryFailedBtn: document.getElementById('retryFailedBtn'),
  topSyncBtn: document.getElementById('topSyncBtn'),
  paletteBtn: document.getElementById('paletteBtn'),
  palette: document.getElementById('palette'),
  paletteInput: document.getElementById('paletteInput'),
  paletteResults: document.getElementById('paletteResults'),
  syncFields: document.getElementById('syncFields'),
  syncHost: document.getElementById('syncHost'),
  syncCode: document.getElementById('syncCode'),
  crossfadeBtn: document.getElementById('crossfadeBtn'),
  accountFields: document.getElementById('accountFields'),
  accountLine: document.getElementById('accountLine'),
  accountSignIn: document.getElementById('accountSignIn'),
  accountSync: document.getElementById('accountSync'),
  accountSignOut: document.getElementById('accountSignOut'),
  accountLan: document.getElementById('accountLan'),
  accountHint: document.getElementById('accountHint'),
  speedBtn: document.getElementById('speedBtn'),
  sleepBtn: document.getElementById('sleepBtn'),
  sleepCountdown: document.getElementById('sleepCountdown')
};

var state = {
  /* library */
  playlistTracks: [],
  tracks: new Map(),
  naturalOrder: [],
  files: new Map(),
  urls: new Map(),

  /* queue + playback */
  order: [],
  queueTitle: '',
  currentKey: null,
  shuffleMode: 'off',
  repeat: 'off',
  volume: 0.9,
  pendingRestore: null,
  pendingSeek: null,
  pendingQueue: null,
  manualQueue: [],
  seekDragging: false,
  persistence: true,
  lastPosition: 0,
  lastPersistAt: 0,
  recent: [],
  likes: {},
  stats: {},
  likeDecisions: {},
  deletedPlaylists: {},
  suppressAccountPush: false,
  playbackRate: 1,
  crossfade: 0,
  crossfadeTimer: null,
  crossfadeTarget: null,
  sleepAt: 0,
  mobileReady: false,
  lyricsKey: null,
  lyricsLoadingKey: null,
  lyricsLines: [],

  /* shell */
  libraryBase: DESKTOP ? String(DESKTOP.libraryBaseUrl || '') : '',
  // Without the desktop shell the page is served from a directory that holds
  // library/audio next to it: that is true for www/ and for the Android asset
  // scheme, so relative URLs work there whether or not the Capacitor bridge has
  // been injected yet.
  bundledBase: DESKTOP ? '' : 'library/audio/',
  importing: false,

  /* ui.js owns these, declared here so both files agree on the shape */
  playlists: [],
  view: { type: 'home' },
  search: '',
  recommendations: [],
  recState: 'idle',
  recError: ''
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  var total = Math.floor(seconds);
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

function stem(name) {
  return String(name).replace(/\.[^.\\/]+$/, '');
}

function basename(name) {
  var parts = String(name).split(/[\\/]/);
  return parts[parts.length - 1] || name;
}

function decodeName(name) {
  try { return decodeURIComponent(name); } catch (err) { return String(name); }
}

function extOf(name) {
  var match = /\.([^.\\/]+)$/.exec(String(name));
  return match ? match[1].toLowerCase() : '';
}

function isAudioFile(name) {
  return AUDIO_EXTENSIONS.indexOf(extOf(name)) !== -1;
}

function titleFromFileName(fileName) {
  var base = stem(decodeName(basename(fileName))).replace(/_/g, ' ').trim();
  var parts = base.split(' - ');
  if (parts.length >= 2) {
    var artist = parts[0].trim();
    var title = parts.slice(1).join(' - ').trim();
    if (artist && title) return { artist: artist, title: title };
  }
  return { artist: 'Unknown artist', title: base || 'Untitled' };
}

function shuffleInPlace(list) {
  for (var i = list.length - 1; i > 0; i -= 1) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

function readStore(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return fallback;
    var parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Banner
 * ------------------------------------------------------------------ */

function setBanner(kind, message, dismissible) {
  if (!message) {
    el.banner.hidden = true;
    el.bannerBody.textContent = '';
    return;
  }
  el.banner.hidden = false;
  el.banner.dataset.kind = kind || 'info';
  el.bannerBody.textContent = message;
  el.bannerClose.hidden = !dismissible;
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

function findFile(fileName) {
  var wanted = decodeName(basename(fileName)).toLowerCase();
  if (state.files.has(wanted)) return state.files.get(wanted);
  var wantedStem = stem(wanted);
  var found = null;
  state.files.forEach(function (file, name) {
    if (!found && stem(name) === wantedStem) found = file;
  });
  return found;
}

function ensureUrl(track) {
  if (!track) return null;
  if (state.urls.has(track.key)) return state.urls.get(track.key);
  if (track._mobileUrl) return track._mobileUrl;
  var file = findFile(track.fileName);
  if (!file) {
    // Desktop shell: the local library server streams the file.
    if (state.libraryBase) return state.libraryBase + 'library/audio/' + encodeURIComponent(basename(track.fileName));
    // Mobile shell: scripts/sync-web.mjs bundles library/audio next to index.html.
    if (state.bundledBase) return state.bundledBase + encodeURIComponent(basename(track.fileName));
    return null;
  }
  try {
    var url = URL.createObjectURL(file);
    state.urls.set(track.key, url);
    return url;
  } catch (err) {
    return null;
  }
}

function trackCoverUrl(track) {
  if (!track || !track.cover) return null;
  if (track._mobileCoverUrl) return track._mobileCoverUrl;
  var cover = String(track.cover).replace(/^\/+/, '');
  if (state.libraryBase) return state.libraryBase + 'library/' + cover;
  return 'library/' + cover;
}

function hydrateMobileUrls() {
  if (!window.LocalMusicMobile || !LocalMusicMobile.available()) return Promise.resolve();
  state.mobileReady = true;
  var jobs = [];
  state.tracks.forEach(function (track) {
    if (!track.storagePath) return;
    jobs.push(Promise.resolve(LocalMusicMobile.fileUrl(track)).then(function (url) {
      if (url) track._mobileUrl = url;
    }));
    if (track.cover) {
      jobs.push(Promise.resolve(LocalMusicMobile.fileUrl({ storagePath: 'library/' + String(track.cover).replace(/^\/+/, '') })).then(function (url) {
        if (url) track._mobileCoverUrl = url;
      }));
    }
    if (track.lyrics) {
      jobs.push(Promise.resolve(LocalMusicMobile.fileUrl({ storagePath: 'library/' + String(track.lyrics).replace(/^\/+/, '') })).then(function (url) {
        if (url) track._mobileLyricsUrl = url;
      }));
    }
  });
  return Promise.all(jobs).then(function () {
    state.tracks.forEach(function (track) { ensureUrl(track); });
  });
}

function addFiles(fileList, options) {
  var opts = options || {};
  var incoming = Array.prototype.slice.call(fileList || []);
  var added = 0;
  var replaced = 0;

  incoming.forEach(function (file) {
    if (!file || !file.name) return;
    var name = decodeName(file.name);
    if (!isAudioFile(name)) return;
    var lower = name.toLowerCase();
    var existed = state.files.has(lower);
    if (existed) replaced += 1;

    if (existed) {
      state.tracks.forEach(function (track) {
        if (decodeName(basename(track.fileName)).toLowerCase() === lower && state.urls.has(track.key)) {
          URL.revokeObjectURL(state.urls.get(track.key));
          state.urls.delete(track.key);
        }
      });
    }

    state.files.set(lower, file);
    if (!existed) added += 1;
  });

  if (!added && !replaced) {
    setBanner('warn', 'No supported audio files were found. Supported formats: ' + AUDIO_EXTENSIONS.join(', ') + '.');
    return;
  }

  applyLibrary();
  render();

  if (!opts.silent) {
    var total = state.tracks.size;
    var loaded = 0;
    state.tracks.forEach(function (track) { if (ensureUrl(track)) loaded += 1; });
    var message = 'Added ' + (added || replaced) + ' audio file' + ((added || replaced) === 1 ? '' : 's') + '. ';
    message += state.playlistTracks.length
      ? loaded + '/' + total + ' library tracks are loaded.'
      : 'Playing from the selected files because no playlist.json is available.';
    setBanner('info', message, true);
  }

  if (state.pendingRestore) applyPendingRestore();
  persistSession();
}

function enqueueKey(key, playNextFlag) {
  if (!state.tracks.has(key)) return;
  state.manualQueue = state.manualQueue.filter(function (item) { return item !== key; });
  state.order = state.order.filter(function (item) { return item !== key; });
  state.manualQueue.push(key);
  // Keep all manually inserted tracks together and in insertion order. This
  // prevents a second "Play next" from jumping ahead of the first one.
  state.order = composeManualQueue(state.order);
  state.queueTitle = 'Manual queue';
  renderQueue();
  persistSession();
}

function removeFromQueue(key) {
  if (key === state.currentKey) return;
  state.manualQueue = state.manualQueue.filter(function (item) { return item !== key; });
  state.order = state.order.filter(function (item) { return item !== key; });
  renderQueue();
  persistSession();
}

function clearQueue() {
  state.order = state.currentKey ? [state.currentKey] : [];
  state.manualQueue = [];
  state.queueTitle = '';
  renderQueue();
  persistSession();
}

function moveQueueKey(key, direction) {
  var index = state.order.indexOf(key);
  var target = index + direction;
  if (index < 0 || target < 0 || target >= state.order.length) return;
  var swap = state.order[target];
  state.order[target] = key;
  state.order[index] = swap;
  state.manualQueue = state.order.filter(function (item) {
    return state.manualQueue.indexOf(item) !== -1 && item !== state.currentKey;
  });
  renderQueue();
  persistSession();
}

/* ------------------------------------------------------------------ *
 * Library
 * ------------------------------------------------------------------ */

function buildTracks() {
  var source = state.playlistTracks.length
    ? state.playlistTracks
    : Array.from(state.files.keys()).sort().map(function (name) {
        var file = state.files.get(name);
        var actual = file && file.name ? decodeName(file.name) : name;
        var info = titleFromFileName(actual);
        return { fileName: actual, title: info.title, artist: info.artist, duration: 0 };
      });

  var tracks = new Map();
  var naturalOrder = [];

  source.forEach(function (item) {
    if (!item) return;
    var fileName = String(item.fileName || '').trim();
    if (!fileName || tracks.has(fileName)) return;

    var fallback = titleFromFileName(fileName);
    var title = String(item.title || fallback.title).trim() || fallback.title;
    var artist = String(item.artist || fallback.artist).trim() || fallback.artist;
    var duration = Number(item.duration);

    tracks.set(fileName, {
      key: fileName,
      fileName: fileName,
      title: title,
      artist: artist,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      cover: typeof item.cover === 'string' ? item.cover : '',
      lyrics: typeof item.lyrics === 'string' ? item.lyrics : '',
      needsReview: item.needsReview === true,
      storagePath: typeof item.storagePath === 'string' ? item.storagePath : '',
      syncKey: typeof item.syncKey === 'string' ? item.syncKey : '',
      sizeBytes: Number(item.sizeBytes) || 0,
      modifiedAt: Number(item.modifiedAt) || 0,
      deviceOnly: item.deviceOnly === true
    });
    naturalOrder.push(fileName);
  });

  state.tracks = tracks;
  state.naturalOrder = naturalOrder;
}

function applyLibrary() {
  var previousKey = state.currentKey;
  buildTracks();

  state.urls.forEach(function (url, key) {
    if (!state.tracks.has(key)) {
      URL.revokeObjectURL(url);
      state.urls.delete(key);
    }
  });

  // Keep an existing queue order where possible, append new tracks, drop gone ones.
  if (state.order.length) {
    var kept = state.order.filter(function (key) { return state.tracks.has(key); });
    var added = state.naturalOrder.filter(function (key) { return kept.indexOf(key) === -1; });
    state.order = kept.concat(added);
  } else {
    state.order = state.naturalOrder.slice();
  }

  state.recent = state.recent.filter(function (key) { return state.tracks.has(key); });
  if (state.pendingQueue) {
    var pending = state.pendingQueue.filter(function (key) { return state.tracks.has(key); });
    if (pending.length) state.order = pending.concat(state.order.filter(function (key) { return pending.indexOf(key) === -1; }));
    state.pendingQueue = null;
  }

  if (state.currentKey && !state.tracks.has(state.currentKey)) state.currentKey = null;
  state.manualQueue = state.manualQueue.filter(function (key, index) {
    return state.tracks.has(key) && key !== state.currentKey && state.manualQueue.indexOf(key) === index;
  });
  state.order = composeManualQueue(state.order);
  if (previousKey && state.currentKey !== previousKey) renderNowPlaying();

  state.tracks.forEach(function (track) { ensureUrl(track); });
  updateSummary();
}

function normalizePlaylistPayload(payload) {
  var list = [];
  if (!payload) return list;
  if (Array.isArray(payload)) list = payload;
  else if (Array.isArray(payload.tracks)) list = payload.tracks;
  return list.map(function (item) {
    if (!item || typeof item !== 'object') return null;
    var fileName = item.fileName || item.filename || item.file || '';
    return {
      fileName: basename(String(fileName)),
      title: typeof item.title === 'string' ? item.title : '',
      artist: typeof item.artist === 'string' ? item.artist : '',
      duration: Number(item.duration) || 0,
      cover: typeof item.cover === 'string' ? item.cover : '',
      lyrics: typeof item.lyrics === 'string' ? item.lyrics : '',
      needsReview: item.needsReview === true,
      storagePath: typeof item.storagePath === 'string' ? item.storagePath : '',
      syncKey: typeof item.syncKey === 'string' ? item.syncKey : '',
      sizeBytes: Number(item.sizeBytes) || 0,
      modifiedAt: Number(item.modifiedAt) || 0,
      deviceOnly: item.deviceOnly === true
    };
  }).filter(function (item) { return item && item.fileName; });
}

function loadLibrary() {
  var bundled = fetch('library/playlist.json', { cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  var stored = window.LocalMusicMobile && LocalMusicMobile.available()
    ? LocalMusicMobile.readPlaylist()
    : Promise.resolve(null);
  return Promise.all([bundled, stored])
    .then(function (payloads) {
      var bundledTracks = normalizePlaylistPayload(payloads[0]);
      var storedTracks = normalizePlaylistPayload(payloads[1]);
      var merged = storedTracks.slice();
      bundledTracks.forEach(function (item) {
        if (!merged.some(function (storedItem) { return storedItem.fileName === item.fileName; })) merged.push(item);
      });
      state.playlistTracks = merged;
      applyLibrary();
      return hydrateMobileUrls();
    })
    .then(function () {
      setBanner('', '', false);
      if (!state.playlistTracks.length) {
        setBanner('warn', 'library/playlist.json is empty. Paste a playlist link above, run "python3 importer.py", or add audio files.', true);
      }
      render();
      return true;
    })
    .catch(function (error) {
      state.playlistTracks = [];
      applyLibrary();
      if (window.LocalMusicMobile && LocalMusicMobile.available()) {
        return LocalMusicMobile.readPlaylist().then(function (storedTracks) {
          state.playlistTracks = normalizePlaylistPayload(storedTracks);
          applyLibrary();
          return hydrateMobileUrls();
        }).then(function () {
          render();
          return state.playlistTracks.length > 0;
        });
      }
      if (location.protocol === 'file:') {
        setBanner('warn', 'Opened via file:// \u2014 browsers block fetching library/playlist.json. Start a local server instead: python3 -m http.server 8000, then open http://localhost:8000/player.html', true);
      } else {
        setBanner('warn', 'Could not load library/playlist.json (' + error.message + '). Paste a playlist link above or add audio files.', true);
      }
      render();
      return false;
    });
}

function applyPendingRestore() {
  var pending = state.pendingRestore;
  if (!pending || !pending.key || !state.tracks.has(pending.key)) return;

  var track = state.tracks.get(pending.key);
  if (!ensureUrl(track)) {
    state.currentKey = pending.key;
    renderNowPlaying();
    render();
    return;
  }

  state.pendingRestore = null;
  state.order = state.order.length && state.order.indexOf(pending.key) !== -1
    ? state.order
    : [pending.key].concat(state.naturalOrder.filter(function (key) { return key !== pending.key; }));
  loadTrack(track, { autoplay: false, position: pending.position || 0 });
  if (pending.position > 1) {
    setBanner('info', 'Resumed \u201c' + track.title + '\u201d at ' + formatTime(pending.position) + '. Press play to continue.', true);
  }
}

function updateSummary() {
  var total = state.tracks.size;
  var loaded = 0;
  state.tracks.forEach(function (track) { if (ensureUrl(track)) loaded += 1; });

  if (!total) {
    el.summary.textContent = state.playlistTracks.length ? 'Playlist has no usable entries' : 'No library loaded';
    return;
  }
  var text = total + (total === 1 ? ' track' : ' tracks') + ' \u00b7 ' + loaded + ' loaded';
  el.summary.textContent = text;
}

/* ------------------------------------------------------------------ *
 * Queue order + smart shuffle
 * ------------------------------------------------------------------ */

/* weights the next pick towards a different artist than the track that plays
   before it, and towards tracks that have not been played recently */
function smartShuffle(keys, previousArtist) {
  var recent = new Set(state.recent.slice(0, 10));
  var remaining = keys.slice();
  var order = [];
  var lastArtist = previousArtist || '';

  while (remaining.length) {
    var total = 0;
    var weights = remaining.map(function (key) {
      var track = state.tracks.get(key) || {};
      var weight = 1;
      if (track.artist && lastArtist && track.artist !== lastArtist) weight += 1.4;
      if (recent.has(key)) weight = 0.25;
      else weight += 1.1;
      if (state.likes[key]) weight += 1.2;
      var stats = state.stats[key];
      if (stats && stats.plays < 2) weight += 1.4;
      if (stats && stats.skips > stats.plays) weight *= 0.65;
      total += weight;
      return weight;
    });

    var target = Math.random() * total;
    var index = 0;
    for (index = 0; index < remaining.length; index += 1) {
      target -= weights[index];
      if (target <= 0) break;
    }
    if (index >= remaining.length) index = remaining.length - 1;

    var picked = remaining.splice(index, 1)[0];
    order.push(picked);
    lastArtist = (state.tracks.get(picked) || {}).artist || '';
  }

  return order;
}

function buildOrder(keys, mode, currentKey) {
  var base = keys.filter(function (key, index) { return keys.indexOf(key) === index; });
  if (mode === 'off') {
    return currentKey && base.indexOf(currentKey) !== -1
      ? [currentKey].concat(base.filter(function (key) { return key !== currentKey; }))
      : base.slice();
  }
  var rest = base.filter(function (key) { return key !== currentKey; });
  var current = currentKey && base.indexOf(currentKey) !== -1 ? state.tracks.get(currentKey) : null;
  var ordered = mode === 'smart'
    ? smartShuffle(rest, current ? current.artist : '')
    : shuffleInPlace(rest);
  return currentKey && base.indexOf(currentKey) !== -1 ? [currentKey].concat(ordered) : ordered;
}

function composeManualQueue(baseOrder) {
  var manual = state.manualQueue.filter(function (key, index) {
    return state.tracks.has(key) && key !== state.currentKey && state.manualQueue.indexOf(key) === index;
  });
  var current = state.currentKey && state.tracks.has(state.currentKey) ? [state.currentKey] : [];
  var automatic = baseOrder.filter(function (key, index) {
    return key !== state.currentKey && manual.indexOf(key) === -1 && baseOrder.indexOf(key) === index;
  });
  return current.concat(manual, automatic);
}

function setShuffleMode(mode) {
  state.shuffleMode = SHUFFLE_MODES.indexOf(mode) === -1 ? 'off' : mode;
  if (state.order.length) {
    var automatic = state.order.filter(function (key) { return state.manualQueue.indexOf(key) === -1; });
    state.order = composeManualQueue(buildOrder(automatic, state.shuffleMode, state.currentKey));
  }
  renderQueue();
  syncControls();
  persistSession();
}

/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */

function currentTrack() {
  return state.currentKey ? state.tracks.get(state.currentKey) || null : null;
}

function notePlayed(key) {
  state.recent = [key].concat(state.recent.filter(function (item) { return item !== key; })).slice(0, 40);
  var item = state.stats[key] || { plays: 0, skips: 0, seconds: 0, lastPlayedAt: 0 };
  item.plays += 1;
  item.lastPlayedAt = Date.now();
  item.lastPlayed = item.lastPlayedAt;
  state.stats[key] = item;
  persistStats();
}

function notePlaybackSeconds(key, seconds) {
  if (!key || !Number.isFinite(seconds) || seconds <= 0) return;
  var item = state.stats[key] || { plays: 0, skips: 0, seconds: 0, lastPlayedAt: 0 };
  item.seconds += seconds;
  state.stats[key] = item;
  persistStats();
}

function noteSkip(key) {
  if (!key) return;
  var item = state.stats[key] || { plays: 0, skips: 0, seconds: 0, lastPlayedAt: 0 };
  item.skips += 1;
  state.stats[key] = item;
  persistStats();
}

function promptForFile(track) {
  setBanner('warn', 'The audio file for \u201c' + track.fileName + '\u201d is not loaded. Press \u201cAdd audio files\u201d (or \u201cAdd folder\u201d and pick library/audio) to attach it. Tracks are matched by fileName.', true);
  if (el.filePicker) el.filePicker.click();
}

function loadTrack(track, options) {
  if (!track) return false;
  var opts = options || {};
  var autoplay = opts.autoplay !== false;
  var position = Number(opts.position) > 0 ? Number(opts.position) : 0;
  cancelCrossfade();
  state.pendingSeek = position > 0 ? position : null;
  var url = ensureUrl(track);

  if (!url) {
    state.currentKey = track.key;
    state.pendingSeek = null;
    renderNowPlaying();
    render();
    promptForFile(track);
    return false;
  }

  state.currentKey = track.key;
  state.manualQueue = state.manualQueue.filter(function (key) { return key !== track.key; });
  notePlayed(track.key);
  state.lastAudioTime = 0;
  el.audio.src = url;
  el.audio.playbackRate = state.playbackRate;
  el.audio.volume = state.volume;
  el.audio.load();

  var onMetadata = function () {
    el.audio.removeEventListener('loadedmetadata', onMetadata);
    var duration = Number(el.audio.duration);
    if (Number.isFinite(duration) && duration > 0) {
      if (!track.duration) {
        track.duration = duration;
        render();
      }
      if (position > 0) {
        el.audio.currentTime = Math.min(position, Math.max(0, duration - 0.5));
      }
    }
    state.pendingSeek = null;
    if (autoplay) {
      var promise = el.audio.play();
      if (promise && typeof promise.catch === 'function') promise.catch(function () {});
    } else {
      updateTimeUI();
      persistSession();
    }
  };

  el.audio.addEventListener('loadedmetadata', onMetadata);

  renderNowPlaying();
  render();
  renderQueue();
  updateMediaMetadata(track);
  persistSession();
  return true;
}

function playKey(key, options) {
  var track = state.tracks.get(key);
  if (!track) return;
  loadTrack(track, options);
}

/* Play a list of keys (a playlist, the whole library, ...) starting at startKey. */
function playList(keys, startKey, label) {
  var usable = keys.filter(function (key) { return state.tracks.has(key); });
  if (!usable.length) {
    setBanner('info', 'That list is empty \u2014 add some tracks first.', true);
    return;
  }
  var start = startKey && usable.indexOf(startKey) !== -1 ? startKey : (state.shuffleMode === 'off' ? usable[0] : null);
  state.queueTitle = label || '';
  state.manualQueue = [];
  state.order = buildOrder(usable, state.shuffleMode, start);
  var first = start || state.order[0];
  if (first) playKey(first, { autoplay: true });
  renderQueue();
  syncControls();
  persistSession();
}

function togglePlay() {
  if (!state.tracks.size) {
    setBanner('info', 'No tracks yet. Paste a playlist link above or add audio files.', true);
    return;
  }
  if (!state.currentKey) {
    var first = state.order[0] || state.naturalOrder[0];
    if (first) playKey(first, { autoplay: true });
    return;
  }
  if (!el.audio.src) {
    playKey(state.currentKey, { autoplay: true });
    return;
  }
  if (el.audio.paused) {
    if (el.audio.ended) el.audio.currentTime = 0;
    var promise = el.audio.play();
    if (promise && typeof promise.catch === 'function') promise.catch(function () {});
  } else {
    el.audio.pause();
  }
}

function currentIndex() {
  return state.currentKey ? state.order.indexOf(state.currentKey) : -1;
}

function nextKey() {
  if (!state.order.length) return null;
  var index = currentIndex();
  if (state.repeat === 'one' && index >= 0) return state.currentKey;
  if (index < 0) return state.order[0];
  if (index + 1 < state.order.length) return state.order[index + 1];
  if (state.repeat === 'all') return state.order[0];
  return null;
}

function previousKey() {
  if (!state.order.length) return null;
  var index = currentIndex();
  if (index > 0) return state.order[index - 1];
  if (state.repeat === 'all') return state.order[state.order.length - 1];
  return null;
}

function playNext(manual) {
  var key = nextKey();
  if (!key) {
    if (manual) setBanner('info', 'End of queue. Turn repeat on to wrap around.', true);
    return;
  }
  if (!manual && state.crossfade && startCrossfade(key)) return;
  playKey(key, { autoplay: true });
}

function playPrevious() {
  if (state.currentKey && el.audio.currentTime > 3) {
    el.audio.currentTime = 0;
    updateTimeUI();
    return;
  }
  var key = previousKey();
  if (key) playKey(key, { autoplay: true });
  else if (state.currentKey) {
    el.audio.currentTime = 0;
    updateTimeUI();
  }
}

function seekBy(delta) {
  if (!Number.isFinite(el.audio.duration) || el.audio.duration <= 0) return;
  el.audio.currentTime = clamp(el.audio.currentTime + delta, 0, Math.max(0, el.audio.duration - 0.1));
  updateTimeUI();
}

function cancelCrossfade() {
  if (state.crossfadeTimer) {
    clearInterval(state.crossfadeTimer);
    state.crossfadeTimer = null;
  }
  state.crossfadeTarget = null;
  if (el.audioNext) {
    el.audioNext.pause();
    el.audioNext.removeAttribute('src');
    el.audioNext.load();
    el.audioNext.volume = state.volume;
  }
}

function setPlaybackRate(rate) {
  state.playbackRate = clamp(Number(rate) || 1, 0.5, 2);
  el.audio.playbackRate = state.playbackRate;
  if (el.audioNext) el.audioNext.playbackRate = state.playbackRate;
  persistSession();
  syncControls();
}

function setCrossfade(seconds) {
  state.crossfade = clamp(Number(seconds) || 0, 0, MAX_CROSSFADE_SECONDS);
  if (!state.crossfade) cancelCrossfade();
  persistSession();
  syncControls();
}

function setSleepTimer(minutes) {
  var amount = Number(minutes) || 0;
  state.sleepAt = amount > 0 ? Date.now() + amount * 60 * 1000 : 0;
  persistSession();
  updateSleepUI();
}

function updateSleepUI() {
  var remaining = state.sleepAt ? Math.max(0, state.sleepAt - Date.now()) : 0;
  if (!remaining) {
    state.sleepAt = 0;
    if (el.sleepCountdown) el.sleepCountdown.textContent = '';
  } else if (el.sleepCountdown) {
    var seconds = Math.ceil(remaining / 1000);
    el.sleepCountdown.textContent = formatTime(seconds);
  }
  if (el.sleepBtn) el.sleepBtn.textContent = state.sleepAt ? 'Sleep on' : 'Sleep';
}

function maybeStartCrossfade() {
  if (!state.crossfade || state.crossfadeTarget || state.repeat === 'one') return;
  var remaining = Number(el.audio.duration) - Number(el.audio.currentTime);
  if (!Number.isFinite(remaining) || remaining > state.crossfade) return;
  var key = nextKey();
  if (key && key !== state.currentKey) startCrossfade(key);
}

function startCrossfade(key) {
  if (!el.audioNext || !key || state.crossfadeTarget) return false;
  var track = state.tracks.get(key);
  var url = ensureUrl(track);
  if (!track || !url) return false;
  var oldAudio = el.audio;
  var nextAudio = el.audioNext;
  state.crossfadeTarget = key;
  nextAudio.src = url;
  nextAudio.playbackRate = state.playbackRate;
  nextAudio.volume = 0;
  nextAudio.load();
  var startedAt = 0;
  var begin = function () {
    if (state.crossfadeTarget !== key) return;
    var promise = nextAudio.play();
    if (promise && typeof promise.catch === 'function') promise.catch(function () {
      state.crossfadeTarget = null;
    });
    startedAt = performance.now();
  };
  if (nextAudio.readyState >= 3) begin();
  else nextAudio.addEventListener('canplay', begin, { once: true });

  state.crossfadeTimer = setInterval(function () {
    if (!startedAt || state.crossfadeTarget !== key) return;
    var progress = clamp((performance.now() - startedAt) / (state.crossfade * 1000), 0, 1);
    oldAudio.volume = state.volume * (1 - progress);
    nextAudio.volume = state.volume * progress;
    if (progress >= 1) {
      clearInterval(state.crossfadeTimer);
      state.crossfadeTimer = null;
      oldAudio.pause();
      oldAudio.currentTime = 0;
      oldAudio.volume = state.volume;
      el.audio = nextAudio;
      el.audioNext = oldAudio;
      state.currentKey = key;
      state.crossfadeTarget = null;
      notePlayed(key);
      renderNowPlaying();
      render();
      updateMediaMetadata(track);
      persistSession();
      syncControls();
    }
  }, 50);
  return true;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function persistSession() {
  if (!state.persistence) return;
  var position = state.pendingSeek != null
    ? state.pendingSeek
    : (Number.isFinite(el.audio.currentTime) ? el.audio.currentTime : state.lastPosition);
  state.lastPosition = position;

  var ok = writeStore(STORAGE_KEY, {
    shuffleMode: state.shuffleMode,
    repeat: REPEAT_MODES.indexOf(state.repeat) !== -1 ? state.repeat : 'off',
    lastTrack: state.currentKey || null,
    lastPosition: position,
    volume: state.volume,
    recent: state.recent,
    queue: state.order,
    manualQueue: state.manualQueue,
    playbackRate: state.playbackRate,
    crossfade: state.crossfade,
    sleepAt: state.sleepAt || 0,
    updatedAt: new Date().toISOString()
  });
  state.lastPersistAt = Date.now();
  if (!ok) {
    state.persistence = false;
    setBanner('warn', 'Storage is unavailable, so playback state cannot be remembered.', true);
  }
}

function persistStats() {
  writeStore(STATS_KEY, { likes: state.likes, stats: state.stats, updatedAt: new Date().toISOString() });
}

/* ------------------------------------------------------------------ *
 * Account state (likes, play counts and playlists shared by devices)
 *
 * Everything is addressed by a stable reference: the importer's syncKey when
 * the track has one, otherwise the file name. Audio itself stays local, so a
 * reference may not resolve on this device; those are kept in `pending` so a
 * later sync after the file arrives still restores the playlist.
 * ------------------------------------------------------------------ */

function trackRef(key) {
  var track = state.tracks.get(key);
  return (track && track.syncKey) || key;
}

function keyForRef(ref) {
  if (state.tracks.has(ref)) return ref;
  var found = null;
  state.tracks.forEach(function (track, key) {
    if (!found && track.syncKey === ref) found = key;
  });
  return found;
}

function persistAccountState() {
  writeStore(ACCOUNT_KEY, {
    likeDecisions: state.likeDecisions,
    deletedPlaylists: state.deletedPlaylists
  });
}

function playlistStamp(playlist) {
  if (!playlist) return 0;
  return Number(playlist.updatedAt) || Date.parse(playlist.createdAt) || 0;
}

function noteAccountChange() {
  if (state.suppressAccountPush) return;
  if (window.LocalMusicAccount) window.LocalMusicAccount.noteLocalChange();
}

function accountSnapshot() {
  var likes = [];
  var seen = {};
  Object.keys(state.likeDecisions).forEach(function (ref) {
    var decision = state.likeDecisions[ref];
    if (!decision || !Number(decision.at)) return;
    seen[ref] = true;
    likes.push({ ref: ref, likedAt: Number(decision.likedAt) || 0, at: Number(decision.at) });
  });
  // Likes saved before account sync existed have no decision record yet.
  // The like's own timestamp is the decision time; stamping "now" here would
  // let an old local like keep overwriting a newer unlike from another device.
  Object.keys(state.likes).forEach(function (key) {
    var ref = trackRef(key);
    if (seen[ref]) return;
    var at = Number(state.likes[key]) || 0;
    if (!at) return;
    seen[ref] = true;
    likes.push({ ref: ref, likedAt: at, at: at });
  });

  var stats = [];
  var statsSeen = {};
  Object.keys(state.stats).forEach(function (key) {
    var item = state.stats[key];
    if (!item) return;
    var ref = trackRef(key);
    var current = statsSeen[ref];
    var row = {
      ref: ref,
      plays: Number(item.plays) || 0,
      skips: Number(item.skips) || 0,
      seconds: Number(item.seconds) || 0,
      lastPlayedAt: Number(item.lastPlayedAt) || 0
    };
    if (current) {
      current.plays = Math.max(current.plays, row.plays);
      current.skips = Math.max(current.skips, row.skips);
      current.seconds = Math.max(current.seconds, row.seconds);
      current.lastPlayedAt = Math.max(current.lastPlayedAt, row.lastPlayedAt);
      return;
    }
    statsSeen[ref] = row;
    stats.push(row);
  });

  var playlists = state.playlists.map(function (playlist) {
    return {
      id: playlist.id,
      name: playlist.name,
      createdAt: playlist.createdAt || '',
      updatedAt: playlistStamp(playlist),
      deletedAt: 0,
      refs: playlist.keys.map(trackRef).concat(playlist.pending || [])
    };
  });
  Object.keys(state.deletedPlaylists).forEach(function (id) {
    if (state.playlists.some(function (item) { return item.id === id; })) return;
    playlists.push({
      id: id,
      name: '',
      createdAt: '',
      updatedAt: Number(state.deletedPlaylists[id]) || 0,
      deletedAt: Number(state.deletedPlaylists[id]) || 0,
      refs: []
    });
  });

  return { likes: likes, stats: stats, playlists: playlists };
}

function accountMissingCount() {
  var missing = 0;
  var counted = {};
  var resolvable = {};
  state.tracks.forEach(function (track, key) {
    resolvable[key] = true;
    if (track.syncKey) resolvable[track.syncKey] = true;
  });
  Object.keys(state.likes).forEach(function (key) {
    var ref = trackRef(key);
    if (resolvable[ref] || counted[ref]) return;
    counted[ref] = true;
    missing += 1;
  });
  // Likes from other devices whose audio is not here yet only exist as decisions.
  Object.keys(state.likeDecisions).forEach(function (ref) {
    var decision = state.likeDecisions[ref];
    if (!decision || !Number(decision.likedAt)) return;
    if (resolvable[ref] || counted[ref]) return;
    counted[ref] = true;
    missing += 1;
  });
  state.playlists.forEach(function (playlist) { missing += (playlist.pending || []).length; });
  return missing;
}

function applyAccountState(remote) {
  if (!remote) return false;
  var changed = false;
  var remoteLikes = Array.isArray(remote.likes) ? remote.likes : [];
  var remoteStats = Array.isArray(remote.stats) ? remote.stats : [];
  var remotePlaylists = Array.isArray(remote.playlists) ? remote.playlists : [];

  remoteLikes.forEach(function (row) {
    if (!row || typeof row.ref !== 'string') return;
    var known = state.likeDecisions[row.ref];
    var winner = known && Number(known.at) >= Number(row.at || 0)
      ? known
      : { likedAt: Number(row.likedAt) || 0, at: Number(row.at) || 0 };
    state.likeDecisions[row.ref] = winner;
    var key = keyForRef(row.ref);
    if (!key) return;
    if (Number(winner.likedAt) > 0) {
      if (state.likes[key] !== Number(winner.likedAt)) { state.likes[key] = Number(winner.likedAt); changed = true; }
    } else if (state.likes[key]) {
      delete state.likes[key];
      changed = true;
    }
  });

  remoteStats.forEach(function (row) {
    if (!row || typeof row.ref !== 'string') return;
    var key = keyForRef(row.ref);
    if (!key) return;
    var local = trackStats(key);
    var next = {
      plays: Math.max(Number(local.plays) || 0, Number(row.plays) || 0),
      skips: Math.max(Number(local.skips) || 0, Number(row.skips) || 0),
      seconds: Math.max(Number(local.seconds) || 0, Number(row.seconds) || 0),
      lastPlayedAt: Math.max(Number(local.lastPlayedAt) || 0, Number(row.lastPlayedAt) || 0)
    };
    if (next.plays !== local.plays || next.skips !== local.skips ||
        next.seconds !== local.seconds || next.lastPlayedAt !== local.lastPlayedAt) changed = true;
    state.stats[key] = next;
  });

  remotePlaylists.forEach(function (row) {
    if (!row || typeof row.id !== 'string') return;
    var local = null;
    for (var index = 0; index < state.playlists.length; index += 1) {
      if (state.playlists[index].id === row.id) { local = state.playlists[index]; break; }
    }
    var localUpdated = playlistStamp(local);
    if (Number(row.updatedAt) <= localUpdated) return;
    if (Number(row.deletedAt) > 0) {
      if (!local) return;
      state.playlists = state.playlists.filter(function (item) { return item.id !== row.id; });
      state.deletedPlaylists[row.id] = Number(row.deletedAt);
      changed = true;
      return;
    }
    var keys = [];
    var pending = [];
    (Array.isArray(row.refs) ? row.refs : []).forEach(function (ref) {
      var key = keyForRef(ref);
      if (key) { if (keys.indexOf(key) === -1) keys.push(key); }
      else if (pending.indexOf(ref) === -1) pending.push(ref);
    });
    if (local) {
      local.name = String(row.name || local.name || 'Playlist');
      local.keys = keys;
      local.pending = pending;
      local.updatedAt = Number(row.updatedAt) || Date.now();
      local.createdAt = local.createdAt || String(row.createdAt || '');
    } else {
      state.playlists.push({
        id: row.id,
        name: String(row.name || 'Playlist'),
        keys: keys,
        pending: pending,
        createdAt: String(row.createdAt || ''),
        updatedAt: Number(row.updatedAt) || Date.now()
      });
    }
    delete state.deletedPlaylists[row.id];
    changed = true;
  });

  state.suppressAccountPush = true;
  try {
    persistAccountState();
    if (changed) {
      persistStats();
      savePlaylists();
      render();
    }
  } finally {
    state.suppressAccountPush = false;
  }
  return changed;
}

function restorePrefs() {
  var prefs = readStore(STORAGE_KEY, null);
  if (prefs) {
    state.shuffleMode = SHUFFLE_MODES.indexOf(prefs.shuffleMode) === -1 ? 'off' : prefs.shuffleMode;
    state.repeat = REPEAT_MODES.indexOf(prefs.repeat) === -1 ? 'off' : prefs.repeat;
    var volume = Number(prefs.volume);
    state.volume = Number.isFinite(volume) ? clamp(volume, 0, 1) : 0.9;
    state.playbackRate = Number.isFinite(Number(prefs.playbackRate))
      ? clamp(Number(prefs.playbackRate), 0.5, 2)
      : 1;
    state.crossfade = Number.isFinite(Number(prefs.crossfade))
      ? clamp(Number(prefs.crossfade), 0, MAX_CROSSFADE_SECONDS)
      : 0;
    state.sleepAt = Number(prefs.sleepAt) > Date.now() ? Number(prefs.sleepAt) : 0;
    state.recent = Array.isArray(prefs.recent) ? prefs.recent.filter(function (key) { return typeof key === 'string'; }) : [];
    state.pendingQueue = Array.isArray(prefs.queue) ? prefs.queue.filter(function (key) { return typeof key === 'string'; }) : null;
    state.manualQueue = Array.isArray(prefs.manualQueue) ? prefs.manualQueue.filter(function (key) { return typeof key === 'string'; }) : [];
    if (prefs.lastTrack) {
      state.pendingRestore = {
        key: String(prefs.lastTrack),
        position: Number(prefs.lastPosition) > 0 ? Number(prefs.lastPosition) : 0
      };
    }
  }
  var stats = readStore(STATS_KEY, null);
  if (stats && stats.likes && typeof stats.likes === 'object') state.likes = stats.likes;
  if (stats && stats.stats && typeof stats.stats === 'object') state.stats = stats.stats;
  var accountState = readStore(ACCOUNT_KEY, null);
  if (accountState) {
    if (accountState.likeDecisions && typeof accountState.likeDecisions === 'object') {
      state.likeDecisions = accountState.likeDecisions;
    }
    if (accountState.deletedPlaylists && typeof accountState.deletedPlaylists === 'object') {
      state.deletedPlaylists = accountState.deletedPlaylists;
    }
  }
  var playlists = readStore(PLAYLISTS_KEY, []);
  state.playlists = Array.isArray(playlists)
    ? playlists.filter(function (item) {
        return item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.keys);
      }).map(function (item) {
        return {
          id: item.id,
          name: item.name,
          keys: item.keys.filter(function (key) { return typeof key === 'string'; }),
          pending: Array.isArray(item.pending)
            ? item.pending.filter(function (ref) { return typeof ref === 'string'; })
            : [],
          createdAt: item.createdAt || '',
          updatedAt: Number(item.updatedAt) || Date.parse(item.createdAt) || 0
        };
      })
    : [];
}

function toggleLike(key) {
  if (!key) return false;
  var likedAt = 0;
  if (state.likes[key]) {
    delete state.likes[key];
  } else {
    state.likes[key] = Date.now();
    likedAt = state.likes[key];
  }
  state.stats[key] = trackStats(key);
  state.likeDecisions[trackRef(key)] = { likedAt: likedAt, at: Date.now() };
  persistStats();
  persistAccountState();
  noteAccountChange();
  render();
  return Boolean(state.likes[key]);
}

function isLiked(key) {
  return Boolean(key && state.likes[key]);
}

function trackStats(key) {
  return state.stats[key] || { plays: 0, skips: 0, seconds: 0, lastPlayedAt: 0 };
}

function savePlaylists() {
  if (!writeStore(PLAYLISTS_KEY, state.playlists)) {
    setBanner('warn', 'Storage is unavailable, so playlists cannot be saved here.', true);
  }
  noteAccountChange();
}
