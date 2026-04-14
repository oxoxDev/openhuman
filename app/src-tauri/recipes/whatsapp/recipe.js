// WhatsApp Web recipe.
// Runs inside web.whatsapp.com after the runtime injects the API.
//
// v1 strategy: every poll, walk the chat list pane (`#pane-side`) and
// snapshot the visible conversation rows — name + last-message preview +
// unread badge. This is intentionally minimal — we just want to prove the
// end-to-end pipe (DOM scrape → Tauri IPC → React UI → core memory).
(function (api) {
  if (!api) return;
  api.log('info', '[whatsapp-recipe] starting');

  let lastSnapshot = '';

  function textOf(el) {
    return (el && el.textContent ? el.textContent : '').trim();
  }

  function scrapeChatList() {
    const pane = document.querySelector('#pane-side');
    if (!pane) return null;

    // WhatsApp Web renders rows with role="listitem" inside the pane.
    const rows = pane.querySelectorAll('div[role="listitem"]');
    const messages = [];
    let unread = 0;

    rows.forEach((row, idx) => {
      // Title (chat name) — typically the first heavy <span> with a title attr
      const titleEl =
        row.querySelector('span[title]') ||
        row.querySelector('span[dir="auto"][aria-label]') ||
        row.querySelector('span');
      const name = textOf(titleEl);

      // Last-message preview line
      const previewEl =
        row.querySelector('span[dir="ltr"]') ||
        row.querySelector('div[role="gridcell"] span[dir="auto"]');
      const preview = textOf(previewEl);

      // Unread badge — span with aria-label like "3 unread messages"
      const badgeEl = row.querySelector('span[aria-label*="unread"]');
      const badgeText = textOf(badgeEl);
      const badgeNum = parseInt(badgeText, 10);
      if (!Number.isNaN(badgeNum)) unread += badgeNum;

      if (name || preview) {
        messages.push({
          id: name ? 'wa:' + name : 'wa:row:' + idx,
          from: name || null,
          body: preview || null,
          unread: !Number.isNaN(badgeNum) ? badgeNum : 0,
        });
      }
    });

    return { messages, unread };
  }

  api.loop(function () {
    const snap = scrapeChatList();
    if (!snap) {
      // Likely still on the QR-login screen
      return;
    }

    // Cheap dedup: only ingest when the snapshot changes between polls.
    const key = JSON.stringify({
      n: snap.messages.length,
      u: snap.unread,
      first: snap.messages.slice(0, 5).map(function (m) { return m.from + '|' + m.body + '|' + m.unread; }),
    });
    if (key === lastSnapshot) return;
    lastSnapshot = key;

    api.ingest({
      messages: snap.messages,
      unread: snap.unread,
      snapshotKey: key,
    });
  });

  api.onNotify(function (n) {
    api.log('info', '[whatsapp-recipe] notify: ' + (n && n.title ? n.title : ''));
  });
})(window.__openhumanRecipe);
