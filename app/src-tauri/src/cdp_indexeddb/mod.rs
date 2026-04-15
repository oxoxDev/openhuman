//! IndexedDB scanner driven over the Chrome DevTools Protocol (CDP).
//!
//! We talk to the embedded CEF instance through its remote-debugging port
//! (set via `--remote-debugging-port=9222` in `lib.rs`). For each tracked
//! webview-account target, we periodically:
//!
//!   1. Discover the right CDP page target by URL prefix
//!      (`https://web.whatsapp.com/`).
//!   2. Open its DevTools WebSocket and send `Runtime.evaluate` with the
//!      bundled `scanner.js` payload.
//!   3. The script runs inside the page (so it has access to the
//!      non-extractable `CryptoKey` already resident there), reads
//!      IndexedDB, decrypts envelopes via `crypto.subtle.decrypt`, and
//!      returns a normalized snapshot as JSON.
//!   4. Rust forwards the snapshot to React via the existing
//!      `webview:event` Tauri event so the UI / persistence layer can
//!      consume it without a second pipeline.
//!
//! No DOM scrape, no Tauri-IPC-from-injected-JS, no CSP fight. We "own the
//! browser" through CDP.
//!
//! NOTE: this module is only meaningful with the `cef` feature — the wry
//! runtime does not expose a remote debugging port. We compile-gate the
//! task spawn at the call site.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Mutex;
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const CDP_HOST: &str = "127.0.0.1";
const CDP_PORT: u16 = 9222;
const SCAN_INTERVAL: Duration = Duration::from_secs(15);
/// Inline scan script, executed via `Runtime.evaluate` per tick.
const SCANNER_JS: &str = include_str!("scanner.js");

/// One CDP target descriptor as returned by `/json/list`.
#[derive(Debug, Clone, Deserialize)]
struct CdpTarget {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    url: String,
    #[serde(rename = "webSocketDebuggerUrl")]
    ws_url: Option<String>,
}

/// Snapshot returned by `scanner.js`. Mirrors the JS shape verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSnapshot {
    pub ok: bool,
    #[serde(rename = "scannedAt", default)]
    pub scanned_at: i64,
    #[serde(default)]
    pub dbs: Vec<String>,
    #[serde(default)]
    pub chats: serde_json::Map<String, Value>,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(rename = "hadKey", default)]
    pub had_key: bool,
    #[serde(default)]
    pub error: Option<String>,
    /// Up to N most-recent decrypted messages (body preview only) — useful
    /// to confirm decryption produced real text and not garbage. Each
    /// entry: { chatId, chatName, from, fromMe, timestamp, bodyPreview }.
    #[serde(rename = "sampleMessages", default)]
    pub sample_messages: Vec<Value>,
    /// Total CryptoKey objects discovered across all DBs/stores.
    #[serde(rename = "keyCount", default)]
    pub key_count: usize,
    /// Where each CryptoKey was found, in priority order.
    #[serde(rename = "keySources", default)]
    pub key_sources: Vec<String>,
    /// Top-level shape of the first raw message record (debug).
    #[serde(rename = "firstMessageShape", default)]
    pub first_message_shape: Option<Value>,
    /// Top-level shape of the first message *after* decryption (debug).
    #[serde(rename = "firstMessageDecrypted", default)]
    pub first_message_decrypted: Option<Value>,
    /// First-record shape per "interesting" store name (substring match on
    /// message/comment/mutation/history/info/orphan/note). Used to find
    /// whichever store actually carries the message body.
    #[serde(rename = "schemaDump", default)]
    pub schema_dump: serde_json::Map<String, Value>,
    /// OPFS listing — WhatsApp may persist bodies in a SQLite-via-WASM
    /// file in the Origin Private File System rather than IndexedDB.
    #[serde(default)]
    pub opfs: Option<Value>,
    /// Map of dbName → object store names. Logged once per scan so we can
    /// see WhatsApp's actual layout and tighten the store-name hints.
    #[serde(rename = "storeMap", default)]
    pub store_map: serde_json::Map<String, Value>,
}

/// Spawn a per-account CDP poller. Idempotent at call site (caller tracks
/// account → JoinHandle if it cares about cancellation).
pub fn spawn_scanner<R: Runtime>(app: AppHandle<R>, account_id: String, url_prefix: String) {
    tokio::spawn(async move {
        log::info!(
            "[cdp] scanner up account={} url_prefix={}",
            account_id,
            url_prefix
        );
        // Wait a moment for the page to actually load + log in. We'd rather
        // miss the first cycle than thrash the CDP endpoint while the
        // target isn't even there yet.
        sleep(Duration::from_secs(5)).await;
        loop {
            match scan_once(&app, &account_id, &url_prefix).await {
                Ok(snap) => {
                    log::info!(
                        "[cdp][{}] scan ok dbs={} messages={} chats={} keys={} sources={:?}",
                        account_id,
                        snap.dbs.len(),
                        snap.messages.len(),
                        snap.chats.len(),
                        snap.key_count,
                        snap.key_sources,
                    );
                    if let Some(ref shape) = snap.first_message_shape {
                        log::info!("[cdp][{}] first-msg-raw {}", account_id, shape);
                    }
                    if let Some(ref shape) = snap.first_message_decrypted {
                        log::info!("[cdp][{}] first-msg-dec {}", account_id, shape);
                    }
                    for (store, shape) in &snap.schema_dump {
                        log::info!("[cdp][{}] schema {} {}", account_id, store, shape);
                    }
                    if let Some(ref opfs) = snap.opfs {
                        log::info!("[cdp][{}] opfs {}", account_id, opfs);
                    }
                    for (i, sample) in snap.sample_messages.iter().enumerate() {
                        let chat_name = sample
                            .get("chatName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?");
                        let chat_id = sample
                            .get("chatId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?");
                        let from = if sample
                            .get("fromMe")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                        {
                            "me".to_string()
                        } else {
                            sample
                                .get("from")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?")
                                .to_string()
                        };
                        let ts = sample.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
                        let body = sample
                            .get("bodyPreview")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        log::info!(
                            "[cdp][{}] msg#{} ts={} chat={} ({}) from={} body={:?}",
                            account_id,
                            i + 1,
                            ts,
                            chat_name,
                            chat_id,
                            from,
                            body
                        );
                    }
                    if !snap.store_map.is_empty() {
                        // Compact one-liner so we can grep store layouts.
                        let layout = snap
                            .store_map
                            .iter()
                            .map(|(db, stores)| {
                                let names = stores
                                    .as_array()
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(|v| v.as_str())
                                            .collect::<Vec<_>>()
                                            .join(",")
                                    })
                                    .unwrap_or_default();
                                format!("{db}:[{names}]")
                            })
                            .collect::<Vec<_>>()
                            .join(" ");
                        log::info!("[cdp][{}] stores {}", account_id, layout);
                    }
                    emit_snapshot(&app, &account_id, &snap);
                }
                Err(e) => {
                    log::warn!("[cdp][{}] scan failed: {}", account_id, e);
                }
            }
            sleep(SCAN_INTERVAL).await;
        }
    });
}

async fn scan_once<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
    url_prefix: &str,
) -> Result<ScanSnapshot, String> {
    let target = pick_target(url_prefix).await?;
    log::debug!(
        "[cdp][{}] target id={} url={}",
        account_id,
        target.id,
        target.url
    );
    let ws_url = target
        .ws_url
        .clone()
        .ok_or_else(|| "target has no webSocketDebuggerUrl".to_string())?;

    let snapshot = run_scanner(&ws_url).await?;
    let _ = app; // emit happens in caller (so we don't re-emit on error)
    Ok(snapshot)
}

/// HTTP discovery: GET /json/list, pick the first page whose URL starts
/// with `url_prefix`. CDP requires a non-browser User-Agent on some CEF
/// builds, so set one explicitly.
async fn pick_target(url_prefix: &str) -> Result<CdpTarget, String> {
    let url = format!("http://{CDP_HOST}:{CDP_PORT}/json/list");
    let resp = reqwest::Client::builder()
        .user_agent("openhuman-cdp/1.0")
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;

    let targets: Vec<CdpTarget> = resp
        .json()
        .await
        .map_err(|e| format!("parse /json/list: {e}"))?;
    let total = targets.len();
    let target = targets
        .into_iter()
        .find(|t| t.kind == "page" && t.url.starts_with(url_prefix))
        .ok_or_else(|| format!("no page target matching {url_prefix} (total={total})"))?;
    Ok(target)
}

/// Open a CDP WebSocket, send `Runtime.evaluate`, read the response,
/// extract `result.result.value` as our `ScanSnapshot`.
async fn run_scanner(ws_url: &str) -> Result<ScanSnapshot, String> {
    let (ws, _resp) = connect_async(ws_url)
        .await
        .map_err(|e| format!("ws connect: {e}"))?;
    let (mut tx, mut rx) = ws.split();

    let req_id: i64 = 1;
    let request = json!({
        "id": req_id,
        "method": "Runtime.evaluate",
        "params": {
            "expression": SCANNER_JS,
            "awaitPromise": true,
            "returnByValue": true,
            "timeout": 30_000,
        }
    });
    let body = serde_json::to_string(&request).map_err(|e| format!("encode req: {e}"))?;
    tx.send(Message::Text(body))
        .await
        .map_err(|e| format!("ws send: {e}"))?;

    // Pull frames until we see our id (CDP also pushes domain events; we
    // ignore everything that isn't the response).
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(60), rx.next())
            .await
            .map_err(|_| "ws read timeout".to_string())?
            .ok_or_else(|| "ws closed before reply".to_string())?
            .map_err(|e| format!("ws recv: {e}"))?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Close(_) => return Err("ws closed".into()),
        };
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("decode frame: {e}"))?;
        if v.get("id").and_then(|x| x.as_i64()) != Some(req_id) {
            continue;
        }

        if let Some(err) = v.get("error") {
            return Err(format!("cdp error: {err}"));
        }
        // Response shape: { id, result: { result: { type, value } } }
        // or, if the script threw: { id, result: { exceptionDetails: ... } }
        if let Some(exc) = v.pointer("/result/exceptionDetails") {
            return Err(format!("script threw: {exc}"));
        }
        let value = v
            .pointer("/result/result/value")
            .ok_or_else(|| format!("missing result/result/value in: {text}"))?
            .clone();
        let snap: ScanSnapshot =
            serde_json::from_value(value).map_err(|e| format!("decode snapshot: {e}"))?;
        return Ok(snap);
    }
}

/// Forward the snapshot to React via the same `webview:event` channel
/// recipe ingest already uses. UI code can listen for kind == "ingest".
fn emit_snapshot<R: Runtime>(app: &AppHandle<R>, account_id: &str, snap: &ScanSnapshot) {
    if !snap.ok {
        log::warn!(
            "[cdp][{}] snapshot not ok, error={:?}",
            account_id,
            snap.error
        );
        return;
    }
    let payload = json!({
        "accountId": account_id,
        "provider": "whatsapp",
        "kind": "ingest",
        "payload": {
            "provider": "whatsapp",
            "source": "cdp-indexeddb",
            "scannedAt": snap.scanned_at,
            "messages": snap.messages,
            "chats": snap.chats,
            "hadKey": snap.had_key,
            "dbs": snap.dbs,
        }
    });
    if let Err(e) = app.emit("webview:event", payload) {
        log::warn!("[cdp][{}] emit failed: {}", account_id, e);
    }
}

/// Track which (account_id, provider) pairs we've already started a scanner
/// for. The webview lifecycle can call `ensure_scanner` repeatedly without
/// double-spawning.
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
        url_prefix: String,
    ) {
        let mut g = self.started.lock().await;
        if !g.insert(account_id.clone()) {
            log::debug!("[cdp] scanner already running for {}", account_id);
            return;
        }
        spawn_scanner(app, account_id, url_prefix);
    }

    pub async fn forget(&self, account_id: &str) {
        let mut g = self.started.lock().await;
        g.remove(account_id);
    }
}
