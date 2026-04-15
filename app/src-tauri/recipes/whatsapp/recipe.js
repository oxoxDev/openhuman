// WhatsApp Web recipe.
//
// IndexedDB reading + decryption now happens on the Rust side via CDP
// (`Runtime.evaluate` against the embedded CEF instance), so this recipe
// only needs to keep the composer attach alive — sending messages still
// goes through the live DOM editor on web.whatsapp.com.
//
// The Rust scanner lives at `app/src-tauri/src/cdp_indexeddb/`; the JS it
// runs is `scanner.js` in that folder.
(function (api) {
  if (!api) return;
  api.log('info', '[whatsapp-recipe] starting (composer-only; reads via CDP)');

  let attachedComposerEl = null;
  let attachedHandle = null;

  function findComposer() {
    return (
      document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
      document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]')
    );
  }

  function ensureComposerAttached() {
    const el = findComposer();
    if (!el) return;
    if (el === attachedComposerEl) return;
    if (attachedHandle) { try { attachedHandle.detach(); } catch (_) {} }
    attachedComposerEl = el;
    attachedHandle = api.attachComposer(el, {
      id: 'whatsapp:composer',
      providerHint: 'whatsapp',
      debounceMs: 250,
      suggestionKey: 'Tab',
    });
    api.log('info', '[whatsapp-recipe] composer attached');
  }

  api.loop(function () {
    ensureComposerAttached();
  });

  if (typeof api.onNotify === 'function') {
    api.onNotify(function (n) {
      api.log('info', '[whatsapp-recipe] notify: ' + (n && n.title ? n.title : ''));
    });
  }
})(window.__openhumanRecipe);
