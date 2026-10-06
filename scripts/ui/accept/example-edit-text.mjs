// Example acceptance script (ADR-131): the v1.5.1 text-edit flow, driven over CDP with the dialog guard.
// Prereq: npm run build:acceptance. Run: node scripts/ui/accept/example-edit-text.mjs
// UI language must be German (labels below); adapt the text targets otherwise.
import { launch } from './launch.mjs';
import { createInput } from './cdp-input.mjs';
import { createDialogs } from './dialogs.mjs';
import { startGuard } from './guard.mjs';

const session = await launch();
const guard = startGuard(session.pid);
let code = 0;
try {
  const input = createInput(session, { guard });
  const dialogs = createDialogs(session, input);
  const run = async () => {
    await dialogs.openFile('review/owner/corpus/2025_Rechnung_202500100.pdf');
    await input.waitForTarget({ selector: 'canvas' }, { timeoutMs: 20000 });
    await input.click({ role: 'tab', text: 'Bearbeiten' });
    await input.click({ text: 'Text bearbeiten' });
    await input.waitForTarget({ text: '04129 Leipzig' }, { timeoutMs: 20000 });
    await input.click({ text: '04129 Leipzig' });
    await input.press('End');
    await input.insertText('-Mitte');
    await input.sleep(500);
    console.log('screenshot:', await input.screenshot('accept-edit-text.png'));
  };
  await Promise.race([run(), guard.aborted]);
  console.log('OK');
} catch (e) {
  console.error('FAILED:', e.message);
  code = 1;
} finally {
  guard.stop();
  session.close();
}
process.exit(code);
