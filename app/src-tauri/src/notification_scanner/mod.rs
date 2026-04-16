//! Browser-notification MITM for embedded webview accounts, driven over
//! the Chrome DevTools Protocol.
//!
//! Why CDP and not JS injection? Patching `window.Notification` from
//! Tauri's `initialization_script` leaked "tauri internals" (the
//! `__TAURI_INTERNALS__.invoke` bridge) into every page we loaded and
//! the patch was in user-editable territory. Here, a CEF-managed
//! `Runtime.addBinding` exposes a native function that the page calls as
//! `window.__openhumanNotify(JSON)`; CDP delivers the argument back to us
//! as a `Runtime.bindingCalled` event. No Tauri IPC is touched.
//!
//! One persistent task per tracked account that:
//!
//!   1. Discovers the page target matching `url_prefix`
//!   2. Attaches with `flatten: true`, enables `Page.*` and `Runtime.*`
//!   3. Registers a binding named `__openhumanNotify`
//!   4. Installs a page-scoped patch via `Page.addScriptToEvaluateOnNewDocument`
//!      that swaps `window.Notification` (and
//!      `ServiceWorkerRegistration.prototype.showNotification` for
//!      page-initiated calls) with a thin wrapper that calls the binding
//!   5. Streams `Runtime.bindingCalled` events, decodes the JSON payload,
//!      and fires a native OS notification via `tauri-plugin-notification`
//!
//! Page reloads are handled by the outer reconnect loop in
//! [`spawn_scanner`]. `Page.addScriptToEvaluateOnNewDocument` persists
//! across navigations for the life of the CDP session, but reloads also
//! tend to invalidate target ids, so the simplest thing is to re-attach.
//!
//! NOTE: only built with the `cef` feature — wry has no remote-debugging
//! port and never gets compiled in.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{oneshot, Mutex};
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::webview_accounts::provider_display_name;

const CDP_HOST: &str = "127.0.0.1";
const CDP_PORT: u16 = 9222;

/// Backoff between reconnect attempts when the CDP WebSocket drops or the
/// target disappears (page reload, navigation to a different origin, …).
const RECONNECT_BACKOFF: Duration = Duration::from_secs(3);

/// How long to wait for the CEF page target to materialise on a freshly
/// opened webview. Cold-start on slow machines (or when the user picks a
/// provider that redirects through OAuth) can stretch past a couple
/// seconds, so give it room.
const TARGET_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);
const TARGET_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Binding name the injected patch calls when a Notification fires. Keep
/// in sync with `PATCH_SOURCE` below.
const BINDING_NAME: &str = "__openhumanNotify";

/// Page-scope JavaScript installed via
/// `Page.addScriptToEvaluateOnNewDocument`. Runs on every new document
/// (main frame + same-origin subframes) before page scripts. Replaces
/// `window.Notification` and `ServiceWorkerRegistration.prototype.showNotification`
/// with wrappers that forward through the `__openhumanNotify` binding.
///
/// The wrappers still invoke the native constructors so the page's own
/// `onclick` handlers and permission state behave normally. We report
/// `permission === 'granted'` so pages that gate on it don't silently
/// drop the call.
const PATCH_SOURCE: &str = r#"
(function () {
  if (window.__openhumanNotifyPatched) return;
  window.__openhumanNotifyPatched = true;

  function pick(o, k) { return o && typeof o[k] === 'string' ? o[k] : null; }

  function forward(source, title, options) {
    try {
      var fn = window.__openhumanNotify;
      if (typeof fn !== 'function') return;
      var payload = {
        source: source,
        title: title == null ? '' : String(title),
        body: pick(options, 'body'),
        icon: pick(options, 'icon'),
        tag: pick(options, 'tag'),
        silent: options && options.silent === true,
      };
      fn(JSON.stringify(payload));
    } catch (_) {}
  }

  try {
    var Native = window.Notification;
    if (Native && !Native.__openhumanPatched) {
      function Patched(title, options) {
        forward('window', title, options);
        return new Native(title, options);
      }
      Patched.prototype = Native.prototype;
      try {
        Object.defineProperty(Patched, 'permission', {
          get: function () { return 'granted'; },
        });
      } catch (_) { Patched.permission = 'granted'; }
      Patched.requestPermission = function (cb) {
        try { if (typeof cb === 'function') cb('granted'); } catch (_) {}
        return Promise.resolve('granted');
      };
      Patched.__openhumanPatched = true;
      window.Notification = Patched;
    }
  } catch (_) {}

  try {
    var swProto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
    if (swProto && !swProto.__openhumanPatched) {
      var nativeShow = swProto.showNotification;
      if (typeof nativeShow === 'function') {
        swProto.showNotification = function (title, options) {
          forward('sw', title, options);
          try { return nativeShow.call(this, title, options); }
          catch (e) { return Promise.reject(e); }
        };
        swProto.__openhumanPatched = true;
      }
    }
  } catch (_) {}
})();
"#;

/// CDP target descriptor (subset of `Target.TargetInfo`).
#[derive(Debug, Clone)]
struct CdpTarget {
    id: String,
    kind: String,
    url: String,
}

/// Spawn the per-account notification MITM task. Idempotent at the call
/// site — callers guard double-spawn via [`ScannerRegistry::ensure_scanner`].
pub fn spawn_scanner<R: Runtime>(
    app: AppHandle<R>,
    account_id: String,
    provider: String,
    url_prefix: String,
) {
    tokio::spawn(async move {
        log::info!(
            "[notify-scanner][{}] starting provider={} url_prefix={} cdp={}:{}",
            account_id,
            provider,
            url_prefix,
            CDP_HOST,
            CDP_PORT
        );
        // Give CEF a moment to spin up the new webview's renderer before
        // we start polling for its target. Too eager and `Target.getTargets`
        // either misses the entry or returns the still-blank about:blank.
        sleep(Duration::from_secs(2)).await;
        loop {
            match run_session(&app, &account_id, &provider, &url_prefix).await {
                Ok(()) => {
                    log::info!(
                        "[notify-scanner][{}] session ended cleanly, reconnecting",
                        account_id
                    );
                }
                Err(e) => {
                    log::warn!(
                        "[notify-scanner][{}] session failed: {} — reconnecting in {:?}",
                        account_id,
                        e,
                        RECONNECT_BACKOFF
                    );
                }
            }
            sleep(RECONNECT_BACKOFF).await;
        }
    });
}

/// Run one CDP attach → setup → stream-events lifecycle. Returns when the
/// underlying WebSocket closes or the page target disappears. Caller loops.
async fn run_session<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
    provider: &str,
    url_prefix: &str,
) -> Result<(), String> {
    let browser_ws = browser_ws_url().await?;
    let mut cdp = CdpConn::open(&browser_ws).await?;

    // Discovery can race with a cold renderer — poll briefly instead of
    // assuming the page target is already registered.
    let page = discover_page_target(&mut cdp, url_prefix, account_id).await?;
    log::info!(
        "[notify-scanner][{}] attaching target_id={} url={}",
        account_id,
        page.id,
        page.url
    );

    let attach = cdp
        .call(
            "Target.attachToTarget",
            json!({ "targetId": page.id, "flatten": true }),
            None,
        )
        .await?;
    let session_id = attach
        .get("sessionId")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "attach missing sessionId".to_string())?
        .to_string();

    // Runtime needs to be enabled before `addBinding` — the binding is
    // scoped to the session and only propagates to live contexts once
    // Runtime is engaged. Page is enabled so `addScriptToEvaluateOnNewDocument`
    // fires on subsequent navigations.
    cdp.call("Runtime.enable", json!({}), Some(&session_id))
        .await?;
    cdp.call("Page.enable", json!({}), Some(&session_id))
        .await?;
    cdp.call(
        "Runtime.addBinding",
        json!({ "name": BINDING_NAME }),
        Some(&session_id),
    )
    .await?;
    cdp.call(
        "Page.addScriptToEvaluateOnNewDocument",
        json!({ "source": PATCH_SOURCE }),
        Some(&session_id),
    )
    .await?;

    // Also poke the patch into the *current* document. Without this the
    // first pageview after attach misses interception because
    // addScriptToEvaluateOnNewDocument only applies to subsequent navigations.
    let _ = cdp
        .call(
            "Runtime.evaluate",
            json!({
                "expression": PATCH_SOURCE,
                "awaitPromise": false,
                "returnByValue": true,
            }),
            Some(&session_id),
        )
        .await;

    log::info!(
        "[notify-scanner][{}] patch installed, streaming binding events",
        account_id
    );

    cdp.pump_events(app, account_id, provider, &session_id)
        .await
}

async fn discover_page_target(
    cdp: &mut CdpConn,
    url_prefix: &str,
    account_id: &str,
) -> Result<CdpTarget, String> {
    let deadline = std::time::Instant::now() + TARGET_DISCOVERY_TIMEOUT;
    loop {
        let targets_v = cdp.call("Target.getTargets", json!({}), None).await?;
        let targets = parse_targets(&targets_v);
        if let Some(page) = targets
            .into_iter()
            .find(|t| t.kind == "page" && t.url.starts_with(url_prefix))
        {
            return Ok(page);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "no page target matching {} within {:?}",
                url_prefix, TARGET_DISCOVERY_TIMEOUT
            ));
        }
        log::debug!(
            "[notify-scanner][{}] target not ready yet, retrying",
            account_id
        );
        sleep(TARGET_POLL_INTERVAL).await;
    }
}

fn parse_targets(v: &Value) -> Vec<CdpTarget> {
    v.get("targetInfos")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    Some(CdpTarget {
                        id: t.get("targetId")?.as_str()?.to_string(),
                        kind: t.get("type")?.as_str()?.to_string(),
                        url: t.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn browser_ws_url() -> Result<String, String> {
    let url = format!("http://{CDP_HOST}:{CDP_PORT}/json/version");
    let resp = reqwest::Client::builder()
        .user_agent("openhuman-cdp/1.0")
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let v: Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    v.get("webSocketDebuggerUrl")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no webSocketDebuggerUrl in /json/version".to_string())
}

// ---------- CDP connection ----------------------------------------------------

/// Minimal CDP client — shape mirrors `discord_scanner::CdpConn`. Setup
/// calls go through `call`, then `pump_events` takes over the read stream
/// for the duration of the session.
struct CdpConn {
    sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    stream: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    next_id: i64,
    pending: HashMap<i64, oneshot::Sender<Result<Value, String>>>,
}

impl CdpConn {
    async fn open(ws_url: &str) -> Result<Self, String> {
        let (ws, _resp) = connect_async(ws_url)
            .await
            .map_err(|e| format!("ws connect: {e}"))?;
        let (sink, stream) = ws.split();
        Ok(Self {
            sink,
            stream,
            next_id: 1,
            pending: HashMap::new(),
        })
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut req = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session_id {
            req["sessionId"] = json!(s);
        }
        let body = serde_json::to_string(&req).map_err(|e| format!("encode: {e}"))?;
        self.sink
            .send(Message::Text(body))
            .await
            .map_err(|e| format!("ws send: {e}"))?;
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(15), self.stream.next())
                .await
                .map_err(|_| format!("ws read timeout (method={method})"))?
                .ok_or_else(|| format!("ws closed (method={method})"))?
                .map_err(|e| format!("ws recv: {e}"))?;
            let text = match msg {
                Message::Text(t) => t,
                Message::Binary(_)
                | Message::Ping(_)
                | Message::Pong(_)
                | Message::Frame(_) => continue,
                Message::Close(_) => return Err("ws closed".into()),
            };
            let v: Value = serde_json::from_str(&text).map_err(|e| format!("decode: {e}"))?;
            if v.get("id").and_then(|x| x.as_i64()) != Some(id) {
                // Inbound CDP event during setup — drop silently; no one's
                // listening yet and the binding isn't installed.
                continue;
            }
            if let Some(err) = v.get("error") {
                return Err(format!("cdp error ({method}): {err}"));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn pump_events<R: Runtime>(
        &mut self,
        app: &AppHandle<R>,
        account_id: &str,
        provider: &str,
        session_id: &str,
    ) -> Result<(), String> {
        log::info!("[notify-scanner][{}] event pump started", account_id);
        loop {
            let msg = self
                .stream
                .next()
                .await
                .ok_or_else(|| "ws closed".to_string())?
                .map_err(|e| format!("ws recv: {e}"))?;
            let text = match msg {
                Message::Text(t) => t,
                Message::Binary(_)
                | Message::Ping(_)
                | Message::Pong(_)
                | Message::Frame(_) => continue,
                Message::Close(_) => {
                    log::info!("[notify-scanner][{}] cdp ws closed", account_id);
                    return Ok(());
                }
            };
            let v: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("[notify-scanner][{}] decode failed: {}", account_id, e);
                    continue;
                }
            };
            if let Some(id) = v.get("id").and_then(|x| x.as_i64()) {
                if let Some(tx) = self.pending.remove(&id) {
                    let res = if let Some(err) = v.get("error") {
                        Err(format!("cdp error: {err}"))
                    } else {
                        Ok(v.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(res);
                }
                continue;
            }
            // Only handle events for our attached session.
            let evt_session = v.get("sessionId").and_then(|x| x.as_str()).unwrap_or("");
            if !evt_session.is_empty() && evt_session != session_id {
                continue;
            }
            let method = v.get("method").and_then(|x| x.as_str()).unwrap_or("");
            if method != "Runtime.bindingCalled" {
                continue;
            }
            let params = v.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|x| x.as_str()).unwrap_or("");
            if name != BINDING_NAME {
                continue;
            }
            let payload_str = params
                .get("payload")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            handle_notify(app, account_id, provider, payload_str);
        }
    }
}

// ---------- OS notification dispatch -----------------------------------------

fn handle_notify<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
    provider: &str,
    payload_str: &str,
) {
    let payload: Value = match serde_json::from_str(payload_str) {
        Ok(v) => v,
        Err(e) => {
            log::warn!(
                "[notify-scanner][{}] bad payload: {} (raw_len={})",
                account_id,
                e,
                payload_str.len()
            );
            return;
        }
    };
    let raw_title = payload.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let body = payload.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let source = payload
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("window");
    let tag = payload.get("tag").and_then(|v| v.as_str()).unwrap_or("");
    let provider_label = provider_display_name(provider);
    let notify_title = if raw_title.is_empty() {
        provider_label.to_string()
    } else {
        format!("{} — {}", provider_label, raw_title)
    };
    log::info!(
        "[notify-scanner][{}] notify source={} tag={:?} title={:?} body_chars={}",
        account_id,
        source,
        tag,
        raw_title,
        body.chars().count()
    );
    let mut builder = app.notification().builder().title(&notify_title);
    if !body.is_empty() {
        builder = builder.body(body);
    }
    if let Err(e) = builder.show() {
        log::warn!(
            "[notify-scanner][{}] notification show failed: {}",
            account_id,
            e
        );
    }
}

// ---------- Registry ---------------------------------------------------------

/// Tracks which accounts already have a scanner task running so the
/// webview open lifecycle can call `ensure_scanner` repeatedly without
/// double-spawning. Same shape as the other scanner registries so the
/// `webview_accounts` wiring stays uniform.
#[derive(Default)]
pub struct ScannerRegistry {
    started: Mutex<std::collections::HashSet<String>>,
}

impl ScannerRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub async fn ensure_scanner<R: Runtime>(
        self: &Arc<Self>,
        app: AppHandle<R>,
        account_id: String,
        provider: String,
        url_prefix: String,
    ) {
        let mut g = self.started.lock().await;
        if !g.insert(account_id.clone()) {
            log::debug!(
                "[notify-scanner] already running for account={}",
                account_id
            );
            return;
        }
        spawn_scanner(app, account_id, provider, url_prefix);
    }

    pub async fn forget(&self, account_id: &str) {
        let mut g = self.started.lock().await;
        g.remove(account_id);
    }
}
