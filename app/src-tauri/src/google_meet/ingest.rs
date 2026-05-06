use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Runtime};
use crate::google_meet::types::{MeetingId, IngestOutcome};
use crate::google_meet::transcript_store::MeetingTranscriptStore;

pub async fn flush_meeting<R: Runtime>(
    _app: &AppHandle<R>,
    _account_id: &str,
    _meeting_id: MeetingId,
    _store: &Arc<Mutex<MeetingTranscriptStore>>,
) -> IngestOutcome {
    IngestOutcome::Pending
}
