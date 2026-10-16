// Build-time audio generation with ElevenLabs. The API key never ships to the browser.
//   ELEVENLABS_API_KEY=sk_... node tools/generate-audio.mjs [--force]
import { writeFile, access, mkdir } from 'node:fs/promises';
import { SPEECH, SFX } from './audio-manifest.mjs';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('Set ELEVENLABS_API_KEY'); process.exit(1); }
const OUT = new URL('../assets/audio/', import.meta.url);
const force = process.argv.includes('--force');
await mkdir(OUT, { recursive: true });

const exists = (p) => access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const msg = await res.text();
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    throw new Error(`${res.status} ${msg.slice(0, 300)}`);
  }
  throw new Error('retries exhausted');
}

const jobs = [
  ...SFX.map(([id, text, duration, loop, influence]) => ({
    id,
    url: 'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128',
    body: { text, duration_seconds: duration, loop, prompt_influence: influence, model_id: 'eleven_text_to_sound_v2' },
  })),
  ...SPEECH.map(({ id, voice, text }) => ({
    id,
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
    body: { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.45 } },
  })),
];

const done = [];
const failed = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const file = new URL(`${job.id}.mp3`, OUT);
    if (!force && await exists(file)) { done.push(job.id); continue; }
    try {
      await writeFile(file, await post(job.url, job.body));
      done.push(job.id);
      console.log('ok  ', job.id);
    } catch (e) {
      failed.push(job.id);
      console.log('FAIL', job.id, e.message);
    }
  }
}
await Promise.all([worker(), worker(), worker()]);
done.sort();
await writeFile(new URL('manifest.json', OUT), JSON.stringify(done, null, 0));
console.log(`\n${done.length} files ready, ${failed.length} failed`, failed.join(' '));
