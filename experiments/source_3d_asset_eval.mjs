import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runSource3DAsset } from '../src/source_3d_asset.js';

const casesPath = new URL('./source_3d_asset_cases.jsonl', import.meta.url);
const cases = (await readFile(casesPath, 'utf8'))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function imageCandidate(id, seed) {
  const data = Buffer.from(`replay-image:${id}:${seed}`);
  return {
    id,
    jobId: `replay-${id}`,
    mediaType: 'image/png',
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    model: 'replay-image-model',
    seed,
    data
  };
}

function replayDeps(fault) {
  return {
    async generateImages() {
      if (fault === 'generate_images') {
        const error = new Error('image provider unavailable');
        error.code = 'image_provider_unavailable';
        error.retryable = true;
        throw error;
      }
      return [imageCandidate('image-a', 42), imageCandidate('image-b', 73)];
    },
    async evaluateImages({ candidates }) {
      if (fault === 'evaluate_images_unknown') return { selectedId: 'invented', reason: 'bad replay decision' };
      return { selectedId: candidates[1].id, reason: 'clean silhouette' };
    },
    async generate3D({ candidate }) {
      if (fault === 'generate_3d') {
        const error = new Error('3D provider unavailable');
        error.code = 'provider_unavailable';
        error.retryable = true;
        throw error;
      }
      return {
        id: `artifact-${candidate.id}`,
        mediaType: 'model/gltf-binary',
        bytes: 1024,
        sha256: 'a'.repeat(64),
        producer: { provider: 'replay-3d' },
        data: Buffer.from('glb')
      };
    },
    async publishAsset({ artifact }) {
      if (fault === 'publish_asset') {
        const error = new Error('asset admission failed');
        error.code = 'asset_admission_failed';
        error.retryable = false;
        throw error;
      }
      return { id: `asset-${artifact.id}`, status: 'ready' };
    }
  };
}

function evaluate(testCase, run) {
  const effects = run.trace.flatMap(({ effects = [] }) => effects);
  const failures = [];
  if (run.state.phase !== testCase.expected.phase) {
    failures.push(`phase expected=${testCase.expected.phase} actual=${run.state.phase}`);
  }
  const actualCode = run.state.error?.code ?? null;
  const expectedCode = testCase.expected.errorCode ?? null;
  if (actualCode !== expectedCode) failures.push(`errorCode expected=${expectedCode} actual=${actualCode}`);
  if (JSON.stringify(effects) !== JSON.stringify(testCase.expected.effects)) {
    failures.push(`effects expected=${JSON.stringify(testCase.expected.effects)} actual=${JSON.stringify(effects)}`);
  }
  if (effects.length > testCase.expected.maxEffects) {
    failures.push(`effect budget exceeded: ${effects.length} > ${testCase.expected.maxEffects}`);
  }
  return {
    id: testCase.id,
    passed: failures.length === 0,
    failures,
    outcome: {
      phase: run.state.phase,
      errorCode: actualCode,
      selectedId: run.state.selectedId,
      assetId: run.state.asset?.id ?? null
    },
    trajectory: run.trace.map(({ event, phase, effects: stepEffects }) => ({ event, phase, effects: stepEffects })),
    metrics: {
      transitions: run.trace.length,
      effects: effects.length,
      effectBudget: testCase.expected.maxEffects
    }
  };
}

const started = Date.now();
const results = [];
for (const testCase of cases) {
  const run = await runSource3DAsset(
    { prompt: testCase.prompt, candidateCount: 2 },
    replayDeps(testCase.fault)
  );
  results.push(evaluate(testCase, run));
}

const report = {
  experiment: 'source_3d_asset-replay-v1',
  status: results.every(({ passed }) => passed) ? 'passed' : 'failed',
  elapsedMs: Date.now() - started,
  summary: {
    cases: results.length,
    passed: results.filter(({ passed }) => passed).length,
    failed: results.filter(({ passed }) => !passed).length
  },
  results
};

const outputDir = resolve('results/source_3d_asset_eval');
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (report.status !== 'passed') process.exitCode = 1;
