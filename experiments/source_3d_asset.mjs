import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createModal2DAdapter,
  createOpenAICompatibleVisionRanker
} from '../src/source_3d_asset.js';

const prompt = process.argv.slice(2).join(' ').trim() || 'a single realistic red apple, centered isolated object, clean neutral studio background, no text, no extra objects';
const count = Number(process.env.AGENTSCAPE_AGENT_IMAGE_CANDIDATES ?? 4);
const outputDir = resolve('results/source_3d_asset');
await mkdir(outputDir, { recursive: true });

const imageAdapter = createModal2DAdapter({
  endpoint: process.env.AGENTSCAPE_MODAL_2D_ENDPOINT ?? 'http://127.0.0.1:3212',
  token: process.env.MODAL_2D_AGENT_TOKEN,
  model: process.env.AGENTSCAPE_MODAL_2D_MODEL ?? 'sana-sprint-1.6b'
});

const started = Date.now();
const candidates = await imageAdapter.generateImages({ prompt, count });
for (let index = 0; index < candidates.length; index++) {
  await writeFile(resolve(outputDir, `candidate-${index + 1}.png`), candidates[index].data);
}

let ranking = { status: 'skipped', reason: 'LLM credentials are not configured' };
const baseUrl = process.env.AGENTSCAPE_LLM_BASE_URL ?? process.env.AGENTSCAPE_TEST_LLM_BASE_URL;
const apiKey = process.env.AGENTSCAPE_LLM_API_KEY ?? process.env.AGENTSCAPE_TEST_LLM_API_KEY;
const model = process.env.AGENTSCAPE_LLM_MODEL ?? process.env.AGENTSCAPE_TEST_LLM_MODEL;
if (baseUrl && apiKey && model) {
  const ranker = createOpenAICompatibleVisionRanker({ baseUrl, apiKey, model });
  ranking = { status: 'passed', ...(await ranker.evaluateImages({ prompt, candidates })) };
}

const manifest = {
  status: 'passed',
  experiment: 'source_3d_asset-candidates-v1',
  prompt,
  elapsedMs: Date.now() - started,
  candidates: candidates.map(({ data, ...candidate }, index) => ({ ...candidate, file: `candidate-${index + 1}.png` })),
  ranking
};
await writeFile(resolve(outputDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
