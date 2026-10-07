// Short UI clips as APNG from the acceptance build's own web view (ADR-138 section 3, rules 13 and 15): timed CDP
// Page.captureScreenshot with `clip`, never the screen. Node 22 built-ins only.
// recordClip(session, { rect, seconds, fps, scale, out, script, stillOut, plays (0 = loop forever, 1 = play once) }) -> { frames, bytes }
// Demo: node scripts/ui/accept/clip.mjs --demo   (writes review/v180/demo.png)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decodePngRgba, encodeApng, encodePng } from '../apng.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const WARN_BYTES = 600 * 1024;

/** Index of the captured frame to show at tick i (latest capture at or before i/fps; the first one before any exists). Pure. */
export function pickFrames(stamps, fps, seconds) {
  const n = Math.max(1, Math.round(seconds * fps));
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = (i * 1000) / fps;
    while (j + 1 < stamps.length && stamps[j + 1] <= t) j++;
    out.push(j);
  }
  return out;
}

export async function recordClip(
  session,
  { rect, seconds = 3, fps = 10, scale = 2, out, script, stillOut, plays = 0 } = {},
) {
  if (!rect || !out) throw new Error('recordClip needs rect and out');
  const clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale };
  const shots = [];
  const stamps = [];
  const t0 = Date.now();
  let done = false;
  const scriptRun = (async () => {
    try {
      await script?.();
    } finally {
      // the script may end early; recording continues for the full duration
    }
  })();
  scriptRun.catch(() => {});
  while (Date.now() - t0 < seconds * 1000) {
    const t = Date.now() - t0;
    const r = await session.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    shots.push(Buffer.from(r.data, 'base64'));
    stamps.push(t);
    const wait = 1000 / fps - (Date.now() - t0 - t);
    if (wait > 0) await sleep(wait);
  }
  done = true;
  await scriptRun; // surfaces script errors
  if (!done || !shots.length) throw new Error('no frames captured');
  const decoded = shots.map((b) => decodePngRgba(b));
  const frames = pickFrames(stamps, fps, seconds).map((i) => ({ ...decoded[i], delayMs: 1000 / fps }));
  const { buffer } = encodeApng(frames, { loops: plays });
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, buffer);
  if (stillOut) {
    mkdirSync(dirname(resolve(stillOut)), { recursive: true });
    writeFileSync(stillOut, encodePng(decoded[decoded.length - 1]));
  }
  if (buffer.length > WARN_BYTES)
    console.warn(
      `WARN clip ${out} is ${(buffer.length / 1024).toFixed(0)} KB (> 600 KB): lower scale/fps/seconds or shrink rect`,
    );
  return { frames: frames.length, bytes: buffer.length };
}

async function demo() {
  const { runSession, createResults, openAndWait, SCROLLER } = await import('./harness.mjs');
  const ROOT = resolve(import.meta.dirname, '../../..');
  const results = createResults();
  const code = await runSession(async (ctx) => {
    await openAndWait(ctx, resolve(ROOT, 'tests/fixtures/text.pdf'));
    const vp = await ctx.ev(`({ w: innerWidth, h: innerHeight })`);
    const rect = (await ctx.ev(
      `(() => { const r = document.querySelector(${JSON.stringify(SCROLLER)})?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null; })()`,
    )) ?? { x: 0, y: 0, width: vp.w, height: vp.h };
    const res = await recordClip(ctx.session, {
      rect,
      seconds: 2,
      fps: 10,
      scale: 1,
      out: resolve(ROOT, 'review/v180/demo.png'),
      script: async () => {
        for (let i = 0; i < 10; i++) {
          await ctx.ev(
            `(() => { const s = document.querySelector(${JSON.stringify(SCROLLER)}); if (s) s.scrollTop += 60; })()`,
          );
          await sleep(180);
        }
      },
    });
    results.check('clip written', res.frames > 0, `frames=${res.frames} bytes=${res.bytes}`);
  }, results);
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename) && process.argv.includes('--demo'))
  await demo();
