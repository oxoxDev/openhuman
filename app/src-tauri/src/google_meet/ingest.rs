use crate::google_meet::transcript_store::MeetingTranscriptStore;
use crate::google_meet::types::{IngestOutcome, MeetingId, MeetingTranscript};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use tokio::sync::Mutex;

#[async_trait::async_trait]
pub trait MemoryIngestClient: Send + Sync {
    async fn ingest_doc(&self, params: serde_json::Value) -> Result<(), String>;
}

pub struct CoreRpcClient;

#[async_trait::async_trait]
impl MemoryIngestClient for CoreRpcClient {
    async fn ingest_doc(&self, params: serde_json::Value) -> Result<(), String> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "openhuman.memory_doc_ingest",
            "params": params,
        });

        let url = crate::core_rpc::core_rpc_url_value();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("http client: {e}"))?;

        let req = crate::core_rpc::apply_auth(client.post(&url))
            .map_err(|e| format!("prepare {url}: {e}"))?;

        let resp = req
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("POST {url}: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("{status}: {body}"));
        }

        let v: serde_json::Value = resp.json().await.map_err(|e| format!("decode: {e}"))?;
        if let Some(err) = v.get("error") {
            return Err(format!("rpc error: {err}"));
        }

        Ok(())
    }
}

pub async fn flush_meeting<R: Runtime>(
    _app: &AppHandle<R>,
    account_id: &str,
    meeting_id: MeetingId,
    store: &Arc<Mutex<MeetingTranscriptStore>>,
) -> IngestOutcome {
    flush_meeting_internal(account_id, meeting_id, store, &CoreRpcClient).await
}

pub async fn flush_meeting_internal(
    account_id: &str,
    meeting_id: MeetingId,
    store: &Arc<Mutex<MeetingTranscriptStore>>,
    client: &dyn MemoryIngestClient,
) -> IngestOutcome {
    let transcript = {
        let mut store_guard = store.lock().await;
        match store_guard.remove_transcript(&meeting_id) {
            Some(t) => t,
            None => return IngestOutcome::Pending,
        }
    };

    let started_at = transcript.started_at;
    let ended_at = chrono::Utc::now().timestamp_millis();

    let body = format_transcript_body(&transcript);

    // YYYY-MM-DD
    let date_str = chrono::DateTime::from_timestamp(started_at / 1000, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown-date".to_string());

    let namespace = format!("google-meet:{}", account_id);
    let key = format!("{}:{}", meeting_id.0, started_at);
    let title = format!("Google Meet — {} — {}", meeting_id.0, date_str);

    let params = json!({
        "namespace": namespace,
        "key": key,
        "title": title,
        "content": body,
        "source_type": "google-meet",
        "priority": "medium",
        "tags": ["google-meet", "meeting-transcript", date_str],
        "metadata": {
            "provider": "google-meet",
            "account_id": account_id,
            "meeting_id": meeting_id.0,
            "started_at": started_at,
            "ended_at": ended_at,
        },
        "category": "core",
    });

    match client.ingest_doc(params).await {
        Ok(_) => {
            log::info!(
                "[gmeet][{}] transcript persisted mid={}",
                account_id,
                meeting_id.0
            );
            IngestOutcome::Persisted
        }
        Err(err) => {
            log::warn!("[gmeet][{}] ingestion failed: {}", account_id, err);
            // Put it back so we can retry
            let mut store_guard = store.lock().await;
            store_guard.record_transcript(transcript);
            IngestOutcome::Retry(err)
        }
    }
}

fn format_transcript_body(transcript: &MeetingTranscript) -> String {
    let mut sorted_lines = transcript.lines.clone();
    sorted_lines.sort_by_key(|l| l.ts);

    let lines: Vec<String> = sorted_lines
        .into_iter()
        .map(|l| {
            let dt = chrono::DateTime::from_timestamp(l.ts / 1000, 0);
            let time_str = dt
                .map(|d| d.format("%H:%M:%S").to_string())
                .unwrap_or_else(|| "--:--:--".to_string());
            format!("[{}] {}: {}", time_str, l.speaker, l.text)
        })
        .collect();

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::google_meet::types::CaptionLine;

    struct MockClient {
        should_fail: bool,
    }

    #[async_trait::async_trait]
    impl MemoryIngestClient for MockClient {
        async fn ingest_doc(&self, _params: serde_json::Value) -> Result<(), String> {
            if self.should_fail {
                Err("Injected failure".to_string())
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn test_flush_meeting_success() {
        let store = Arc::new(Mutex::new(MeetingTranscriptStore::default()));
        let mid = MeetingId("abc-defg-hij".to_string());

        {
            let mut s = store.lock().await;
            s.record_caption_batch(
                mid.clone(),
                vec![CaptionLine {
                    speaker: "Alice".to_string(),
                    text: "Hello".to_string(),
                    ts: 1000,
                }],
            );
        }

        let client = MockClient { should_fail: false };
        let outcome = flush_meeting_internal("acct1", mid.clone(), &store, &client).await;

        assert!(matches!(outcome, IngestOutcome::Persisted));
        let s = store.lock().await;
        assert!(s.get_transcript(&mid).is_none());
    }

    #[tokio::test]
    async fn test_flush_meeting_failure_keeps_transcript() {
        let store = Arc::new(Mutex::new(MeetingTranscriptStore::default()));
        let mid = MeetingId("abc-defg-hij".to_string());

        {
            let mut s = store.lock().await;
            s.record_caption_batch(
                mid.clone(),
                vec![CaptionLine {
                    speaker: "Alice".to_string(),
                    text: "Hello".to_string(),
                    ts: 1000,
                }],
            );
        }

        let client = MockClient { should_fail: true };
        let outcome = flush_meeting_internal("acct1", mid.clone(), &store, &client).await;

        assert!(matches!(outcome, IngestOutcome::Retry(_)));
        let s = store.lock().await;
        assert!(s.get_transcript(&mid).is_some());
    }
}
