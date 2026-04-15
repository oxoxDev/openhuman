// IndexedDB scanner — runs inside a CEF page via CDP `Runtime.evaluate`.
// Returns a JSON object { ok, scannedAt, dbs[], chats{}, messages[],
// hadKey, error? } that the Rust side ingests. No api.* calls (we have no
// runtime here — this is a one-shot evaluation triggered by Rust).
//
// Decryption strategy:
//   WhatsApp Web persists most records as AES-GCM envelopes whose key is a
//   non-extractable CryptoKey ALSO stored in IndexedDB (round-trips via
//   structured clone). We deep-walk every record looking for a CryptoKey
//   instance, cache the first one, and call crypto.subtle.decrypt with it
//   directly (no importKey — it's already a CryptoKey).
//
// Returned shape per message:
//   { id, chatId, from, to, fromMe, body, type, timestamp }
//
// Caller controls re-scan cadence; we always do a full snapshot pass.
(async () => {
  const out = {
    ok: false,
    scannedAt: Date.now(),
    dbs: [],
    chats: {},
    messages: [],
    hadKey: false,
    // Diagnostics so the Rust log can show what we actually got — first
    // decrypted message per scan + the names of every store we walked.
    sampleMessages: [], // up to N most recent decrypted messages, body preview included
    storeMap: {}, // dbName → [storeName, ...]
    keyCount: 0, // total CryptoKeys discovered (across all DBs/stores)
    keySources: [], // [dbName/storeName, ...] where keys were found
    // Union of all top-level keys observed across N sampled message records
    // — different message types (text/media/sticker/etc) use different
    // subsets of fields, so first-record-only shape was misleading.
    messageKeyUnion: null,
    messageTypeBreakdown: null, // { type: count }
    sampleByType: null, // { type: shapeOf(firstRecordOfThatType) }
    schemaDump: {}, // "db/store" → first row shape (for non-message stores of interest)
    opfs: null, // { ok, files: [...] } — origin-private filesystem listing
  };
  const SAMPLE_COUNT = 5;
  const SAMPLE_BODY_PREVIEW = 120;
  const SCHEMA_DUMP_PATTERNS = ['comment', 'note', 'mutation', 'history', 'info', 'pinned'];

  // Exact (db, store) targets — discovered from a full store-map dump:
  //   model-storage/message  → message records
  //   model-storage/chat     → chat list
  //   model-storage/contact  → contact records (used for chat display names)
  //   model-storage/group-metadata → group display names
  // Substring matching grabbed `active-message-ranges` first (just metadata),
  // so we go fully exact now.
  const MESSAGE_STORES = new Set(['message']);
  const CHAT_STORES = new Set(['chat']);
  const CONTACT_STORES = new Set(['contact']);
  const GROUP_META_STORES = new Set(['group-metadata']);
  const MAX_RECORDS_PER_STORE = 20000;

  // ─── helpers ──────────────────────────────────────────────────────
  const isCryptoKey = (v) => typeof CryptoKey !== 'undefined' && v instanceof CryptoKey;

  const coerceBytes = (v) => {
    if (!v) return null;
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return null;
  };

  const findCryptoKey = (v, depth) => {
    if (v == null || depth > 6) return null;
    if (isCryptoKey(v)) return v;
    if (typeof v !== 'object') return null;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return null;
    if (Array.isArray(v)) {
      for (const item of v) { const h = findCryptoKey(item, depth + 1); if (h) return h; }
      return null;
    }
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      const h = findCryptoKey(v[k], depth + 1);
      if (h) return h;
    }
    return null;
  };

  const coerceEnvelope = (v) => {
    if (!v) return null;
    if (typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer)) {
      const iv = coerceBytes(v.iv) || coerceBytes(v._iv);
      const ct = coerceBytes(v.ciphertext) || coerceBytes(v.data) || coerceBytes(v.payload) || coerceBytes(v.ct) || coerceBytes(v.encrypted);
      if (iv && ct && iv.length >= 12 && iv.length <= 16) return { iv, ciphertext: ct };
    }
    const bytes = coerceBytes(v);
    if (bytes && bytes.length > 28) return { iv: bytes.slice(0, 12), ciphertext: bytes.slice(12) };
    return null;
  };

  const tryDecrypt = async (value, key) => {
    if (!value || !key) return null;
    const env = coerceEnvelope(value);
    if (!env) return null;
    try {
      const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: env.iv }, key, env.ciphertext);
      const txt = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      try { return JSON.parse(txt); } catch (_) { return txt; }
    } catch (_) { return null; }
  };

  const decryptDeep = async (v, key, depth) => {
    if (v == null || depth > 4) return v;
    if (typeof v !== 'object' || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
    const asEnv = await tryDecrypt(v, key);
    if (asEnv !== null) return asEnv;
    if (Array.isArray(v)) {
      const arr = new Array(v.length);
      for (let i = 0; i < v.length; i += 1) arr[i] = await decryptDeep(v[i], key, depth + 1);
      return arr;
    }
    const obj = {};
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      obj[k] = await decryptDeep(v[k], key, depth + 1);
    }
    return obj;
  };

  const normalizeId = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (v._serialized) return v._serialized;
    if (v.id && v.id._serialized) return v.id._serialized;
    if (v.id && typeof v.id === 'string') return v.id;
    if (v.remote) {
      const base = v.remote._serialized || v.remote;
      return typeof base === 'string' ? base : null;
    }
    return null;
  };

  const normalizeMessage = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const id = normalizeId(raw.id) || normalizeId(raw._id) || normalizeId(raw.key) || (typeof raw.id === 'string' ? raw.id : null);
    const from = normalizeId(raw.from) || normalizeId(raw.remoteJid);
    const to = normalizeId(raw.to);
    const author = normalizeId(raw.author) || normalizeId(raw.participant);
    const chatId = normalizeId(raw.chatId) || normalizeId(raw.remote) || from || to || null;
    const fromMe = !!(raw.fromMe || raw.isSentByMe || raw.isFromMe);
    const tsRaw = raw.t || raw.timestamp || raw.messageTimestamp || null;
    const ts = typeof tsRaw === 'number' ? tsRaw : (tsRaw ? Number(tsRaw) : null);
    let body = null;
    if (typeof raw.body === 'string') body = raw.body;
    else if (typeof raw.caption === 'string') body = raw.caption;
    else if (raw.body && typeof raw.body === 'object' && typeof raw.body.text === 'string') body = raw.body.text;
    else if (raw.message && typeof raw.message === 'object' && typeof raw.message.conversation === 'string') body = raw.message.conversation;
    return {
      id, chatId,
      from: fromMe ? 'me' : (author || from),
      to, fromMe, body,
      type: raw.type || (raw.message && Object.keys(raw.message)[0]) || null,
      timestamp: ts,
    };
  };

  const normalizeChat = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const id = normalizeId(raw.id) || normalizeId(raw._id);
    if (!id) return null;
    const name = raw.name || raw.subject || (raw.contact && (raw.contact.name || raw.contact.pushname)) || raw.formattedTitle || null;
    return { id, name };
  };

  const openDb = (name) => new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('open ' + name));
    req.onblocked = () => reject(new Error('blocked ' + name));
  });

  const readAll = (db, storeName, limit) => new Promise((resolve, reject) => {
    const rows = [];
    let tx;
    try { tx = db.transaction(storeName, 'readonly'); }
    catch (e) { reject(e); return; }
    const req = tx.objectStore(storeName).openCursor();
    req.onsuccess = (ev) => {
      const c = ev.target.result;
      if (!c) { resolve(rows); return; }
      rows.push({ key: c.key, value: c.value });
      if (limit && rows.length >= limit) { resolve(rows); return; }
      c.continue();
    };
    req.onerror = () => reject(req.error || new Error('cursor'));
  });

  // ─── scan ─────────────────────────────────────────────────────────
  try {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
      throw new Error('indexedDB.databases() unavailable');
    }
    const dbs = (await indexedDB.databases()).filter((d) => d && d.name);
    out.dbs = dbs.map((d) => d.name);

    // Quick shape summarizer for diagnostics — captures the top-level
    // keys + the type of each so we can see what an encrypted vs plain
    // record looks like without leaking content.
    const shapeOf = (v) => {
      if (v == null || typeof v !== 'object') return typeof v;
      const out = {};
      for (const k of Object.keys(v).slice(0, 30)) {
        const x = v[k];
        if (x == null) out[k] = String(x);
        else if (x instanceof Uint8Array) out[k] = 'Uint8Array(' + x.length + ')';
        else if (x instanceof ArrayBuffer) out[k] = 'ArrayBuffer(' + x.byteLength + ')';
        else if (ArrayBuffer.isView(x)) out[k] = x.constructor.name + '(' + x.byteLength + ')';
        else if (Array.isArray(x)) out[k] = 'Array(' + x.length + ')';
        else if (typeof CryptoKey !== 'undefined' && x instanceof CryptoKey) out[k] = 'CryptoKey';
        else if (typeof x === 'object') out[k] = 'Object{' + Object.keys(x).slice(0, 6).join(',') + '}';
        else if (typeof x === 'string') out[k] = 'String(' + x.length + ')';
        else out[k] = typeof x;
      }
      return out;
    };

    // Collect ALL CryptoKeys we find — any one might be the local-storage
    // AES-GCM key. We try them in priority order (wawc_db_enc first).
    // [{ key, source: "dbName/storeName" }]
    const allKeys = [];

    // Pass 1: walk every store of every db, build a store map for the
    // log, harvest every CryptoKey, and dump shapes from message-related
    // stores so we can find whichever one carries the body.
    for (const info of dbs) {
      let db;
      try { db = await openDb(info.name); } catch (_) { continue; }
      const stores = Array.from(db.objectStoreNames || []);
      out.storeMap[info.name] = stores;
      for (const storeName of stores) {
        let rows;
        try { rows = await readAll(db, storeName, 500); } catch (_) { continue; }
        for (const r of rows) {
          const k = findCryptoKey(r.value, 0);
          if (k) {
            allKeys.push({ key: k, source: info.name + '/' + storeName });
            // Stop scanning this store after first key — any one record is
            // representative for our priority ordering.
            break;
          }
        }
        // Schema dump for body-hunt: any store whose name hints at
        // message content. Capture the first row's shape only.
        const lc = storeName.toLowerCase();
        if (rows.length && SCHEMA_DUMP_PATTERNS.some((p) => lc.indexOf(p) !== -1)) {
          out.schemaDump[info.name + '/' + storeName] = shapeOf(rows[0].value);
        }
      }
      try { db.close(); } catch (_) {}
    }

    // Priority order: wawc_db_enc/keys first (this is WA's local-storage
    // encryption keystore), then anything else in wawc_db_enc, then
    // everything else. Dedupe by source so we don't try the same key twice.
    const priority = (src) => {
      if (src.startsWith('wawc_db_enc/keys')) return 0;
      if (src.startsWith('wawc_db_enc/')) return 1;
      if (src.startsWith('wawc/')) return 2;
      if (src.indexOf('signal-storage') !== -1) return 9; // probably wrong key
      return 5;
    };
    allKeys.sort((a, b) => priority(a.source) - priority(b.source));
    out.keyCount = allKeys.length;
    out.keySources = allKeys.map((e) => e.source);
    out.hadKey = allKeys.length > 0;

    const chatNames = new Map();
    const seen = new Set();
    // Union of every key seen across message records, with the type
    // signature observed for each. Lets us spot a `body`/`text`/`content`
    // field that only appears on text messages.
    const msgKeyUnion = new Map(); // fieldName -> Set<typeSignature>
    const msgTypeCounts = new Map(); // type -> count
    const msgSampleByType = new Map(); // type -> first record's shape

    // Try each key in priority order until decryption yields a different
    // (richer) result. Returns the best-effort decrypted value.
    const decryptWithBestKey = async (value) => {
      let best = value;
      let bestScore = scoreValue(value);
      for (const { key } of allKeys) {
        try {
          const candidate = await decryptDeep(value, key, 0);
          const score = scoreValue(candidate);
          if (score > bestScore) {
            best = candidate;
            bestScore = score;
          }
        } catch (_) {}
      }
      return best;
    };

    // Heuristic: count plaintext-looking string fields. A successful
    // decrypt produces records with strings like `body`, `from`, `type`.
    // An encrypted record is mostly Uint8Arrays.
    function scoreValue(v) {
      if (v == null || typeof v !== 'object') return 0;
      let s = 0;
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (typeof x === 'string') s += 1;
        else if (typeof x === 'number') s += 0.5;
        else if (x && typeof x === 'object' && !ArrayBuffer.isView(x)) s += 0.25;
      }
      return s;
    }

    const normalizeContact = (raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const id = normalizeId(raw.id) || normalizeId(raw._id);
      if (!id) return null;
      const name = raw.name || raw.notify || raw.shortName || raw.pushname || raw.verifiedName || null;
      return { id, name };
    };

    // Pass 2: chats + messages + contacts + group metadata, with
    // decryption applied to every record (active-message-ranges et al.
    // are skipped — we only touch exact store names now).
    for (const info of dbs) {
      let db;
      try { db = await openDb(info.name); } catch (_) { continue; }
      const stores = Array.from(db.objectStoreNames || []);

      for (const storeName of stores) {
        const isMsg = MESSAGE_STORES.has(storeName);
        const isChat = CHAT_STORES.has(storeName);
        const isContact = CONTACT_STORES.has(storeName);
        const isGroup = GROUP_META_STORES.has(storeName);
        if (!isMsg && !isChat && !isContact && !isGroup) continue;

        let rows;
        try { rows = await readAll(db, storeName, MAX_RECORDS_PER_STORE); } catch (_) { continue; }
        for (const r of rows) {
          const raw = r.value;
          let value = raw;
          if (allKeys.length) {
            value = await decryptWithBestKey(raw);
          }

          // Diagnostics: union the keys seen across every message record
          // and stash one full shape per `type`. With ~280 records spread
          // across text/media/sticker/system/etc, this surfaces fields
          // (like `body`) that only ever appear on text messages.
          if (isMsg && value && typeof value === 'object') {
            const t = (value.type && String(value.type)) || '<no-type>';
            msgTypeCounts.set(t, (msgTypeCounts.get(t) || 0) + 1);
            if (!msgSampleByType.has(t)) {
              msgSampleByType.set(t, shapeOf(value));
            }
            for (const k of Object.keys(value)) {
              const x = value[k];
              let sig;
              if (x == null) continue; // ignore undefined/null fields
              if (x instanceof Uint8Array) sig = 'Uint8Array';
              else if (x instanceof ArrayBuffer) sig = 'ArrayBuffer';
              else if (ArrayBuffer.isView(x)) sig = x.constructor.name;
              else if (Array.isArray(x)) sig = 'Array';
              else if (typeof CryptoKey !== 'undefined' && x instanceof CryptoKey) sig = 'CryptoKey';
              else if (typeof x === 'object') sig = 'Object';
              else sig = typeof x;
              if (!msgKeyUnion.has(k)) msgKeyUnion.set(k, new Set());
              msgKeyUnion.get(k).add(sig);
            }
          }

          if (isChat) {
            const c = normalizeChat(value);
            if (c && c.name) chatNames.set(c.id, c.name);
          }
          if (isContact) {
            const c = normalizeContact(value);
            if (c && c.name) chatNames.set(c.id, c.name);
          }
          if (isGroup) {
            const g = normalizeChat(value);
            if (g && g.name) chatNames.set(g.id, g.name);
          }
          if (isMsg) {
            const m = normalizeMessage(value);
            if (!m || !m.id || !m.chatId || !m.timestamp) continue;
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            out.messages.push(m);
          }
        }
      }
      try { db.close(); } catch (_) {}
    }
    chatNames.forEach((v, k) => { out.chats[k] = v; });

    // Serialise message-key union + per-type sample for the log.
    {
      const union = {};
      msgKeyUnion.forEach((sigSet, name) => { union[name] = Array.from(sigSet).sort().join('|'); });
      out.messageKeyUnion = union;
      const types = {};
      msgTypeCounts.forEach((count, t) => { types[t] = count; });
      out.messageTypeBreakdown = types;
      const byType = {};
      msgSampleByType.forEach((shape, t) => { byType[t] = shape; });
      out.sampleByType = byType;
    }

    // Pick the N most-recent messages that actually have a body so the
    // Rust log can print real plaintext (proof that decryption worked).
    out.sampleMessages = out.messages
      .filter((m) => m.body && typeof m.body === 'string')
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, SAMPLE_COUNT)
      .map((m) => ({
        chatId: m.chatId,
        chatName: out.chats[m.chatId] || null,
        fromMe: m.fromMe,
        from: m.from,
        timestamp: m.timestamp,
        bodyPreview: m.body.slice(0, SAMPLE_BODY_PREVIEW),
      }));

    // OPFS probe — WhatsApp Web has been migrating bodies into a
    // SQLite-via-WASM file living in the Origin Private File System.
    // List the root recursively so we can see what's there.
    try {
      if (navigator.storage && typeof navigator.storage.getDirectory === 'function') {
        const root = await navigator.storage.getDirectory();
        const files = [];
        const walk = async (dir, prefix) => {
          for await (const [name, handle] of dir.entries()) {
            const path = prefix ? prefix + '/' + name : name;
            if (handle.kind === 'file') {
              try {
                const f = await handle.getFile();
                files.push({ path, size: f.size, modified: f.lastModified });
              } catch (_) {
                files.push({ path, size: -1 });
              }
            } else if (handle.kind === 'directory') {
              if (files.length < 200) await walk(handle, path);
            }
          }
        };
        await walk(root, '');
        out.opfs = { ok: true, files: files.slice(0, 100) };
      } else {
        out.opfs = { ok: false, reason: 'navigator.storage.getDirectory unavailable' };
      }
    } catch (e) {
      out.opfs = { ok: false, reason: (e && e.message) || String(e) };
    }

    out.ok = true;
    return out;
  } catch (err) {
    out.error = (err && err.message) || String(err);
    return out;
  }
})()
