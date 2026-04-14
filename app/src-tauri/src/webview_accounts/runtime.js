// OpenHuman webview-accounts recipe runtime.
// Injected via WebviewBuilder.initialization_script BEFORE page JS runs.
// Exposes a small `window.__openhumanRecipe` API that per-provider recipes
// use to scrape DOM state and ship it back to the Rust shell.
//
// Runs in the loaded service's origin (e.g. https://web.whatsapp.com).
// IPC back to Rust uses Tauri's `window.__TAURI_INTERNALS__.invoke`,
// which Tauri auto-injects into every webview it controls (including
// child webviews on external origins).
(function () {
  if (window.__openhumanRecipe) return;

  const ctx = window.__OPENHUMAN_RECIPE_CTX__ || { accountId: 'unknown', provider: 'unknown' };
  const POLL_MS = 2000;

  function rawInvoke(cmd, payload) {
    try {
      const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (typeof inv !== 'function') return Promise.resolve();
      return inv(cmd, payload || {});
    } catch (e) {
      // swallow — never let a bad invoke break the host page
      return Promise.resolve();
    }
  }

  function send(kind, payload) {
    return rawInvoke('webview_recipe_event', {
      accountId: ctx.accountId,
      provider: ctx.provider,
      kind: kind,
      payload: payload || {},
      ts: Date.now(),
    });
  }

  let loopFn = null;
  let pollTimer = null;
  let notifyHandler = null;

  function safeRunLoop() {
    if (!loopFn) return;
    try {
      loopFn(api);
    } catch (e) {
      send('log', { level: 'warn', msg: '[recipe] loop threw: ' + (e && e.message ? e.message : String(e)) });
    }
  }

  // Patch Notification so onNotify(fn) recipes can intercept browser notifications
  // (Franz pattern — many services use the Notification API for new-message pings).
  try {
    const NativeNotification = window.Notification;
    if (NativeNotification && !NativeNotification.__openhumanPatched) {
      function PatchedNotification(title, options) {
        try {
          if (notifyHandler) {
            notifyHandler({ title: title, options: options || {} });
          }
          send('notify', { title: title, options: options || {} });
        } catch (_) {}
        return new NativeNotification(title, options);
      }
      PatchedNotification.prototype = NativeNotification.prototype;
      PatchedNotification.permission = NativeNotification.permission;
      PatchedNotification.requestPermission = NativeNotification.requestPermission.bind(NativeNotification);
      PatchedNotification.__openhumanPatched = true;
      window.Notification = PatchedNotification;
    }
  } catch (_) {
    // Notification API not available — fine
  }

  const api = {
    loop(fn) {
      loopFn = fn;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(safeRunLoop, POLL_MS);
      // also kick once on next tick so we don't wait POLL_MS for the first call
      setTimeout(safeRunLoop, 250);
      send('log', { level: 'info', msg: '[recipe] loop registered, polling every ' + POLL_MS + 'ms' });
    },
    ingest(payload) {
      // payload: { messages: Array<{id?, from?, body, ts?}>, unread?, snapshotKey? }
      send('ingest', payload || {});
    },
    log(level, msg) {
      send('log', { level: level || 'info', msg: String(msg) });
    },
    onNotify(fn) {
      notifyHandler = fn;
    },
    context() {
      return Object.assign({}, ctx);
    },
  };

  window.__openhumanRecipe = api;
  send('log', { level: 'info', msg: '[recipe-runtime] ready provider=' + ctx.provider + ' accountId=' + ctx.accountId });
})();
