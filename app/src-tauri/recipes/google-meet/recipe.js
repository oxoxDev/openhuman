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
    try {
      api.emit('meet_call_ended', {
        code: code,
        endedAt: endedAt,
        reason: reason,
      });
    } catch (_) {}
  }

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

  api.loop(function () {
    const code = meetingCode();

    // Lifecycle edges — fire start/end exactly once per transition.
    if (code !== currentCode) {
      if (currentCode && !code) {
        emitEnded(currentCode, 'navigated-away');
      } else if (!currentCode && code) {
        emitStarted(code);
      } else if (currentCode && code && currentCode !== code) {
        // Jumped straight from one meeting to another without an
        // intermediate landing — emit end+start so the host can close
        // and open two transcripts.
        emitEnded(currentCode, 'switched');
        currentCode = code;
        emitStarted(code);
        lastCaptionsKey = '';
        return;
      }
      currentCode = code;
      lastCaptionsKey = '';
    }

    if (!code) return;
    const captions = captionRows();
    if (captions.length > 0) {
      emitCaptionsIfChanged(code, captions);
    }
  });
})(window.__openhumanRecipe);
