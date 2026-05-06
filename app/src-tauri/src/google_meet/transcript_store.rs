use crate::google_meet::types::{CaptionLine, MeetingId, MeetingTranscript};
use std::collections::HashMap;

#[derive(Default)]
pub struct MeetingTranscriptStore {
    transcripts: HashMap<MeetingId, MeetingTranscript>,
}

impl MeetingTranscriptStore {
    pub fn record_caption_batch(&mut self, meeting_id: MeetingId, batch: Vec<CaptionLine>) {
        if batch.is_empty() {
            return;
        }

        let transcript = self
            .transcripts
            .entry(meeting_id.clone())
            .or_insert_with(|| MeetingTranscript {
                id: meeting_id,
                started_at: batch[0].ts,
                lines: Vec::new(),
                ended_at: None,
            });

        for line in batch {
            let should_append = if let Some(last) = transcript.lines.last() {
                // Dedup: drop lines whose (speaker, ts) matches the last stored line's (speaker, ts)
                // AND whose text is a prefix of the existing one.
                if last.speaker == line.speaker && last.ts == line.ts {
                    if line.text.starts_with(&last.text) {
                        // The new line has more (or same) text for the same speaker and timestamp.
                        // Replace the last line instead of appending.
                        transcript.lines.pop();
                        true
                    } else {
                        // Same speaker and TS, but not a prefix relationship?
                        // If it's a prefix the other way (unlikely in normal flow), we keep the longer one.
                        !last.text.starts_with(&line.text)
                    }
                } else {
                    true
                }
            } else {
                true
            };

            if should_append {
                transcript.lines.push(line);
            }
        }
    }

    pub fn record_transcript(&mut self, transcript: MeetingTranscript) {
        self.transcripts.insert(transcript.id.clone(), transcript);
    }

    pub fn get_transcript(&self, meeting_id: &MeetingId) -> Option<&MeetingTranscript> {
        self.transcripts.get(meeting_id)
    }

    pub fn remove_transcript(&mut self, meeting_id: &MeetingId) -> Option<MeetingTranscript> {
        self.transcripts.remove(meeting_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_record_caption_batch_creates_entry() {
        let mut store = MeetingTranscriptStore::default();
        let mid = MeetingId("abc-defg-hij".to_string());
        let line = CaptionLine {
            speaker: "Alice".to_string(),
            text: "Hello".to_string(),
            ts: 1000,
        };

        store.record_caption_batch(mid.clone(), vec![line.clone()]);

        let t = store.get_transcript(&mid).unwrap();
        assert_eq!(t.started_at, 1000);
        assert_eq!(t.lines.len(), 1);
        assert_eq!(t.lines[0], line);
    }

    #[test]
    fn test_record_caption_batch_dedups_partial_emissions() {
        let mut store = MeetingTranscriptStore::default();
        let mid = MeetingId("abc-defg-hij".to_string());

        // Gmeet emits partial-then-full as the user speaks.
        // First batch
        store.record_caption_batch(
            mid.clone(),
            vec![CaptionLine {
                speaker: "Alice".to_string(),
                text: "Hello".to_string(),
                ts: 1000,
            }],
        );

        // Second batch with same speaker/ts but longer text
        store.record_caption_batch(
            mid.clone(),
            vec![CaptionLine {
                speaker: "Alice".to_string(),
                text: "Hello world".to_string(),
                ts: 1000,
            }],
        );

        let t = store.get_transcript(&mid).unwrap();
        assert_eq!(t.lines.len(), 1);
        assert_eq!(t.lines[0].text, "Hello world");
    }

    #[test]
    fn test_record_caption_batch_keeps_new_text_at_same_ts() {
        let mut store = MeetingTranscriptStore::default();
        let mid = MeetingId("abc-defg-hij".to_string());

        store.record_caption_batch(
            mid.clone(),
            vec![CaptionLine {
                speaker: "Alice".to_string(),
                text: "Hello".to_string(),
                ts: 1000,
            }],
        );

        // Same speaker/ts but NOT a prefix (different text entirely)
        store.record_caption_batch(
            mid.clone(),
            vec![CaptionLine {
                speaker: "Alice".to_string(),
                text: "Different".to_string(),
                ts: 1000,
            }],
        );

        let t = store.get_transcript(&mid).unwrap();
        assert_eq!(t.lines.len(), 2);
    }

    #[test]
    fn test_record_caption_batch_keeps_different_speaker_same_ts() {
        let mut store = MeetingTranscriptStore::default();
        let mid = MeetingId("abc-defg-hij".to_string());

        store.record_caption_batch(
            mid.clone(),
            vec![CaptionLine {
                speaker: "Alice".to_string(),
                text: "Hello".to_string(),
                ts: 1000,
            }],
        );

        store.record_caption_batch(
            mid.clone(),
            vec![CaptionLine {
                speaker: "Bob".to_string(),
                text: "Hi".to_string(),
                ts: 1000,
            }],
        );

        let t = store.get_transcript(&mid).unwrap();
        assert_eq!(t.lines.len(), 2);
    }
}
