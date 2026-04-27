import { waitForApp, waitForAppReady } from '../helpers/app-helpers';
import { triggerAuthDeepLinkBypass } from '../helpers/deep-link-helpers';
import {
  textExists,
  waitForText,
  waitForWebView,
  waitForWindowVisible,
} from '../helpers/element-helpers';
import { supportsExecuteScript } from '../helpers/platform';
import { completeOnboardingIfVisible, navigateViaHash } from '../helpers/shared-flows';
import { startMockServer, stopMockServer } from '../mock-server';

/**
 * Text autocomplete settings smoke spec (features 5.2.1 inline suggestion,
 * 5.2.2 debounce, 5.2.3 acceptance trigger — settings surface).
 *
 * Goal: prove the AutocompletePanel mounts under /settings, exposes the
 * skill-status pill, and renders the "Enable" CTA when the runtime is
 * offline. Real inline suggestion firing inside a third-party text field
 * is gated by macOS TCC (Accessibility + Input Monitoring) and lives in
 * the manual smoke checklist (#971).
 *
 * Mac2 skipped — Settings sidebar label mapping not yet exposed to Appium.
 */
function stepLog(message: string, context?: unknown): void {
  const stamp = new Date().toISOString();
  if (context === undefined) {
    console.log(`[AutocompleteFlowE2E][${stamp}] ${message}`);
    return;
  }
  console.log(`[AutocompleteFlowE2E][${stamp}] ${message}`, JSON.stringify(context, null, 2));
}

describe('Autocomplete settings panel smoke', () => {
  before(async function beforeSuite() {
    if (!supportsExecuteScript()) {
      stepLog('Skipping suite on Mac2 — Settings sidebar not mapped');
      this.skip();
    }

    stepLog('starting mock server');
    await startMockServer();
    stepLog('waiting for app');
    await waitForApp();
    stepLog('triggering auth bypass deep link');
    await triggerAuthDeepLinkBypass('e2e-autocomplete-flow');
    await waitForWindowVisible(25_000);
    await waitForWebView(15_000);
    await waitForAppReady(15_000);
    await completeOnboardingIfVisible('[AutocompleteFlowE2E]');
  });

  after(async () => {
    stepLog('stopping mock server');
    await stopMockServer();
  });

  it('mounts the autocomplete settings panel and renders status', async () => {
    stepLog('navigating to /settings/autocomplete');
    await navigateViaHash('/settings/autocomplete');

    // Panel chrome — at least one of the skill-status labels rendered by
    // useAutocompleteSkillStatus must show. Status text is one of:
    // Active / Offline / Error / Unsupported.
    await waitForText('Auto', 15_000);
    const statusVisible =
      (await textExists('Active')) ||
      (await textExists('Offline')) ||
      (await textExists('Error')) ||
      (await textExists('Unsupported'));
    expect(statusVisible).toBe(true);
  });

  it('renders an Enable / Manage / Retry CTA driven by skill status', async () => {
    const ctaVisible =
      (await textExists('Enable')) ||
      (await textExists('Manage')) ||
      (await textExists('Retry')) ||
      (await textExists('Details'));
    expect(ctaVisible).toBe(true);
  });
});
