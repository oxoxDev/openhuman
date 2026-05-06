use std::collections::HashMap;
use crate::google_meet::types::{MeetingId, MeetingTranscript, CaptionLine};

#[derive(Default)]
pub struct MeetingTranscriptStore {
    transcripts: HashMap<MeetingId, MeetingTranscript>,
}

impl MeetingTranscriptStore {
    pub fn record_caption_batch(&mut self, _meeting_id: MeetingId, _batch: Vec<CaptionLine>) {
    }

    pub fn record_transcript(&mut self, _transcript: MeetingTranscript) {
    }

    pub fn get_transcript(&self, _meeting_id: &MeetingId) -> Option<&MeetingTranscript> {
        None
    }

    pub fn remove_transcript(&mut self, _meeting_id: &MeetingId) -> Option<MeetingTranscript> {
        None
    }
}
