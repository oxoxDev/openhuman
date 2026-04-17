// Google Meet recipe.
//
// Scope:
//   * Track the meeting lifecycle (joined call → left call / navigated
//     away) driven off the URL path.
//   * Stream Meet's own live-caption text back to Rust so the host can
//     accumulate a transcript. We do NOT run Whisper here — Meet's
//     built-in captions are the source of truth. User must have
//     "Turn on captions" enabled in Meet for this to yield anything.
//
// Event kinds emitted (on top of the runtime's standard set):
//   meet_call_started  { code, url, startedAt }
//   meet_captions      { code, captions:[{speaker,text}], ts }
//   meet_call_ended    { code, endedAt, reason }
//
// DOM anchors used — all are "stable-ish", meaning they've held for
// months at a time but are not contractual. Expect periodic maintenance
// when Meet ships a big redesign.
//   * URL path `/xxx-xxxx-xxx`  → meeting code / "am I in a call"
//   * `[jsname="tgaKEf"]`       → caption region container
//   * within a caption row: first `img[alt]` or `[data-self-name]`
//     for the speaker's display name; the rest of the text nodes for
//     the rolling transcript line
(function (api) {
  if (!api) return;
  api.log('info', '[google-meet-recipe] starting');

  const MEETING_CODE_RE = /^\/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})(?:$|\/|\?)/i;

  // Current-call state, owned by the recipe. Transitions are the trigger
  // for the started/ended lifecycle events.
  let currentCode = null;
  let startedAt = 0;

  // Meet SPA-navigates you off the meeting URL when you leave a call,
  // which destroys this JS context before emitEnded can run. Persist the
  // in-progress code to sessionStorage so the recipe on the next page
  // can emit a synthetic ended event for the previous session. Keyed by
  // origin (same-origin nav is guaranteed within meet.google.com).
  const SS_CODE = 'openhuman_gmeet_currentCode';
  const SS_STARTED_AT = 'openhuman_gmeet_startedAt';

  function ssGet(k) {
    try { return window.sessionStorage.getItem(k); } catch (_) { return null; }
  }
  function ssSet(k, v) {
    try { window.sessionStorage.setItem(k, v); } catch (_) {}
  }
  function ssDel(k) {
    try { window.sessionStorage.removeItem(k); } catch (_) {}
  }
  // Last caption snapshot we sent up — compared each tick so we only
  // emit when the on-screen captions actually changed.
  let lastCaptionsKey = '';

  function textOf(el) {
    return (el && el.textContent ? el.textContent : '').trim();
  }

  function meetingCode() {
    try {
      const m = MEETING_CODE_RE.exec(window.location.pathname || '');
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  }

  // Pull the speaker name out of one caption row. Meet renders an avatar
  // image whose `alt` is the speaker's display name; own-user rows carry
  // a `data-self-name` attribute instead.
  function rowSpeaker(row) {
    try {
      const img = row.querySelector('img[alt]');
      if (img) {
        const name = (img.getAttribute('alt') || '').trim();
        if (name) return name;
      }
      const self = row.querySelector('[data-self-name]');
      if (self) {
        const name = (self.getAttribute('data-self-name') || '').trim();
        if (name) return name;
      }
    } catch (_) {}
    return 'Unknown';
  }

  // Pull the rolling transcript line for one caption row. We want the
  // caption text only, not the speaker's name / timestamp chrome, so we
  // collect text from nodes that DON'T live inside an img's parent block
  // and aren't the `[data-self-name]` node.
  function rowText(row) {
    try {
      // Fast path: Meet currently wraps the actual words in a
      // `div > span` pair directly under the row. Grab the deepest span
      // with non-empty text.
      const spans = row.querySelectorAll('span');
      let best = '';
      for (let i = 0; i < spans.length; i++) {
        const t = textOf(spans[i]);
        if (t.length > best.length) best = t;
      }
      if (best) return best;
      return textOf(row);
    } catch (_) {
      return textOf(row);
    }
  }

  function captionRows() {
    // Two selectors kept in a single query so we degrade gracefully if
    // Meet swaps the jsname: fall back to anything labelled "captions".
    let region = null;
    try {
      region = document.querySelector('[jsname="tgaKEf"]');
      if (!region) {
        // Match English ("Captions") and localized ("Live captions",
        // "Sous-titres", …) by searching for the substring case-insensitive.
        const labelled = document.querySelectorAll('[aria-label]');
        for (let i = 0; i < labelled.length; i++) {
          const label = labelled[i].getAttribute('aria-label') || '';
          if (/caption|sous-titre|untertitel|leyenda/i.test(label)) {
            region = labelled[i];
            break;
          }
        }
      }
    } catch (_) {}
    if (!region) return [];

    // Each top-level child is (in current layout) one "speaker block".
    // Defensive: walk one level deep and pull the first div children.
    const rows = [];
    try {
      const children = region.children;
      for (let i = 0; i < children.length; i++) {
        const row = children[i];
        const speaker = rowSpeaker(row);
        const text = rowText(row);
        if (text) rows.push({ speaker: speaker, text: text });
      }
    } catch (_) {}
    return rows;
  }

  function emitStarted(code) {
    startedAt = Date.now();
    api.log('info', '[google-meet-recipe] call started: ' + code);
    ssSet(SS_CODE, code);
    ssSet(SS_STARTED_AT, String(startedAt));
    try {
      api.emit('meet_call_started', {
        code: code,
        url: window.location.href,
        startedAt: startedAt,
      });
    } catch (_) {}
  }

  function emitEnded(code, reason) {
    const endedAt = Date.now();
    api.log(
      'info',
      '[google-meet-recipe] call ended: ' +
        code +
        ' reason=' +
        reason +
        ' duration_s=' +
        Math.round((endedAt - startedAt) / 1000)
    );
    ssDel(SS_CODE);
    ssDel(SS_STARTED_AT);
    try {
      api.emit('meet_call_ended', {
        code: code,
        endedAt: endedAt,
        reason: reason,
      });
    } catch (_) {}
  }

  // Recovery path: if Meet destroyed the previous recipe context before
  // we could emit call_ended (leave-call navigates the SPA), sessionStorage
  // still has the code. On bootstrap, if we find a stale code AND the
  // current page has no meeting code, flush the previous session.
  (function recoverStaleSession() {
    const staleCode = ssGet(SS_CODE);
    if (!staleCode) return;
    const liveCode = meetingCode();
    if (liveCode === staleCode) {
      // Page reload inside the same call — resume, don't flush.
      const staleStarted = parseInt(ssGet(SS_STARTED_AT) || '0', 10);
      startedAt = staleStarted || Date.now();
      currentCode = staleCode;
      return;
    }
    // Either the URL has no code (left the call) or a different code
    // (switched meetings). Either way, close out the previous one.
    const staleStarted = parseInt(ssGet(SS_STARTED_AT) || '0', 10);
    if (staleStarted) startedAt = staleStarted;
    emitEnded(staleCode, liveCode ? 'switched-on-reload' : 'navigated-away');
  })();

  function emitCaptionsIfChanged(code, captions) {
    const key = JSON.stringify(captions);
    if (key === lastCaptionsKey) return;
    lastCaptionsKey = key;
    try {
      api.emit('meet_captions', {
        code: code,
        captions: captions,
        ts: Date.now(),
      });
    } catch (_) {}
  }

  // Positive "we are in the call" signal. The URL keeps the meeting code
  // in the lobby and on the post-leave screen too, so URL alone is not
  // enough. Once you actually enter the meeting room, Meet renders one
  // participant tile per attendee (including your own), marked with
  // `[data-participant-id]` on the tile wrapper and `[data-self-name]`
  // on the own-user tile. Neither attribute is present in the lobby or
  // on the post-leave screen — their presence is the cleanest signal
  // that we're fully joined.
  function sawParticipantBubbles() {
    try {
      if (document.querySelector('[data-self-name]')) return true;
      if (document.querySelector('[data-participant-id]')) return true;
    } catch (_) {}
    return false;
  }

  function inCallNow() {
    const code = meetingCode();
    if (!code) return null;
    return sawParticipantBubbles() ? code : null;
  }

  api.loop(function () {
    const activeCode = inCallNow();

    // End: we had an active call, and the "Leave call" button is gone
    // (lobby page, post-leave screen, or SPA-nav to another route).
    if (currentCode && activeCode !== currentCode) {
      emitEnded(
        currentCode,
        activeCode ? 'switched' : 'leave-call-button-gone'
      );
      // If we jumped straight to a different meeting, fall through to
      // emit the new start on the same tick.
      currentCode = null;
      lastCaptionsKey = '';
    }

    // Start: we're in a call (URL matches AND Leave-call button visible)
    // and we hadn't marked ourselves in-call yet.
    if (activeCode && !currentCode) {
      currentCode = activeCode;
      lastCaptionsKey = '';
      emitStarted(activeCode);
    }

    if (!currentCode) return;
    const captions = captionRows();
    if (captions.length > 0) {
      emitCaptionsIfChanged(currentCode, captions);
    }
  });
})(window.__openhumanRecipe);
