pub mod ingest;
pub mod transcript_store;
pub mod types;

use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Mutex;

pub use transcript_store::MeetingTranscriptStore;
pub use types::{CaptionLine, IngestOutcome, MeetingId};

pub async fn record_caption_batch<R: Runtime>(
    app: &AppHandle<R>,
    meeting_id: MeetingId,
    batch: Vec<CaptionLine>,
) {
    if let Some(store) = app.try_state::<Arc<Mutex<MeetingTranscriptStore>>>() {
        let mut store = store.lock().await;
        store.record_caption_batch(meeting_id, batch);
    }
}

pub async fn flush_meeting<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
    meeting_id: MeetingId,
) -> IngestOutcome {
    if let Some(store) = app.try_state::<Arc<Mutex<MeetingTranscriptStore>>>() {
        // We use a separate module for ingestion logic to keep mod.rs clean
        ingest::flush_meeting(app, account_id, meeting_id, &store).await
    } else {
        IngestOutcome::Retry("MeetingTranscriptStore not found in app state".to_string())
    }
}
