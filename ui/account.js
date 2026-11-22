/* Local Music — account sync client.
 *
 * Carries likes, play counts and playlists between the desktop app and the
 * Android app through the sync service. Audio is never uploaded: each device
 * keeps its own files and matches them by the importer's syncKey.
 *
 * Desktop: all requests go through the Electron main process, which holds the
 * device token (see desktop/account.js). Android: Capacitor HTTP does the same
 * from app-private storage.
 *
 * Syncing is a single push: the service merges the snapshot and answers with
 * the merged account state, which is applied back here.
 */

(function (global) {
  'use strict';

  var desktop = global.localMusic && global.localMusic.account ? global.localMusic.account : null;
  var mobile = global.LocalMusicMobile && global.LocalMusicMobile.available() ? global.LocalMusicMobile : null;

  var transport = desktop
    ? {
        status: function () { return desktop.status(); },
        start: function () { return desktop.start(); },
        poll: function (deviceCode) { return desktop.poll(deviceCode); },
        sync: function (snapshot) { return desktop.sync(snapshot); },
        signOut: function () { return desktop.signOut(); }
      }
    : mobile
      ? {
          status: function () { return mobile.accountStatus(); },
          start: function () { return mobile.accountStart(); },
          poll: function (deviceCode) { return mobile.accountPoll(deviceCode); },
          sync: function (snapshot) { return mobile.accountSync(snapshot); },
          signOut: function () { return mobile.accountSignOut(); }
        }
      : null;

  var session = { signedIn: false, name: '', lastSyncAt: 0 };
  var busy = false;
  var error = '';
  var pendingCode = null;
  var pollTimer = null;
  var pushTimer = null;
  var listeners = [];

  function status() {
    return {
      available: Boolean(transport),
      signedIn: session.signedIn,
      name: session.name,
      lastSyncAt: session.lastSyncAt,
      busy: busy,
      error: error,
      pendingCode: pendingCode,
      missing: typeof accountMissingCount === 'function' ? accountMissingCount() : 0
    };
  }

  function emit() {
    var snapshot = status();
    listeners.forEach(function (listener) {
      try { listener(snapshot); } catch (listenerError) { /* a bad render must not break sync */ }
    });
    return snapshot;
  }

  function onChange(callback) {
    if (typeof callback === 'function') listeners.push(callback);
  }

  function applyStatus(value) {
    if (!value) return;
    session = {
      signedIn: value.signedIn === true,
      name: typeof value.name === 'string' ? value.name : '',
      lastSyncAt: Number(value.lastSyncAt) || 0
    };
  }

  function refresh() {
    if (!transport) return Promise.resolve(emit());
    return Promise.resolve(transport.status())
      .then(function (value) { applyStatus(value); return emit(); })
      .catch(function (statusError) { error = statusError.message; return emit(); });
  }

  function pushLocal() {
    if (!transport || !session.signedIn) return Promise.resolve(false);
    return Promise.resolve(transport.sync(accountSnapshot())).then(function (result) {
      if (!result || !result.ok) throw new Error((result && result.error) || 'could not save to the account');
      applyStatus(result.account);
      applyAccountState(result.state);
      return true;
    });
  }

  function syncNow() {
    if (!transport || !session.signedIn || busy) return Promise.resolve(emit());
    busy = true;
    error = '';
    emit();
    return pushLocal()
      .catch(function (syncError) { error = syncError.message; })
      .then(function () {
        busy = false;
        if (window.updateStorageReadout) window.updateStorageReadout();
        return emit();
      });
  }

  /** Debounce a push after a local like, play count or playlist edit. */
  function noteLocalChange() {
    if (!transport || !session.signedIn) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      pushLocal().then(function () { return emit(); }).catch(function (pushError) {
        error = pushError.message;
        emit();
      });
    }, 4000);
  }

  function waitForApproval(started) {
    var interval = Math.max(1, Number(started.interval) || 3) * 1000;
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + (Number(started.expiresIn) || 600) * 1000;
      function tick() {
        pollTimer = null;
        if (Date.now() > deadline) {
          reject(new Error('the sign-in code expired, start again'));
          return;
        }
        Promise.resolve(transport.poll(started.deviceCode)).then(function (result) {
          if (!result || !result.ok) {
            reject(new Error((result && result.error) || 'sign-in failed'));
            return;
          }
          if (result.pending) pollTimer = setTimeout(tick, interval);
          else resolve(result);
        }).catch(reject);
      }
      pollTimer = setTimeout(tick, interval);
    });
  }

  function signIn() {
    if (!transport || busy) return Promise.resolve(emit());
    busy = true;
    error = '';
    emit();
    return Promise.resolve(transport.start())
      .then(function (started) {
        if (!started || !started.ok) throw new Error((started && started.error) || 'could not start sign-in');
        pendingCode = { code: started.code, url: started.verificationUrl };
        emit();
        return waitForApproval(started);
      })
      .then(function (result) { applyStatus(result.account); })
      .catch(function (signInError) { error = signInError.message; })
      .then(function () {
        pendingCode = null;
        busy = false;
        emit();
        // The first sync has to run after `busy` is cleared, or it is skipped.
        return session.signedIn ? syncNow() : emit();
      });
  }

  function signOut() {
    if (!transport) return Promise.resolve(emit());
    busy = true;
    emit();
    return Promise.resolve(transport.signOut())
      .then(function () { error = ''; return refresh(); })
      .catch(function (signOutError) { error = signOutError.message; })
      .then(function () { busy = false; return emit(); });
  }

  function start() {
    if (!transport) return Promise.resolve(emit());
    return refresh().then(function (current) {
      if (!current.signedIn) return current;
      return syncNow();
    });
  }

  global.LocalMusicAccount = {
    available: function () { return Boolean(transport); },
    status: status,
    onChange: onChange,
    refresh: refresh,
    signIn: signIn,
    signOut: signOut,
    syncNow: syncNow,
    noteLocalChange: noteLocalChange,
    start: start
  };
})(window);
