/* Local Music — Capacitor storage helpers.
 *
 * The desktop and plain-web targets keep using the HTTP library server or
 * object URLs. On Android this module stores synced/imported audio in the
 * app's private data directory so a picker grant is never required again.
 */

(function (global) {
  'use strict';

  var capacitor = global.Capacitor || null;
  var plugins = capacitor && capacitor.Plugins ? capacitor.Plugins : null;
  var filesystem = plugins && plugins.Filesystem ? plugins.Filesystem : null;
  var http = plugins && plugins.CapacitorHttp ? plugins.CapacitorHttp : null;
  var DATA = 'DATA';
  var PLAYLIST_PATH = 'library/playlist.json';
  var MAX_IMPORT_BYTES = 512 * 1024 * 1024;

  function isAvailable() {
    return Boolean(filesystem);
  }

  function normalizeBase(value) {
    var base = String(value || '').trim();
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
    return base.replace(/\/+$/, '');
  }

  function filePath(fileName) {
    return 'library/audio/' + String(fileName || '').split(/[\\/]/).pop();
  }

  async function ensureDirectories() {
    if (!filesystem || typeof filesystem.mkdir !== 'function') {
      throw new Error('Android file storage cannot create its private library directories.');
    }
    var directories = ['library', 'library/audio', 'library/cover', 'library/lyrics'];
    for (var index = 0; index < directories.length; index += 1) {
      try {
        await filesystem.mkdir({ path: directories[index], directory: DATA, recursive: true });
      } catch (error) {
        try {
          var info = await filesystem.stat({ path: directories[index], directory: DATA });
          if (!info || info.type !== 'directory') throw error;
        } catch (statError) {
          throw error;
        }
      }
    }
  }

  async function readText(path) {
    if (!filesystem) return null;
    try {
      var result = await filesystem.readFile({ path: path, directory: DATA, encoding: 'utf8' });
      return typeof result.data === 'string' ? result.data : null;
    } catch (error) {
      return null;
    }
  }

  async function readPlaylist() {
    await ensureDirectories();
    var text = await readText(PLAYLIST_PATH);
    if (!text) return null;
    try {
      var payload = JSON.parse(text);
      return Array.isArray(payload) ? payload : (Array.isArray(payload.tracks) ? payload.tracks : null);
    } catch (error) {
      return null;
    }
  }

  async function writePlaylist(tracks) {
    if (!filesystem) return false;
    try {
      await ensureDirectories();
      await filesystem.writeFile({
        path: PLAYLIST_PATH,
        directory: DATA,
        encoding: 'utf8',
        data: JSON.stringify({
          version: 2,
          generatedAt: new Date().toISOString(),
          trackCount: tracks.length,
          tracks: tracks
        })
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  async function removeFile(path) {
    if (!filesystem) return;
    try {
      await filesystem.deleteFile({ path: path, directory: DATA });
    } catch (error) {
      /* Missing files are harmless during a reconcile. */
    }
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var value = String(reader.result || '');
        var comma = value.indexOf(',');
        resolve(comma === -1 ? value : value.slice(comma + 1));
      };
      reader.onerror = function () { reject(reader.error || new Error('could not read file')); };
      reader.readAsDataURL(file);
    });
  }

  function fileMetadata(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var audio = document.createElement('audio');
      var settled = false;
      function finish(duration) {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(duration);
      }
      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', function () {
        finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
      }, { once: true });
      audio.addEventListener('error', function () { finish(0); }, { once: true });
      audio.src = url;
      setTimeout(function () { finish(0); }, 5000);
    });
  }

  function titleFromName(name) {
    var base = String(name || '').replace(/\.[^.\\/]+$/, '').replace(/_/g, ' ').trim();
    var parts = base.split(' - ');
    if (parts.length > 1) {
      return { artist: parts.shift().trim() || 'Unknown artist', title: parts.join(' - ').trim() || base };
    }
    return { artist: 'Unknown artist', title: base || 'Untitled' };
  }

  function uniqueFileName(name, existing, current) {
    var original = String(name || '').split(/[\\/]/).pop() || 'track';
    var dot = original.lastIndexOf('.');
    var stem = dot > 0 ? original.slice(0, dot) : original;
    var extension = dot > 0 ? original.slice(dot) : '';
    var candidate = original;
    var suffix = 2;
    function used(value) {
      var lower = value.toLowerCase();
      return existing.some(function (item) {
        return String(item.fileName || '').toLowerCase() === lower;
      }) || current.some(function (item) {
        return String(item.fileName || '').toLowerCase() === lower;
      });
    }
    while (used(candidate)) {
      candidate = stem + ' (' + suffix + ')' + extension;
      suffix += 1;
    }
    return candidate;
  }

  async function importFiles(files) {
    if (!filesystem) throw new Error('Android file storage is unavailable in this build.');
    await ensureDirectories();
    var existing = (await readPlaylist()) || [];
    var added = [];
    var pending = [];
    var skipped = 0;
    for (var index = 0; index < files.length; index += 1) {
      var file = files[index];
      if (!file || !file.name) continue;
      if (Number(file.size) > MAX_IMPORT_BYTES) {
        throw new Error(file.name + ' is too large (maximum 512 MiB).');
      }
      var extension = String(file.name).split('.').pop().toLowerCase();
      if (['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'webm'].indexOf(extension) === -1) {
        continue;
      }
      var duration = await fileMetadata(file);
      var duplicate = existing.some(function (item) {
        return String(item.fileName || '').toLowerCase() === file.name.toLowerCase() &&
          Math.abs(Number(item.duration || 0) - duration) < 1;
      });
      if (duplicate) {
        skipped += 1;
        continue;
      }
      var info = titleFromName(file.name);
      var targetName = uniqueFileName(file.name, existing, pending);
      var target = filePath(targetName);
      var temp = 'library/.import-' + Date.now() + '-' + index + '-' + targetName.replace(/[^a-zA-Z0-9._-]/g, '_');
      var data = await fileToBase64(file);
      await filesystem.writeFile({ path: temp, directory: DATA, data: data });
      try {
        await filesystem.rename({ from: temp, to: target, directory: DATA });
      } catch (error) {
        await removeFile(temp);
        throw error;
      }
      added.push({
        title: info.title,
        artist: info.artist,
        fileName: targetName,
        path: target,
        storagePath: target,
        duration: duration,
        deviceOnly: true
      });
      pending.push(added[added.length - 1]);
    }
    if (added.length && !(await writePlaylist(existing.concat(added)))) {
      throw new Error('could not save the device library index');
    }
    return { added: added, skipped: skipped };
  }

  async function request(url, options) {
    var opts = options || {};
    if (http && typeof http.request === 'function') {
      var response = await http.request({
        url: url,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        data: opts.data,
        responseType: opts.responseType || 'text',
        connectTimeout: 15000,
        readTimeout: 120000
      });
      if (response && Number(response.status) >= 400) {
        throw new Error('desktop returned HTTP ' + response.status);
      }
      return response ? response.data : null;
    }
    var fetchResponse = await fetch(url, opts);
    if (!fetchResponse.ok) throw new Error('desktop returned HTTP ' + fetchResponse.status);
    return opts.responseType === 'arraybuffer' ? fetchResponse.arrayBuffer() : fetchResponse.text();
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunk = 0x8000;
    var binary = '';
    for (var index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(index + chunk, bytes.length)));
    }
    return btoa(binary);
  }

  async function syncFromDesktop(address, code, onProgress) {
    if (!filesystem) throw new Error('Android file storage is unavailable in this build.');
    var base = normalizeBase(address);
    var pair = await request(base + '/api/sync/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(code || '').trim() }),
      data: { code: String(code || '').trim() }
    });
    if (typeof pair === 'string') pair = JSON.parse(pair);
    if (!pair || !pair.token) throw new Error('pairing code was refused or has expired');

    var manifestRaw = await request(base + '/api/sync/manifest?token=' + encodeURIComponent(pair.token));
    var manifest = typeof manifestRaw === 'string' ? JSON.parse(manifestRaw) : manifestRaw;
    if (!manifest || !Array.isArray(manifest.tracks)) throw new Error('desktop returned an invalid library manifest');

    var current = (await readPlaylist()) || [];
    var synced = [];
    var transferred = 0;
    for (var index = 0; index < manifest.tracks.length; index += 1) {
      var track = manifest.tracks[index];
      var old = current.find(function (item) { return item.syncKey === track.syncKey; });
      var sourceFileName = String(track.fileName || '').split(/[\\/]/).pop();
      if (!sourceFileName) continue;
      var localName = old && old.fileName
        ? String(old.fileName).split(/[\\/]/).pop()
        : uniqueFileName(sourceFileName, current.filter(function (item) {
          return item && item.deviceOnly;
        }), synced);
      var path = filePath(localName);
      var unchanged = old && Number(old.sizeBytes || 0) === Number(track.sizeBytes || 0) &&
        Number(old.modifiedAt || 0) === Number(track.modifiedAt || 0);
      if (!unchanged) {
        var url = base + '/api/sync/audio/' + encodeURIComponent(sourceFileName) + '?token=' + encodeURIComponent(pair.token);
        var raw = await request(url, { responseType: 'arraybuffer' });
        var base64 = typeof raw === 'string' ? raw : arrayBufferToBase64(raw);
        var temp = 'library/.sync-' + Date.now() + '-' + index + '.part';
        await filesystem.writeFile({ path: temp, directory: DATA, data: base64 });
        try {
          await filesystem.rename({ from: temp, to: path, directory: DATA });
        } catch (error) {
          await removeFile(temp);
          throw error;
        }
        transferred += Number(track.sizeBytes || 0);
      }
      for (var assetIndex = 0; assetIndex < 2; assetIndex += 1) {
        var assetField = assetIndex === 0 ? 'cover' : 'lyrics';
        var assetValue = String(track[assetField] || '');
        if (!assetValue) continue;
        var assetName = assetValue.split(/[\\/]/).pop();
        if (!assetName) continue;
        var assetPath = 'library/' + assetField + '/' + assetName;
        var oldAsset = old && old[assetField] === assetValue;
        if (!oldAsset) {
          var assetUrl = base + '/api/sync/asset/' + assetField + '/' + encodeURIComponent(assetName) +
            '?token=' + encodeURIComponent(pair.token);
          var assetRaw = await request(assetUrl, { responseType: 'arraybuffer' });
          var assetBase64 = typeof assetRaw === 'string' ? assetRaw : arrayBufferToBase64(assetRaw);
          var assetTemp = 'library/.' + assetField + '-' + Date.now() + '-' + index + '.part';
          await filesystem.writeFile({ path: assetTemp, directory: DATA, data: assetBase64 });
          try {
            await filesystem.rename({ from: assetTemp, to: assetPath, directory: DATA });
          } catch (error) {
            await removeFile(assetTemp);
            throw error;
          }
        }
        track[assetField] = assetField + '/' + assetName;
      }
      synced.push(Object.assign({}, track, {
        fileName: localName,
        path: path,
        storagePath: path,
        syncKey: track.syncKey
      }));
      if (typeof onProgress === 'function') onProgress(index + 1, manifest.tracks.length, transferred);
    }

    var deviceOnly = current.filter(function (item) {
      return item && item.deviceOnly && !synced.some(function (track) { return track.fileName === item.fileName; });
    });
    if (!(await writePlaylist(synced.concat(deviceOnly)))) {
      throw new Error('could not save the synced library index');
    }
    return { tracks: synced, transferred: transferred, count: synced.length };
  }

  function fileUrl(track) {
    if (!track || !track.storagePath || !filesystem) return null;
    if (capacitor && typeof capacitor.convertFileSrc === 'function') {
      return filesystem.getUri({ path: track.storagePath, directory: DATA }).then(function (result) {
        return capacitor.convertFileSrc(result.uri || result.path || '');
      });
    }
    return null;
  }

  async function storageInfo() {
    if (!filesystem || typeof filesystem.readdir !== 'function') return null;
    var total = 0;
    var pending = ['library'];
    try {
      while (pending.length) {
        var path = pending.pop();
        var result = await filesystem.readdir({ path: path, directory: DATA });
        var entries = Array.isArray(result.files) ? result.files : [];
        for (var index = 0; index < entries.length; index += 1) {
          var entry = entries[index];
          var child = path + '/' + entry.name;
          if (entry.type === 'directory') pending.push(child);
          else if (Number.isFinite(Number(entry.size))) total += Number(entry.size);
          else {
            try {
              var stat = await filesystem.stat({ path: child, directory: DATA });
              total += Number(stat.size) || 0;
            } catch (error) {
              /* A file removed during the read is not a storage error. */
            }
          }
        }
      }
      return { size: total };
    } catch (error) {
      return null;
    }
  }

  global.LocalMusicMobile = {
    available: isAvailable,
    readPlaylist: readPlaylist,
    writePlaylist: writePlaylist,
    importFiles: importFiles,
    syncFromDesktop: syncFromDesktop,
    fileUrl: fileUrl,
    storageInfo: storageInfo,
    filePath: filePath
  };
})(window);
