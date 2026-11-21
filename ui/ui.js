/* Local Music — interface layer.
 *
 * Renders the shell: Home / Songs / Playlist / Discover views, the playlist
 * sidebar, the player bar, the queue drawer, the track context menu and the
 * small modal used for naming playlists. Playback itself lives in engine.js.
 */

var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>';
var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM14 5h3v14h-3z"/></svg>';

/* ------------------------------------------------------------------ *
 * Small DOM helpers
 * ------------------------------------------------------------------ */

function h(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

/* No \p{...} escapes: an old Android WebView would fail to parse the whole
   file, not just this function. \w plus the Latin-1..BMP range keeps accented
   and CJK letters while dropping punctuation. */
function initialsFor(text) {
  var words = String(text).replace(/[^\w\s\u00C0-\uFFFF]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '\u266A';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function hueFor(text) {
  var hash = 0;
  var str = String(text);
  for (var i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) % 360;
  return hash;
}

function paintRange(input) {
  if (!input) return;
  var min = Number(input.min) || 0;
  var max = Number(input.max) || 1;
  var value = Number(input.value) || 0;
  var pct = max > min ? clamp(((value - min) / (max - min)) * 100, 0, 100) : 0;
  input.style.background =
    'linear-gradient(to right, var(--accent) 0%, var(--accent) ' + pct + '%, var(--line) ' + pct + '%, var(--line) 100%)';
}

/* replaceChildren() is Chrome 86+; older Android WebViews fall back to a loop. */
function setChildren(node, child) {
  if (typeof node.replaceChildren === 'function') {
    node.replaceChildren(child);
    return;
  }
  while (node.firstChild) node.removeChild(node.firstChild);
  node.appendChild(child);
}

function totalDuration(keys) {
  return keys.reduce(function (sum, key) {
    var track = state.tracks.get(key);
    return sum + (track && track.duration ? track.duration : 0);
  }, 0);
}

function trackCountLabel(count) {
  return count + (count === 1 ? ' song' : ' songs');
}

function lyricsUrl(track) {
  if (!track || !track.lyrics) return null;
  if (track._mobileLyricsUrl) return track._mobileLyricsUrl;
  var path = String(track.lyrics).replace(/^\/+/, '');
  if (/^https?:\/\//i.test(path)) return path;
  return (state.libraryBase || '') + 'library/lyrics/' + encodeURIComponent(path.split('/').pop());
}

function parseLyrics(text) {
  var lines = [];
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var rest = line.trim();
    var timestamps = [];
    var match;
    while ((match = /^\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]\s*/.exec(rest))) {
      var fraction = match[3] ? Number(('0.' + match[3]).slice(0, 5)) : 0;
      timestamps.push(Number(match[1]) * 60 + Number(match[2]) + fraction);
      rest = rest.slice(match[0].length);
    }
    if (!timestamps.length) {
      if (rest && !/^\[(?:ar|al|by|offset|re|ti):/i.test(rest)) {
        lines.push({ time: null, text: rest });
      }
      return;
    }
    timestamps.forEach(function (time) {
      lines.push({ time: time, text: rest });
    });
  });
  return lines;
}

function updateLyricsHighlight() {
  if (!el.lyricsBody || !state.lyricsLines.length) return;
  var current = Number(el.audio.currentTime) || 0;
  var active = -1;
  state.lyricsLines.forEach(function (line, index) {
    if (line.time != null && line.time <= current) active = index;
  });
  Array.prototype.forEach.call(el.lyricsBody.querySelectorAll('.lyric-line'), function (node, index) {
    node.classList.toggle('is-current', index === active);
  });
  var activeNode = active >= 0 ? el.lyricsBody.querySelector('[data-index="' + active + '"]') : null;
  if (activeNode && typeof activeNode.scrollIntoView === 'function') activeNode.scrollIntoView({ block: 'nearest' });
}

function renderLyrics(track) {
  if (!el.lyricsPanel) return;
  if (!track || !track.lyrics) {
    el.lyricsPanel.hidden = true;
    state.lyricsKey = null;
    state.lyricsLoadingKey = null;
    state.lyricsLines = [];
    return;
  }
  el.lyricsPanel.hidden = false;
  el.lyricsStatus.textContent = 'Offline';
  if (!state.lyricsLines.length || state.lyricsKey !== track.key) {
    el.lyricsBody.textContent = '';
    el.lyricsStatus.textContent = 'Loading\u2026';
    return;
  }
  var fragment = document.createDocumentFragment();
  state.lyricsLines.forEach(function (line, index) {
    var item = h('div', 'lyric-line', line.text || '\u00a0');
    item.dataset.index = String(index);
    if (line.time == null) item.classList.add('is-plain');
    item.addEventListener('click', function () {
      if (line.time != null) {
        el.audio.currentTime = line.time;
        updateTimeUI();
      }
    });
    fragment.appendChild(item);
  });
  setChildren(el.lyricsBody, fragment);
  el.lyricsStatus.textContent = 'Offline';
  updateLyricsHighlight();
}

function loadLyrics(track) {
  if (!track || !track.lyrics) {
    renderLyrics(null);
    return;
  }
  if (state.lyricsKey === track.key && (state.lyricsLines.length || state.lyricsLoadingKey === track.key)) {
    renderLyrics(track);
    return;
  }
  state.lyricsKey = track.key;
  state.lyricsLoadingKey = track.key;
  state.lyricsLines = [];
  renderLyrics(track);
  var url = lyricsUrl(track);
  if (!url) return;
  fetch(url, { cache: 'no-store' }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.text();
  }).then(function (text) {
    if (state.lyricsKey !== track.key) return;
    state.lyricsLoadingKey = null;
    state.lyricsLines = parseLyrics(text);
    renderLyrics(track);
  }).catch(function () {
    if (state.lyricsKey !== track.key) return;
    state.lyricsLoadingKey = null;
    el.lyricsStatus.textContent = 'Unavailable';
    el.lyricsBody.textContent = 'Lyrics file could not be loaded.';
  });
}

/* ------------------------------------------------------------------ *
 * Player bar
 * ------------------------------------------------------------------ */

function renderNowPlaying() {
  var track = currentTrack();
  if (!track) {
    el.npTitle.textContent = 'Nothing playing';
    el.npArtist.textContent = state.tracks.size ? 'Pick a track to start' : 'Paste a playlist link to start';
    el.coverText.textContent = '\u266A';
    el.coverText.style.backgroundImage = '';
    el.coverText.classList.remove('has-cover');
    el.coverText.style.setProperty('--hue', '150');
    if (el.likeBtn) el.likeBtn.hidden = true;
    renderLyrics(null);
    document.title = 'Local Music';
    return;
  }
  el.npTitle.textContent = track.title;
  el.npArtist.textContent = track.artist;
  if (el.likeBtn) {
    var liked = isLiked(track.key);
    el.likeBtn.hidden = false;
    el.likeBtn.textContent = liked ? '\u2665' : '\u2661';
    el.likeBtn.title = liked ? 'Unlike' : 'Like';
    el.likeBtn.setAttribute('aria-label', liked ? 'Unlike track' : 'Like track');
    el.likeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
  }
  el.coverText.textContent = initialsFor(track.title);
  el.coverText.style.setProperty('--hue', String(hueFor(track.artist + track.title)));
  var cover = trackCoverUrl(track);
  el.coverText.style.backgroundImage = cover ? 'url("' + cover.replace(/"/g, '%22') + '")' : '';
  el.coverText.classList.toggle('has-cover', Boolean(cover));
  document.title = track.title + ' \u00b7 ' + track.artist;
  loadLyrics(track);

  if ('mediaSession' in navigator && navigator.mediaSession) {
    navigator.mediaSession.playbackState = el.audio.paused ? 'paused' : 'playing';
  }
}

function updateMediaMetadata(track) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession) return;
  if (typeof MediaMetadata === 'undefined') return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: 'Local Library',
      artwork: trackCoverUrl(track) ? [
        { src: trackCoverUrl(track), sizes: '512x512', type: 'image/jpeg' }
      ] : []
    });
  } catch (err) {
    /* media metadata is best effort */
  }
}

function syncPlayButton() {
  var playing = !el.audio.paused && !el.audio.ended;
  el.playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  el.playBtn.title = playing ? 'Pause' : 'Play';
  el.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function syncControls() {
  el.shuffleBtn.classList.toggle('is-on', state.shuffleMode === 'shuffle');
  el.shuffleBtn.classList.toggle('is-smart', state.shuffleMode === 'smart');
  el.shuffleBtn.setAttribute('aria-pressed', state.shuffleMode === 'off' ? 'false' : 'true');
  el.shuffleBtn.setAttribute('aria-label', 'Shuffle ' + state.shuffleMode);
  el.shuffleBtn.title = 'Shuffle: ' + state.shuffleMode + ' \u2014 click to change (S)';

  el.repeatBtn.dataset.mode = state.repeat;
  el.repeatBtn.classList.toggle('is-on', state.repeat !== 'off');
  el.repeatBtn.setAttribute('aria-label', 'Repeat ' + state.repeat);
  el.repeatBtn.title = 'Repeat: ' + state.repeat + ' (R)';

  el.audio.volume = state.volume;
  el.audio.playbackRate = state.playbackRate;
  if (el.audioNext) {
    el.audioNext.volume = state.volume;
    el.audioNext.playbackRate = state.playbackRate;
  }
  el.volume.value = String(state.volume);
  el.volValue.textContent = Math.round(state.volume * 100) + '%';
  paintRange(el.volume);
  paintRange(el.seek);
  syncPlayButton();
  if (el.crossfadeBtn) {
    el.crossfadeBtn.textContent = state.crossfade ? 'Fade ' + state.crossfade + 's' : 'Fade off';
    el.crossfadeBtn.title = 'Crossfade: ' + (state.crossfade ? state.crossfade + ' seconds' : 'off');
  }
  if (el.speedBtn) el.speedBtn.textContent = String(state.playbackRate).replace(/\.0$/, '') + 'x';
  updateSleepUI();
}

function updateTimeUI() {
  var duration = Number.isFinite(el.audio.duration) ? el.audio.duration : 0;
  var track = currentTrack();
  var total = duration || (track && track.duration ? track.duration : 0);
  var current = Number.isFinite(el.audio.currentTime) ? el.audio.currentTime : 0;

  if (!state.seekDragging) {
    el.seek.max = String(total || 1);
    el.seek.value = String(clamp(current, 0, total || 1));
  }
  el.seek.disabled = !total;
  paintRange(el.seek);
  el.timeCurrent.textContent = formatTime(current);
  el.timeTotal.textContent = total ? formatTime(total) : '--:--';
  el.status.textContent = state.persistence ? 'Saved on this device \u00b7 works offline' : 'Storage unavailable';
}

function renderQueue() {
  var fragment = document.createDocumentFragment();
  var active = state.currentKey;

  state.order.forEach(function (key, index) {
    var track = state.tracks.get(key);
    if (!track) return;
    var row = h('div', 'qrow' + (key === active ? ' is-active' : ''));
    row.tabIndex = 0;
    row.setAttribute('role', 'listitem');
    row.dataset.key = key;
    row.title = track.fileName;
    if (key === active) row.setAttribute('aria-current', 'true');

    row.appendChild(h('span', 'q-index', String(index + 1)));

    var main = h('span', 'q-main');
    main.appendChild(h('span', 'q-title', track.title));
    main.appendChild(h('span', 'q-artist', track.artist));
    row.appendChild(main);

    row.appendChild(h('span', 'q-dur', track.duration ? formatTime(track.duration) : '\u2014'));
    var actions = h('span', 'q-actions');
    var up = h('button', 'q-action', '\u2191');
    up.type = 'button';
    up.title = 'Move up';
    up.addEventListener('click', function (event) { event.stopPropagation(); moveQueueKey(key, -1); });
    var down = h('button', 'q-action', '\u2193');
    down.type = 'button';
    down.title = 'Move down';
    down.addEventListener('click', function (event) { event.stopPropagation(); moveQueueKey(key, 1); });
    var remove = h('button', 'q-action', '\u00d7');
    remove.type = 'button';
    remove.title = 'Remove from queue';
    remove.disabled = key === active;
    remove.addEventListener('click', function (event) { event.stopPropagation(); removeFromQueue(key); });
    actions.appendChild(up);
    actions.appendChild(down);
    actions.appendChild(remove);
    row.appendChild(actions);
    row.addEventListener('click', function () { playKey(key, { autoplay: true }); });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        playKey(key, { autoplay: true });
      }
    });
    row.draggable = true;
    row.addEventListener('dragstart', function (event) {
      event.dataTransfer.setData('text/plain', key);
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', function () { row.classList.remove('is-dragging'); });
    row.addEventListener('dragover', function (event) { event.preventDefault(); row.classList.add('is-drop-target'); });
    row.addEventListener('dragleave', function () { row.classList.remove('is-drop-target'); });
    row.addEventListener('drop', function (event) {
      event.preventDefault();
      row.classList.remove('is-drop-target');
      var source = event.dataTransfer.getData('text/plain');
      var sourceIndex = state.order.indexOf(source);
      var targetIndex = state.order.indexOf(key);
      if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return;
      state.order.splice(sourceIndex, 1);
      state.order.splice(targetIndex, 0, source);
      renderQueue();
      persistSession();
    });
    fragment.appendChild(row);
  });

  setChildren(el.queueList, fragment);
  var total = state.order.length;
  el.queueCount.textContent = String(total);
  el.queueTitle.textContent = state.queueTitle ? 'Queue \u00b7 ' + state.queueTitle : 'Queue';
  el.queueEmpty.hidden = total > 0;
  if (el.queueClear) el.queueClear.disabled = total <= (state.currentKey ? 1 : 0);

  var activeRow = el.queueList.querySelector('.qrow.is-active');
  if (activeRow && typeof activeRow.scrollIntoView === 'function') {
    activeRow.scrollIntoView({ block: 'nearest' });
  }
}

/* ------------------------------------------------------------------ *
 * Cards and rows
 * ------------------------------------------------------------------ */

function artNode(label, hue, className) {
  var art = h('div', className || 'card-art', initialsFor(label));
  art.style.setProperty('--hue', String(hue));
  return art;
}

function coverArt(node, track) {
  if (!node || !track) return;
  var cover = trackCoverUrl(track);
  if (cover) {
    node.style.backgroundImage = 'url("' + cover.replace(/"/g, '%22') + '")';
    node.classList.add('has-cover');
  }
}

function card(opts) {
  var node = h('div', 'card');
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', opts.title);

  var art = artNode(opts.art || opts.title, opts.hue, 'card-art');
  coverArt(art, opts.track);
  var play = h('span', 'card-play');
  play.innerHTML = ICON_PLAY;
  play.setAttribute('aria-hidden', 'true');
  art.appendChild(play);

  var text = h('div', 'card-text');
  text.appendChild(h('span', 'card-title', opts.title));
  text.appendChild(h('span', 'card-sub', opts.sub || ''));

  node.appendChild(art);
  node.appendChild(text);

  node.addEventListener('click', opts.onOpen || opts.onPlay);
  node.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      (opts.onOpen || opts.onPlay)();
    }
  });
  return node;
}

function trackRow(track, opts) {
  var o = opts || {};
  var active = state.currentKey === track.key;
  var missing = !ensureUrl(track);
  var row = h('div', 'trow' + (active ? ' is-active' : '') + (missing ? ' is-missing' : ''));
  row.title = missing ? track.fileName + ' \u2014 audio file not loaded' : track.fileName;

  row.appendChild(h('span', 'trow-index', String(o.index)));

  // The row itself is not a button: a clickable container with role="button"
  // hides the nested overflow button from TalkBack/VoiceOver, which made the
  // add-to-playlist menu unreachable on Android.
  var main = h('button', 'trow-main');
  main.type = 'button';
  main.setAttribute('aria-label', 'Play ' + track.title + ' by ' + track.artist);
  var rowArt = artNode(track.title, hueFor(track.artist + track.title), 'trow-art');
  coverArt(rowArt, track);
  main.appendChild(rowArt);
  var copy = h('span', 'trow-copy');
  copy.appendChild(h('span', 'trow-title', track.title));
  copy.appendChild(h('span', 'trow-artist', track.artist));
  main.appendChild(copy);
  main.addEventListener('click', function () { o.onPlay(track); });
  row.appendChild(main);

  row.appendChild(h('span', 'trow-dur', track.duration ? formatTime(track.duration) : '\u2014'));

  var like = h('button', 'trow-btn trow-like', isLiked(track.key) ? '\u2665' : '\u2661');
  like.type = 'button';
  like.title = isLiked(track.key) ? 'Unlike' : 'Like';
  like.setAttribute('aria-label', (isLiked(track.key) ? 'Unlike ' : 'Like ') + track.title);
  like.setAttribute('aria-pressed', isLiked(track.key) ? 'true' : 'false');
  like.addEventListener('click', function (event) {
    event.stopPropagation();
    toggleLike(track.key);
  });

  var actions = h('span', 'trow-actions');
  actions.appendChild(like);
  var more = h('button', 'trow-btn', '\u22EF');
  more.type = 'button';
  more.setAttribute('aria-label', 'More options for ' + track.title);
  more.addEventListener('click', function (event) {
    event.stopPropagation();
    openTrackMenu(more, track);
  });
  actions.appendChild(more);
  row.appendChild(actions);
  return row;
}

function sectionHead(title, actionLabel, onAction) {
  var head = h('div', 'section-head');
  head.appendChild(h('h2', 'section-title', title));
  if (actionLabel) {
    var action = h('button', 'section-action', actionLabel);
    action.type = 'button';
    action.addEventListener('click', onAction);
    head.appendChild(action);
  }
  return head;
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

function render() {
  renderPlaylistNav();
  syncNav();
  var view = state.view || { type: 'home' };
  if (view.type === 'songs') renderSongs(el.view);
  else if (view.type === 'liked') renderLiked(el.view);
  else if (view.type === 'stats') renderStats(el.view);
  else if (view.type === 'playlist') renderPlaylist(el.view, view.id);
  else if (view.type === 'discover') renderDiscover(el.view);
  else renderHome(el.view);
  renderNowPlaying();
  syncControls();
  renderQueue();
  updateStorageReadout();
}

function syncNav() {
  var type = (state.view && state.view.type) || 'home';
  Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (button) {
    var active = button.dataset.view === type;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function renderPlaylistNav() {
  var frag = document.createDocumentFragment();
  state.playlists.forEach(function (playlist) {
    var active = state.view.type === 'playlist' && state.view.id === playlist.id;
    var chip = h('button', 'pl-chip' + (active ? ' is-active' : ''));
    chip.type = 'button';
    var label = h('span', '', playlist.name);
    chip.appendChild(label);
    chip.appendChild(h('small', '', String(playlist.keys.length)));
    chip.title = playlist.name;
    chip.addEventListener('click', function () {
      state.view = { type: 'playlist', id: playlist.id };
      render();
      el.view.scrollTop = 0;
    });
    frag.appendChild(chip);
  });
  setChildren(el.playlistNav, frag);
}

function renderHome(root) {
  var frag = document.createDocumentFragment();
  var hour = new Date().getHours();
  var greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  frag.appendChild(h('div', 'view-hours', greeting));
  frag.appendChild(h('h1', 'view-title', 'Your music'));

  if (!state.tracks.size) {
    var empty = h('p', 'empty', DESKTOP
      ? 'No tracks yet. Paste a Spotify or YouTube Music playlist link above and press Import, or add audio files from the sidebar.'
      : 'No tracks yet. This build plays the library that was bundled when it was made \u2014 import music on the desktop app, then rebuild.');
    frag.appendChild(empty);
    setChildren(root, frag);
    return;
  }

  var recentKeys = state.recent.filter(function (key) { return state.tracks.has(key); }).slice(0, 6);
  if (recentKeys.length) {
    var recentSection = h('section', 'section');
    recentSection.appendChild(sectionHead('Recently played', 'All songs', function () {
      state.view = { type: 'songs' };
      render();
    }));
    var recentGrid = h('div', 'grid');
    recentKeys.forEach(function (key) {
      var track = state.tracks.get(key);
      recentGrid.appendChild(card({
        track: track,
        title: track.title,
        sub: track.artist,
        hue: hueFor(track.artist + track.title),
        onOpen: function () { playList(state.order.length ? state.order : state.naturalOrder, key, state.queueTitle); },
        onPlay: function () { playKey(key, { autoplay: true }); }
      }));
    });
    recentSection.appendChild(recentGrid);
    frag.appendChild(recentSection);
  }

  var playlistSection = h('section', 'section');
  playlistSection.appendChild(sectionHead('Your playlists', 'New playlist', function () { openPlaylistDialog(null, null); }));
  var playlistGrid = h('div', 'grid');
  state.playlists.forEach(function (playlist) {
    var keys = playlist.keys.filter(function (key) { return state.tracks.has(key); });
    playlistGrid.appendChild(card({
      art: playlist.name,
      title: playlist.name,
      sub: trackCountLabel(keys.length),
      hue: hueFor(playlist.name),
      onOpen: function () {
        state.view = { type: 'playlist', id: playlist.id };
        render();
      },
      onPlay: function () { playList(keys, null, playlist.name); }
    }));
  });
  var addCard = card({
    art: 'Playlist',
    title: 'New playlist',
    sub: 'Build your own mix',
    hue: 210,
    onOpen: function () { openPlaylistDialog(null, null); },
    onPlay: function () { openPlaylistDialog(null, null); }
  });
  playlistGrid.appendChild(addCard);
  playlistSection.appendChild(playlistGrid);
  frag.appendChild(playlistSection);

  var librarySection = h('section', 'section');
  librarySection.appendChild(sectionHead('Library', String(state.tracks.size) + ' songs', function () {
    state.view = { type: 'songs' };
    render();
  }));
  var libraryGrid = h('div', 'grid');
  libraryGrid.appendChild(card({
    art: 'All songs',
    title: 'All songs',
    sub: state.tracks.size + ' tracks \u00b7 ' + formatTime(totalDuration(state.naturalOrder)),
    hue: 150,
    onOpen: function () { state.view = { type: 'songs' }; render(); },
    onPlay: function () { playList(state.naturalOrder, null, 'Library'); }
  }));
  libraryGrid.appendChild(card({
    art: 'Smart shuffle',
    title: 'Smart shuffle',
    sub: 'Mixes artists, skips recent',
    hue: 280,
    onOpen: function () {
      state.shuffleMode = 'smart';
      playList(state.naturalOrder, null, 'Smart shuffle');
    },
    onPlay: function () {
      state.shuffleMode = 'smart';
      playList(state.naturalOrder, null, 'Smart shuffle');
    }
  }));
  libraryGrid.appendChild(card({
    art: 'Discover',
    title: 'Discover',
    sub: 'Online recommendations',
    hue: 20,
    onOpen: function () { state.view = { type: 'discover' }; render(); },
    onPlay: function () { state.view = { type: 'discover' }; render(); }
  }));
  librarySection.appendChild(libraryGrid);
  frag.appendChild(librarySection);

  setChildren(root, frag);
}

var searchField = null;

function renderSongs(root) {
  var frag = document.createDocumentFragment();
  var keys = state.naturalOrder.slice();

  frag.appendChild(h('div', 'view-hours', 'Library'));
  frag.appendChild(h('h1', 'view-title', 'Songs'));
  frag.appendChild(h('p', 'view-sub', trackCountLabel(keys.length) + ' \u00b7 ' + formatTime(totalDuration(keys))));

  var form = h('form', 'import-bar');
  form.style.maxWidth = '420px';
  form.style.margin = '0 0 16px';
  var input = h('input', 'import-input');
  input.type = 'search';
  input.placeholder = 'Search songs or artists';
  input.value = state.search || '';
  input.setAttribute('aria-label', 'Search songs');
  form.appendChild(input);
  frag.appendChild(form);
  searchField = input;

  if (!keys.length) {
    frag.appendChild(h('p', 'empty', 'The library is empty. Import a playlist or add audio files.'));
    setChildren(root, frag);
    return;
  }

  var table = h('div', 'table');
  var header = h('div', 'thead');
  header.appendChild(h('span', '', '#'));
  header.appendChild(h('span', '', 'Title'));
  header.appendChild(h('span', '', 'Length'));
  header.appendChild(h('span', '', ''));
  table.appendChild(header);

  var rows = [];
  keys.forEach(function (key, index) {
    var track = state.tracks.get(key);
    var row = trackRow(track, {
      index: index + 1,
      onPlay: function (item) { playList(state.naturalOrder, item.key, 'Library'); }
    });
    row.dataset.search = (track.title + ' ' + track.artist + ' ' + track.fileName).toLowerCase();
    rows.push(row);
    table.appendChild(row);
  });
  frag.appendChild(table);

  var empty = h('p', 'empty', 'No songs match that search.');
  empty.hidden = true;
  frag.appendChild(empty);

  function filter() {
    var query = input.value.trim().toLowerCase();
    state.search = query;
    var shown = 0;
    rows.forEach(function (row) {
      var match = !query || row.dataset.search.indexOf(query) !== -1;
      row.hidden = !match;
      if (match) shown += 1;
    });
    empty.hidden = shown > 0;
  }
  input.addEventListener('input', filter);
  filter();

  setChildren(root, frag);
}

function renderLiked(root) {
  var keys = state.naturalOrder.filter(function (key) { return isLiked(key); });
  var frag = document.createDocumentFragment();
  frag.appendChild(h('div', 'view-hours', 'Your collection'));
  frag.appendChild(h('h1', 'view-title', 'Liked songs'));
  frag.appendChild(h('p', 'view-sub', trackCountLabel(keys.length) + ' you marked as favorites'));
  if (!keys.length) {
    frag.appendChild(h('p', 'empty', 'Songs you like will appear here. Use \u22ef on a song to add it.'));
    setChildren(root, frag);
    return;
  }
  var actions = h('div', 'pl-actions');
  var play = h('button', 'btn btn-primary', 'Play liked songs');
  play.type = 'button';
  play.addEventListener('click', function () { playList(keys, null, 'Liked songs'); });
  actions.appendChild(play);
  frag.appendChild(actions);
  var table = h('div', 'table');
  var header = h('div', 'thead');
  header.appendChild(h('span', '', '#'));
  header.appendChild(h('span', '', 'Title'));
  header.appendChild(h('span', '', 'Length'));
  header.appendChild(h('span', '', ''));
  table.appendChild(header);
  keys.forEach(function (key, index) {
    table.appendChild(trackRow(state.tracks.get(key), {
      index: index + 1,
      onPlay: function (track) { playList(keys, track.key, 'Liked songs'); }
    }));
  });
  frag.appendChild(table);
  setChildren(root, frag);
}

function renderStats(root) {
  var keys = state.naturalOrder.slice().sort(function (a, b) {
    return trackStats(b).plays - trackStats(a).plays;
  });
  var totalSeconds = keys.reduce(function (sum, key) { return sum + trackStats(key).seconds; }, 0);
  var totalPlays = keys.reduce(function (sum, key) { return sum + trackStats(key).plays; }, 0);
  var frag = document.createDocumentFragment();
  frag.appendChild(h('div', 'view-hours', 'Insights'));
  frag.appendChild(h('h1', 'view-title', 'Listening stats'));
  frag.appendChild(h('p', 'view-sub', totalPlays + ' plays \u00b7 ' + formatTime(totalSeconds) + ' listened \u00b7 ' + Object.keys(state.likes).filter(function (key) { return state.likes[key]; }).length + ' liked'));
  if (!keys.length || !totalPlays) {
    frag.appendChild(h('p', 'empty', 'Play some tracks to build your listening stats.'));
    setChildren(root, frag);
    return;
  }
  var table = h('div', 'stats-table');
  var header = h('div', 'stats-row stats-head');
  ['Track', 'Plays', 'Skips', 'Time'].forEach(function (label) { header.appendChild(h('span', '', label)); });
  table.appendChild(header);
  keys.slice(0, 50).forEach(function (key) {
    var track = state.tracks.get(key);
    var stats = trackStats(key);
    var row = h('div', 'stats-row');
    row.appendChild(h('span', 'stats-track', track.title + ' \u00b7 ' + track.artist));
    row.appendChild(h('span', '', String(stats.plays)));
    row.appendChild(h('span', '', String(stats.skips)));
    row.appendChild(h('span', '', formatTime(stats.seconds)));
    row.addEventListener('click', function () { playKey(key, { autoplay: true }); });
    table.appendChild(row);
  });
  frag.appendChild(table);
  setChildren(root, frag);
}

function findPlaylist(id) {
  for (var i = 0; i < state.playlists.length; i += 1) {
    if (state.playlists[i].id === id) return state.playlists[i];
  }
  return null;
}

function renderPlaylist(root, id) {
  var playlist = findPlaylist(id);
  if (!playlist) {
    state.view = { type: 'home' };
    renderHome(root);
    return;
  }
  var keys = playlist.keys.filter(function (key) { return state.tracks.has(key); });

  var frag = document.createDocumentFragment();
  var hero = h('div', 'pl-hero');
  var art = h('div', 'pl-art', initialsFor(playlist.name));
  art.style.setProperty('--hue', String(hueFor(playlist.name)));
  hero.appendChild(art);

  var meta = h('div', 'pl-meta');
  meta.appendChild(h('div', 'pl-kind', 'Playlist'));
  meta.appendChild(h('h1', 'pl-name', playlist.name));
  meta.appendChild(h('div', 'pl-sub', trackCountLabel(keys.length) + ' \u00b7 ' + formatTime(totalDuration(keys))));
  hero.appendChild(meta);
  frag.appendChild(hero);

  var actions = h('div', 'pl-actions');
  var playBtn = h('button', 'btn btn-primary', 'Play');
  playBtn.type = 'button';
  playBtn.addEventListener('click', function () { playList(keys, null, playlist.name); });
  actions.appendChild(playBtn);

  var shuffleBtn = h('button', 'btn', 'Smart shuffle');
  shuffleBtn.type = 'button';
  shuffleBtn.addEventListener('click', function () {
    state.shuffleMode = 'smart';
    playList(keys, null, playlist.name);
  });
  actions.appendChild(shuffleBtn);

  var renameBtn = h('button', 'btn btn-ghost', 'Rename');
  renameBtn.type = 'button';
  renameBtn.addEventListener('click', function () { openPlaylistDialog(playlist, null); });
  actions.appendChild(renameBtn);

  var deleteBtn = h('button', 'btn btn-ghost', 'Delete');
  deleteBtn.type = 'button';
  deleteBtn.addEventListener('click', function () {
    openModal({
      title: 'Delete playlist',
      body: 'Delete \u201c' + playlist.name + '\u201d? The audio files stay in your library.',
      input: false,
      okLabel: 'Delete',
      danger: true,
      onConfirm: function () {
        state.playlists = state.playlists.filter(function (item) { return item.id !== playlist.id; });
        savePlaylists();
        state.view = { type: 'home' };
        render();
      }
    });
  });
  actions.appendChild(deleteBtn);
  frag.appendChild(actions);

  if (!keys.length) {
    frag.appendChild(h('p', 'empty', 'This playlist is empty. Use \u22EF on any song to add it here.'));
    setChildren(root, frag);
    return;
  }

  var table = h('div', 'table');
  var header = h('div', 'thead');
  header.appendChild(h('span', '', '#'));
  header.appendChild(h('span', '', 'Title'));
  header.appendChild(h('span', '', 'Length'));
  header.appendChild(h('span', '', ''));
  table.appendChild(header);

  keys.forEach(function (key, index) {
    var track = state.tracks.get(key);
    table.appendChild(trackRow(track, {
      index: index + 1,
      onPlay: function (item) { playList(keys, item.key, playlist.name); }
    }));
  });
  frag.appendChild(table);
  setChildren(root, frag);
}

function renderDiscover(root) {
  var frag = document.createDocumentFragment();
  frag.appendChild(h('div', 'view-hours', 'Online'));
  frag.appendChild(h('h1', 'view-title', 'Discover'));
  frag.appendChild(h('p', 'view-sub', 'Related tracks from YouTube Music radio, based on what you already have.'));

  if (!DESKTOP || typeof DESKTOP.fetchRecommendations !== 'function') {
    frag.appendChild(h('div', 'rec-note', 'Recommendations need an internet connection and the desktop app. On the phone the app is fully offline, so this tab stays empty.'));
    setChildren(root, frag);
    return;
  }

  var actions = h('div', 'pl-actions');
  var refresh = h('button', 'btn', state.recState === 'loading' ? 'Looking\u2026' : 'Find more');
  refresh.type = 'button';
  refresh.disabled = state.recState === 'loading';
  refresh.addEventListener('click', function () { loadRecommendations(); });
  actions.appendChild(refresh);
  frag.appendChild(actions);

  if (state.recState === 'loading') {
    frag.appendChild(h('p', 'empty', 'Looking for tracks near your library\u2026'));
  } else if (state.recState === 'error') {
    frag.appendChild(h('div', 'rec-note', 'Could not load recommendations: ' + state.recError));
  } else if (!state.recommendations.length) {
    frag.appendChild(h('div', 'rec-note', 'No recommendations yet. Import a few tracks first, then press \u201cFind more\u201d.'));
  } else {
    var grid = h('div', 'rec-grid');
    state.recommendations.forEach(function (pick) {
      var item = h('div', 'rec-card');
      var art = h('div', 'rec-art', initialsFor(pick.title || pick.artist || '?'));
      art.style.setProperty('--hue', String(hueFor((pick.artist || '') + (pick.title || ''))));
      item.appendChild(art);

      var body = h('div', 'rec-body');
      body.appendChild(h('span', 'rec-title', pick.title || 'Unknown title'));
      body.appendChild(h('span', 'rec-artist', pick.artist || ''));
      item.appendChild(body);

      var add = h('button', 'btn rec-add', 'Add');
      add.type = 'button';
      add.addEventListener('click', function () {
        add.disabled = true;
        add.textContent = 'Adding\u2026';
        submitImport(pick.url);
      });
      item.appendChild(add);
      grid.appendChild(item);
    });
    frag.appendChild(grid);
  }

  setChildren(root, frag);
}

/* ------------------------------------------------------------------ *
 * Playlists
 * ------------------------------------------------------------------ */

function newPlaylistId() {
  return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createPlaylist(name, keys) {
  var playlist = { id: newPlaylistId(), name: name, keys: keys ? keys.slice() : [], createdAt: new Date().toISOString() };
  state.playlists.push(playlist);
  savePlaylists();
  return playlist;
}

function toggleTrackInPlaylist(playlistId, key) {
  var playlist = findPlaylist(playlistId);
  if (!playlist) return;
  var index = playlist.keys.indexOf(key);
  if (index === -1) playlist.keys.push(key);
  else playlist.keys.splice(index, 1);
  savePlaylists();
  if (state.view.type === 'playlist' && state.view.id === playlistId) render();
  else renderPlaylistNav();
}

function openPlaylistDialog(existing, addKey) {
  openModal({
    title: existing ? 'Rename playlist' : 'New playlist',
    value: existing ? existing.name : '',
    placeholder: 'Playlist name',
    okLabel: existing ? 'Rename' : 'Create',
    onConfirm: function (name) {
      if (existing) {
        existing.name = name;
        savePlaylists();
        render();
        return;
      }
      var playlist = createPlaylist(name, addKey ? [addKey] : []);
      state.view = { type: 'playlist', id: playlist.id };
      render();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Track menu
 * ------------------------------------------------------------------ */

var menus = [];
var lyricsTargetKey = null;

function closeMenus() {
  menus.forEach(function (menu) { menu.remove(); });
  menus = [];
}

function menuItem(label, onClick, checked) {
  var item = h('button', 'menu-item' + (checked ? ' is-checked' : ''));
  item.type = 'button';
  item.appendChild(h('span', '', label));
  item.addEventListener('click', function (event) {
    event.stopPropagation();
    onClick();
  });
  return item;
}

function openTrackMenu(anchor, track) {
  closeMenus();
  var menu = h('div', 'menu');
  menu.setAttribute('role', 'menu');

  menu.appendChild(menuItem('Play now', function () {
    closeMenus();
    playKey(track.key, { autoplay: true });
  }));
  menu.appendChild(menuItem('Play next', function () {
    closeMenus();
    enqueueKey(track.key, true);
  }));
  menu.appendChild(menuItem('Add to queue', function () {
    closeMenus();
    enqueueKey(track.key, false);
  }));
  menu.appendChild(menuItem(isLiked(track.key) ? 'Unlike' : 'Like', function () {
    closeMenus();
    toggleLike(track.key);
  }, isLiked(track.key)));

  if (DESKTOP && typeof DESKTOP.attachLyrics === 'function' && el.lyricsPicker) {
    menu.appendChild(menuItem('Attach lyrics\u2026', function () {
      closeMenus();
      lyricsTargetKey = track.key;
      el.lyricsPicker.click();
    }));
  }

  if (state.playlists.length) menu.appendChild(h('div', 'menu-sep'));
  state.playlists.forEach(function (playlist) {
    var checked = playlist.keys.indexOf(track.key) !== -1;
    var item = menuItem(playlist.name, function () {
      toggleTrackInPlaylist(playlist.id, track.key);
      item.classList.toggle('is-checked');
    }, checked);
    menu.appendChild(item);
  });

  menu.appendChild(h('div', 'menu-sep'));
  menu.appendChild(menuItem('New playlist\u2026', function () {
    closeMenus();
    openPlaylistDialog(null, track.key);
  }));

  if (state.view.type === 'playlist') {
    var playlistId = state.view.id;
    menu.appendChild(menuItem('Remove from this playlist', function () {
      closeMenus();
      toggleTrackInPlaylist(playlistId, track.key);
    }));
  }

  if (DESKTOP && typeof DESKTOP.deleteTrack === 'function') {
    menu.appendChild(h('div', 'menu-sep'));
    menu.appendChild(menuItem('Delete from library', function () {
      closeMenus();
      openModal({
        title: 'Delete track',
        body: 'Delete \u201c' + track.title + '\u201d from the library? This removes the local audio file and metadata.',
        input: false,
        okLabel: 'Delete',
        danger: true,
        onConfirm: function () {
          var wasCurrent = state.currentKey === track.key;
          var wasPlaying = wasCurrent && !el.audio.paused;
          Promise.resolve(DESKTOP.deleteTrack(track.fileName)).then(function (result) {
            if (!result || !result.ok) throw new Error((result && result.reason) || 'delete failed');
            state.playlists.forEach(function (playlist) {
              playlist.keys = playlist.keys.filter(function (key) { return key !== track.key; });
            });
            savePlaylists();
            return loadLibrary();
          }).then(function () {
            if (wasCurrent) {
              el.audio.pause();
              el.audio.removeAttribute('src');
              el.audio.load();
              if (wasPlaying) {
                var next = state.order[0];
                if (next) playKey(next, { autoplay: true });
              }
            }
            setBanner('info', 'Deleted \u201c' + track.title + '\u201d.', true);
          }).catch(function (error) {
            setBanner('warn', 'Could not delete track: ' + error.message, true);
          });
        }
      });
    }));
  }

  document.body.appendChild(menu);
  menus.push(menu);

  var rect = anchor.getBoundingClientRect();
  var box = menu.getBoundingClientRect();
  var left = Math.min(rect.right - box.width, window.innerWidth - box.width - 8);
  var top = rect.bottom + 6;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 6);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

var modalAction = null;

function openModal(opts) {
  el.modalTitle.textContent = opts.title;
  el.modalBody.hidden = !opts.body;
  el.modalBody.textContent = opts.body || '';
  var sync = opts.sync === true;
  el.syncFields.hidden = !sync;
  el.modalInput.hidden = sync || opts.input === false;
  el.modalInput.value = opts.value || '';
  el.modalInput.placeholder = opts.placeholder || '';
  el.modalOk.textContent = opts.okLabel || 'Save';
  el.modalOk.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
  modalAction = opts.onConfirm || null;
  el.modal.hidden = false;
  if (sync) el.syncHost.focus();
  else if (opts.input === false) el.modalOk.focus();
  else {
    el.modalInput.focus();
    el.modalInput.select();
  }
}

function closeModal() {
  el.modal.hidden = true;
  el.syncFields.hidden = true;
  modalAction = null;
}

function confirmModal() {
  var action = modalAction;
  if (!el.syncFields.hidden) {
    var host = el.syncHost.value.trim();
    var code = el.syncCode.value.trim();
    if (!host || !code) {
      (host ? el.syncCode : el.syncHost).focus();
      return;
    }
    closeModal();
    if (action) action({ host: host, code: code });
    return;
  }
  var value = el.modalInput.value.trim();
  if (!el.modalInput.hidden && !value) {
    el.modalInput.focus();
    return;
  }
  closeModal();
  if (action) action(value);
}

/* ------------------------------------------------------------------ *
 * Import (desktop bridge) and Discover data
 * ------------------------------------------------------------------ */

function appendImportLine(text) {
  el.importLog.textContent += text + '\n';
  el.importLog.scrollTop = el.importLog.scrollHeight;
}

function setImportBusy(busy) {
  state.importing = busy;
  el.importBtn.disabled = busy;
  el.playlistUrl.disabled = busy;
  el.importBtn.textContent = busy ? 'Importing\u2026' : 'Import';
}

function submitImport(link) {
  var value = String(link != null ? link : el.playlistUrl.value).trim();

  if (!DESKTOP || typeof DESKTOP.startImport !== 'function') {
    setBanner('warn', 'Paste-link import runs in the desktop app. From a terminal: python3 importer.py "' + (value || '<link>') + '"', true);
    return false;
  }
  if (!/^(https?:\/\/|spotify:)/i.test(value)) {
    setBanner('warn', 'Paste a full playlist link that starts with https://', true);
    return false;
  }
  if (state.importing) return false;

  el.importPanel.hidden = false;
  el.importTitle.textContent = 'Importing\u2026';
  el.importLog.textContent = '';
  setImportBusy(true);
  var promise;

  promise = Promise.resolve(DESKTOP.startImport(value));
  promise.then(function (result) {
    if (!result || !result.started) {
      setImportBusy(false);
      el.importTitle.textContent = 'Import not started';
      setBanner('warn', (result && result.reason) || 'The import could not start.', true);
      if (state.view.type === 'discover') render();
      return;
    }
    el.playlistUrl.value = '';
  }).catch(function (error) {
    setImportBusy(false);
    el.importTitle.textContent = 'Import failed';
    setBanner('warn', 'Import could not start: ' + (error && error.message ? error.message : error), true);
    if (state.view.type === 'discover') render();
  });
  return true;
}

function handleImportEvent(payload) {
  if (!payload) return;
  if (payload.type === 'line') {
    appendImportLine(payload.line);
    return;
  }
  if (payload.type !== 'done') return;

  setImportBusy(false);
  if (payload.code === 0) {
    el.importTitle.textContent = 'Import finished';
    setBanner('info', 'Library updated.', true);
    loadLibrary().then(function () {
      applyPendingRestore();
      if (state.view.type === 'discover') render();
    });
  } else {
    el.importTitle.textContent = 'Import failed';
    setBanner('warn', payload.error || 'Import failed (exit ' + payload.code + '). See the log below.', true);
  }
}

function loadRecommendations() {
  if (!DESKTOP || typeof DESKTOP.fetchRecommendations !== 'function') return;
  if (state.recState === 'loading') return;

  state.recState = 'loading';
  state.recError = '';
  render();

  Promise.resolve(DESKTOP.fetchRecommendations(12)).then(function (result) {
    if (!result || !result.ok) {
      state.recState = 'error';
      state.recError = (result && result.reason) || 'the helper did not answer';
    } else {
      state.recommendations = Array.isArray(result.picks) ? result.picks : [];
      state.recState = state.recommendations.length ? 'ready' : 'empty';
    }
    if (state.view.type === 'discover') render();
  }).catch(function (error) {
    state.recState = 'error';
    state.recError = error && error.message ? error.message : String(error);
    if (state.view.type === 'discover') render();
  });
}

function openSyncDialog() {
  if (DESKTOP && typeof DESKTOP.getSyncInfo === 'function') {
    Promise.resolve(DESKTOP.getSyncInfo()).then(function (info) {
      if (!info || !info.address) throw new Error('LAN sync could not start');
      openModal({
        title: 'Sync this library',
        body: 'On the phone, enter this address and pairing code. Keep both devices on the same Wi-Fi network.\n\n' + info.address + ' \u00b7 pairing code ' + info.code,
        input: false,
        okLabel: 'Done',
        onConfirm: function () {}
      });
    }).catch(function (error) {
      setBanner('warn', 'Could not start LAN sync: ' + error.message, true);
    });
    return;
  }
  if (!window.LocalMusicMobile || !LocalMusicMobile.available()) {
    setBanner('info', 'LAN sync is available from the desktop app. Open Sync there to get an address and pairing code.', true);
    return;
  }
  openModal({
    title: 'Sync from desktop',
    sync: true,
    okLabel: 'Sync',
    onConfirm: function (pair) {
      setBanner('info', 'Syncing library\u2026', false);
      LocalMusicMobile.syncFromDesktop(pair.host, pair.code, function (done, total, bytes) {
        setBanner('info', 'Syncing ' + done + '/' + total + ' \u00b7 ' + Math.round(bytes / 1048576 * 10) / 10 + ' MB', false);
      }).then(function (result) {
        return loadLibrary().then(function () {
          setBanner('info', 'Synced ' + result.count + ' tracks.', true);
          updateStorageReadout();
        });
      }).catch(function (error) {
        setBanner('warn', 'Sync failed: ' + error.message, true);
      });
    }
  });
}

function importDeviceFiles(files) {
  if (!window.LocalMusicMobile || !LocalMusicMobile.available()) {
    addFiles(files);
    return;
  }
  setBanner('info', 'Importing selected audio into app storage\u2026', false);
  LocalMusicMobile.importFiles(Array.prototype.slice.call(files || [])).then(function (result) {
    return loadLibrary().then(function () {
      setBanner('info', 'Imported ' + result.added.length + ' file' + (result.added.length === 1 ? '' : 's') +
        (result.skipped ? ' \u00b7 ' + result.skipped + ' already present' : '') + '.', true);
      updateStorageReadout();
    });
  }).catch(function (error) {
    setBanner('warn', 'Device import failed: ' + error.message, true);
  });
}

function updateStorageReadout() {
  if (!el.storageReadout) return;
  var total = state.tracks.size;
  if (DESKTOP && typeof DESKTOP.getStorageInfo === 'function') {
    Promise.resolve(DESKTOP.getStorageInfo()).then(function (info) {
      if (info) el.storageReadout.textContent = 'Library storage \u00b7 ' + Math.round((Number(info.size) || 0) / 1048576 * 10) / 10 + ' MB';
    });
    return;
  }
  if (window.LocalMusicMobile && LocalMusicMobile.available() && typeof LocalMusicMobile.storageInfo === 'function') {
    LocalMusicMobile.storageInfo().then(function (info) {
      if (!info) return;
      el.storageReadout.textContent = 'App storage \u00b7 ' + Math.round((Number(info.size) || 0) / 1048576 * 10) / 10 + ' MB';
    });
    return;
  }
  el.storageReadout.textContent = total + ' track' + (total === 1 ? '' : 's') + ' in library';
}

function retryFailedImports() {
  if (!DESKTOP || typeof DESKTOP.retryFailed !== 'function') {
    setBanner('info', 'Retry failed imports from the desktop app.', true);
    return;
  }
  setBanner('info', 'Retrying failed imports\u2026', false);
  Promise.resolve(DESKTOP.retryFailed()).then(function (result) {
    if (!result || !result.started) throw new Error((result && result.reason) || 'retry could not start');
    el.importPanel.hidden = false;
    el.importTitle.textContent = 'Retrying failed imports\u2026';
  }).catch(function (error) {
    setBanner('warn', 'Could not retry failed imports: ' + error.message, true);
  });
}

var paletteItems = [];
var paletteIndex = 0;

function command(label, hint, action) {
  return { label: label, hint: hint || '', action: action };
}

function buildPaletteItems() {
  var items = [
    command('Play / pause', 'Space', togglePlay),
    command('Open liked songs', 'Navigation', function () { setView('liked'); }),
    command('Open listening stats', 'Navigation', function () { setView('stats'); }),
    command('Play all songs', 'Library', function () { playList(state.naturalOrder, null, 'Library'); }),
    command('Smart shuffle', 'Library', function () { state.shuffleMode = 'smart'; playList(state.naturalOrder, null, 'Smart shuffle'); }),
    command('Sync library', 'Device', openSyncDialog),
    command('Set sleep timer', 'Playback', function () { cycleSleepTimer(); })
  ];
  state.playlists.forEach(function (playlist) {
    items.push(command('Playlist: ' + playlist.name, trackCountLabel(playlist.keys.length), function () {
      state.view = { type: 'playlist', id: playlist.id };
      render();
    }));
  });
  state.naturalOrder.forEach(function (key) {
    var track = state.tracks.get(key);
    if (track) items.push(command(track.title, track.artist, function () { playKey(key, { autoplay: true }); }));
  });
  return items;
}

function renderPalette() {
  if (!el.paletteResults) return;
  var query = (el.paletteInput.value || '').trim().toLowerCase();
  var filtered = paletteItems.filter(function (item) {
    return !query || (item.label + ' ' + item.hint).toLowerCase().indexOf(query) !== -1;
  }).slice(0, 40);
  paletteIndex = Math.min(paletteIndex, Math.max(0, filtered.length - 1));
  var fragment = document.createDocumentFragment();
  filtered.forEach(function (item, index) {
    var row = h('button', 'palette-row' + (index === paletteIndex ? ' is-selected' : ''));
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.appendChild(h('span', 'palette-label', item.label));
    row.appendChild(h('span', 'palette-hint', item.hint));
    row.addEventListener('click', function () {
      closePalette();
      item.action();
    });
    fragment.appendChild(row);
  });
  setChildren(el.paletteResults, fragment);
}

function openPalette() {
  paletteItems = buildPaletteItems();
  paletteIndex = 0;
  el.palette.hidden = false;
  el.paletteInput.value = '';
  renderPalette();
  el.paletteInput.focus();
}

function closePalette() {
  if (el.palette) el.palette.hidden = true;
}

function cycleSleepTimer() {
  var options = [0, 15, 30, 60];
  var current = state.sleepAt ? Math.max(1, Math.round((state.sleepAt - Date.now()) / 60000)) : 0;
  var index = options.indexOf(current);
  var next = options[(index + 1) % options.length];
  setSleepTimer(next);
  setBanner(next ? 'info' : 'info', next ? 'Sleep timer set for ' + next + ' minutes.' : 'Sleep timer cleared.', true);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function cycleShuffle() {
  var index = SHUFFLE_MODES.indexOf(state.shuffleMode);
  var next = SHUFFLE_MODES[(index + 1) % SHUFFLE_MODES.length];
  setShuffleMode(next);
  if (next === 'smart') setBanner('info', 'Smart shuffle: mixes artists and pushes recently played tracks back.', true);
  if (state.view.type === 'home') render();
}

function cycleRepeat() {
  var index = REPEAT_MODES.indexOf(state.repeat);
  state.repeat = REPEAT_MODES[(index + 1) % REPEAT_MODES.length];
  syncControls();
  persistSession();
}

function setView(type) {
  if (type === 'discover') state.view = { type: 'discover' };
  else state.view = { type: type };
  render();
  if (typeof el.view.scrollTo === 'function') el.view.scrollTo(0, 0);
  if (type === 'discover' && state.recState === 'idle') loadRecommendations();
}

function bindEvents() {
  if (el.retryFailedBtn && DESKTOP && typeof DESKTOP.retryFailed === 'function') el.retryFailedBtn.hidden = false;
  el.playBtn.addEventListener('click', togglePlay);
  el.prevBtn.addEventListener('click', playPrevious);
  el.nextBtn.addEventListener('click', function () { playNext(true); });
  el.shuffleBtn.addEventListener('click', cycleShuffle);
  el.repeatBtn.addEventListener('click', cycleRepeat);
  if (el.crossfadeBtn) {
    el.crossfadeBtn.addEventListener('click', function () {
      var options = [0, 3, 6, 9, 12];
      var index = options.indexOf(state.crossfade);
      setCrossfade(options[(index + 1) % options.length]);
    });
  }
  if (el.speedBtn) {
    el.speedBtn.addEventListener('click', function () {
      var options = [0.75, 1, 1.25, 1.5, 2];
      var index = options.indexOf(state.playbackRate);
      setPlaybackRate(options[(index + 1) % options.length]);
    });
  }
  if (el.sleepBtn) el.sleepBtn.addEventListener('click', cycleSleepTimer);

  el.seek.addEventListener('input', function () {
    state.seekDragging = true;
    var value = Number(el.seek.value);
    el.timeCurrent.textContent = formatTime(value);
    paintRange(el.seek);
  });
  el.seek.addEventListener('change', function () {
    state.seekDragging = false;
    if (Number.isFinite(el.audio.duration) && el.audio.duration > 0) {
      el.audio.currentTime = clamp(Number(el.seek.value), 0, el.audio.duration);
      updateTimeUI();
      persistSession();
    }
  });

  el.volume.addEventListener('input', function () {
    state.volume = clamp(Number(el.volume.value), 0, 1);
    el.audio.volume = state.volume;
    el.volValue.textContent = Math.round(state.volume * 100) + '%';
    paintRange(el.volume);
    persistSession();
  });

  el.queueBtn.addEventListener('click', function () {
    var open = el.queueDrawer.classList.toggle('is-open');
    el.queueDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    el.queueBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  el.queueClose.addEventListener('click', function () {
    el.queueDrawer.classList.remove('is-open');
    el.queueDrawer.setAttribute('aria-hidden', 'true');
    el.queueBtn.setAttribute('aria-expanded', 'false');
  });
  if (el.queueClear) el.queueClear.addEventListener('click', clearQueue);
  if (el.likeBtn) {
    el.likeBtn.addEventListener('click', function () {
      var track = currentTrack();
      if (track) toggleLike(track.key);
    });
  }

  el.bannerClose.addEventListener('click', function () { setBanner('', '', false); });

  el.reloadLibrary.addEventListener('click', function () {
    loadLibrary().then(function () { applyPendingRestore(); });
  });

  el.addFilesBtn.addEventListener('click', function () { el.filePicker.click(); });
  el.addFolderBtn.addEventListener('click', function () { el.folderPicker.click(); });
  if (el.deviceImportBtn) el.deviceImportBtn.addEventListener('click', function () { el.deviceFilePicker.click(); });
  el.filePicker.addEventListener('change', function () {
    addFiles(el.filePicker.files);
    el.filePicker.value = '';
  });
  el.folderPicker.addEventListener('change', function () {
    addFiles(el.folderPicker.files);
    el.folderPicker.value = '';
  });
  if (el.deviceFilePicker) {
    el.deviceFilePicker.addEventListener('change', function () {
      importDeviceFiles(el.deviceFilePicker.files);
      el.deviceFilePicker.value = '';
    });
  }
  if (el.lyricsPicker) {
    el.lyricsPicker.addEventListener('change', function () {
      var file = el.lyricsPicker.files && el.lyricsPicker.files[0];
      var key = lyricsTargetKey;
      lyricsTargetKey = null;
      el.lyricsPicker.value = '';
      if (!file || !key || !DESKTOP || typeof DESKTOP.attachLyrics !== 'function') return;
      var reader = new FileReader();
      reader.onload = function () {
        Promise.resolve(DESKTOP.attachLyrics(key, String(reader.result || ''))).then(function (result) {
          if (!result || !result.ok) throw new Error((result && result.reason) || 'lyrics attachment failed');
          return loadLibrary();
        }).then(function () {
          setBanner('info', 'Lyrics attached.', true);
        }).catch(function (error) {
          setBanner('warn', 'Could not attach lyrics: ' + error.message, true);
        });
      };
      reader.onerror = function () {
        setBanner('warn', 'Could not read the lyrics file.', true);
      };
      reader.readAsText(file);
    });
  }
  if (el.syncLibraryBtn) el.syncLibraryBtn.addEventListener('click', openSyncDialog);
  if (el.topSyncBtn) el.topSyncBtn.addEventListener('click', openSyncDialog);
  if (el.retryFailedBtn) el.retryFailedBtn.addEventListener('click', retryFailedImports);
  if (el.paletteBtn) el.paletteBtn.addEventListener('click', openPalette);
  if (el.palette) {
    el.palette.addEventListener('click', function (event) {
      if (event.target === el.palette) closePalette();
    });
  }
  if (el.paletteInput) {
    el.paletteInput.addEventListener('input', function () { paletteIndex = 0; renderPalette(); });
    el.paletteInput.addEventListener('keydown', function (event) {
      var rows = el.paletteResults.querySelectorAll('.palette-row');
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        paletteIndex = Math.min(paletteIndex + 1, Math.max(0, rows.length - 1));
        renderPalette();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        paletteIndex = Math.max(0, paletteIndex - 1);
        renderPalette();
      } else if (event.key === 'Enter' && rows[paletteIndex]) {
        event.preventDefault();
        rows[paletteIndex].click();
      }
    });
  }

  el.importBar.addEventListener('submit', function (event) {
    event.preventDefault();
    submitImport(el.playlistUrl.value);
  });
  el.importClose.addEventListener('click', function () { el.importPanel.hidden = true; });

  Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (button) {
    button.addEventListener('click', function () { setView(button.dataset.view); });
  });

  document.getElementById('newPlaylistBtn').addEventListener('click', function () {
    openPlaylistDialog(null, null);
  });

  el.modalOk.addEventListener('click', confirmModal);
  el.modalCancel.addEventListener('click', closeModal);
  el.modal.addEventListener('click', function (event) {
    if (event.target === el.modal) closeModal();
  });
  el.modalInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmModal();
    }
  });
  el.syncCode.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmModal();
    }
  });

  document.addEventListener('click', function (event) {
    if (!event.target.closest || !event.target.closest('.menu')) closeMenus();
  });

  document.addEventListener('keydown', function (event) {
    var tag = event.target && event.target.tagName;
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (event.target && event.target.isContentEditable);

    if (event.key === 'Escape') {
      if (el.palette && !el.palette.hidden) return closePalette();
      if (!el.modal.hidden) return closeModal();
      if (menus.length) return closeMenus();
      if (el.queueDrawer.classList.contains('is-open')) return el.queueClose.click();
      return;
    }
    if (typing) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        togglePlay();
        break;
      case '/':
        event.preventDefault();
        if (state.view.type !== 'songs') setView('songs');
        if (searchField) searchField.focus();
        break;
      case 'ArrowRight':
        event.preventDefault();
        seekBy(5);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        seekBy(-5);
        break;
      case 'n':
      case 'N':
        playNext(true);
        break;
      case 'p':
      case 'P':
        playPrevious();
        break;
      case 's':
      case 'S':
        cycleShuffle();
        break;
      case 'r':
      case 'R':
        cycleRepeat();
        break;
      case 'k':
      case 'K':
        openPalette();
        break;
      default:
        break;
    }
  });

  /* audio elements */
  function bindAudio(audio) {
    if (!audio) return;
    audio.addEventListener('play', function () {
      if (audio !== el.audio) return;
      syncPlayButton();
      renderNowPlaying();
    });
    audio.addEventListener('pause', function () {
      if (audio !== el.audio) return;
      syncPlayButton();
      persistSession();
    });
    audio.addEventListener('timeupdate', function () {
      if (audio !== el.audio) return;
      var previous = Number(state.lastAudioTime) || 0;
      var current = Number(audio.currentTime) || 0;
      if (current > previous && current - previous < 5) notePlaybackSeconds(state.currentKey, current - previous);
      state.lastAudioTime = current;
      updateTimeUI();
      updateLyricsHighlight();
      maybeStartCrossfade();
      if (state.sleepAt && Date.now() >= state.sleepAt) {
        audio.pause();
        setSleepTimer(0);
        setBanner('info', 'Sleep timer ended.', true);
      }
      if (Date.now() - state.lastPersistAt > 5000) persistSession();
    });
    audio.addEventListener('loadedmetadata', function () {
      if (audio === el.audio) updateTimeUI();
    });
    audio.addEventListener('ended', function () {
      if (audio !== el.audio || state.crossfadeTarget) return;
      if (state.repeat === 'one') {
        audio.currentTime = 0;
        var promise = audio.play();
        if (promise && typeof promise.catch === 'function') promise.catch(function () {});
        return;
      }
      if (state.currentKey && (Number(audio.currentTime) || 0) < (currentTrack() || {}).duration * 0.35) {
        noteSkip(state.currentKey);
      }
      playNext(false);
    });
    audio.addEventListener('error', function () {
      if (audio !== el.audio) return;
      var track = currentTrack();
      if (!track) return;
      setBanner('warn', 'Could not play \u201c' + track.title + '\u201d. The file may be missing or corrupt.', true);
    });
  }
  bindAudio(el.audio);
  bindAudio(el.audioNext);
  window.addEventListener('beforeunload', persistSession);
  window.addEventListener('pagehide', persistSession);
  window.setInterval(updateSleepUI, 1000);

  /* media session */
  if ('mediaSession' in navigator && navigator.mediaSession) {
    var handlers = {
      play: function () { togglePlay(); },
      pause: function () { el.audio.pause(); },
      previoustrack: playPrevious,
      nexttrack: function () { playNext(false); },
      stop: function () {
        el.audio.pause();
        el.audio.currentTime = 0;
        updateTimeUI();
      },
      seekbackward: function (details) { seekBy(-(details && details.seekOffset ? details.seekOffset : 10)); },
      seekforward: function (details) { seekBy(details && details.seekOffset ? details.seekOffset : 10); },
      seekto: function (details) {
        if (typeof details.seekTime === 'number') {
          el.audio.currentTime = details.seekTime;
          updateTimeUI();
        }
      }
    };
    Object.keys(handlers).forEach(function (name) {
      try { navigator.mediaSession.setActionHandler(name, handlers[name]); } catch (err) { /* unsupported action */ }
    });
  }

  /* desktop bridges */
  if (DESKTOP) {
    if (typeof DESKTOP.onImportEvent === 'function') DESKTOP.onImportEvent(handleImportEvent);
    if (typeof DESKTOP.onMenuAction === 'function') {
      DESKTOP.onMenuAction(function (action) {
        if (action === 'import') {
          el.importPanel.hidden = false;
          el.playlistUrl.focus();
        } else if (action === 'reload') {
          loadLibrary().then(function () { applyPendingRestore(); });
        } else if (action === 'togglePlay') {
          togglePlay();
        } else if (action === 'next') {
          playNext(true);
        } else if (action === 'previous') {
          playPrevious();
        }
      });
    }
  }
}

function boot() {
  restorePrefs();
  document.body.classList.toggle('is-desktop', Boolean(DESKTOP));
  // Link import needs the Python importer, which only the desktop shell can run.
  if (!DESKTOP) el.importBar.hidden = true;
  bindEvents();
  el.audio.volume = state.volume;
  render();
  loadLibrary().then(function () {
    if (state.pendingRestore) applyPendingRestore();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
