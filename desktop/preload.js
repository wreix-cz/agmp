'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const BASE_FLAG = '--local-music-base=';
const baseArgument = process.argv.find(function (arg) {
  return arg.startsWith(BASE_FLAG);
});

contextBridge.exposeInMainWorld('localMusic', {
  platform: 'desktop',
  libraryBaseUrl: baseArgument ? baseArgument.slice(BASE_FLAG.length) : '',
  startImport: function (link) {
    return ipcRenderer.invoke('import:start', typeof link === 'string' ? link : '');
  },
  retryFailed: function () {
    return ipcRenderer.invoke('import:retry-failed');
  },
  cancelImport: function () {
    return ipcRenderer.invoke('import:cancel');
  },
  openLibraryFolder: function () {
    return ipcRenderer.invoke('library:open');
  },
  fetchRecommendations: function (limit) {
    return ipcRenderer.invoke('recommend:fetch', Number(limit) || 12);
  },
  deleteTrack: function (key) {
    return ipcRenderer.invoke('library:delete', typeof key === 'string' ? key : '');
  },
  attachLyrics: function (key, content) {
    return ipcRenderer.invoke(
      'library:attach-lyrics',
      typeof key === 'string' ? key : '',
      typeof content === 'string' ? content : ''
    );
  },
  getStorageInfo: function () {
    return ipcRenderer.invoke('library:storage-info');
  },
  getSyncInfo: function () {
    return ipcRenderer.invoke('sync:info');
  },
  account: {
    status: function () { return ipcRenderer.invoke('account:status'); },
    start: function () { return ipcRenderer.invoke('account:start'); },
    poll: function (deviceCode) { return ipcRenderer.invoke('account:poll', String(deviceCode || '')); },
    sync: function (snapshot) { return ipcRenderer.invoke('account:sync', snapshot || {}); },
    signOut: function () { return ipcRenderer.invoke('account:signout'); }
  },
  onImportEvent: function (callback) {
    function listener(event, payload) {
      callback(payload);
    }
    ipcRenderer.on('import:event', listener);
    return function () {
      ipcRenderer.removeListener('import:event', listener);
    };
  },
  onMenuAction: function (callback) {
    function listener(event, action) {
      callback(action);
    }
    ipcRenderer.on('menu:action', listener);
    return function () {
      ipcRenderer.removeListener('menu:action', listener);
    };
  }
});
