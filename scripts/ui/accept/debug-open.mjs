// Dev only: opens a file in the acceptance build and prints what the page shows (debugging the acceptance tooling).
import { launch } from './launch.mjs';
import { createInput } from './cdp-input.mjs';
import { createDialogs } from './dialogs.mjs';
import { corpusFile } from './corpus.mjs';
const TARGET = process.argv[2] ?? corpusFile('corpus-05');
const session = await launch();
const input = createInput(session);
const dialogs = createDialogs(session, input);
try {
  await input.sleep(1500);
  console.log('before:', await session.evaluate('document.body.innerText.slice(0,300)'));
  await dialogs.openFile(TARGET);
  await input.sleep(3000);
  console.log('state:', JSON.stringify(await dialogs.state()));
  console.log('after:', await session.evaluate('document.body.innerText.slice(0,300)'));
  console.log(
    'imgs/canvas:',
    await session.evaluate('[document.querySelectorAll("canvas").length, document.querySelectorAll("img").length]'),
  );
  console.log(await input.screenshot('accept-debug-open.png'));
} catch (e) {
  console.error('FAILED', e.message);
} finally {
  session.close();
}
