import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createModal2DAdapter,
  createOpenAICompatibleVisionRanker,
  decideSource3DAsset,
  initialSource3DAssetState,
  runSource3DAsset
} from '../src/source_3d_asset.js';

function candidate(id, seed = 42) {
  const data = Buffer.from(`png:${id}`);
  return {
    id,
    jobId: `job-${id}`,
    mediaType: 'image/png',
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    model: 'test-image-model',
    seed,
    data
  };
}

test('functional core follows the source_3d_asset vertical slice', () => {
  let state = initialSource3DAssetState({ prompt: 'red apple', candidateCount: 2 });
  let transition = decideSource3DAsset(state, { type: 'started' });
  assert.equal(transition.state.phase, 'generating_images');
  assert.deepEqual(transition.effects.map(({ type }) => type), ['generate_images']);

  state = transition.state;
  transition = decideSource3DAsset(state, { type: 'images_generated', candidates: [candidate('a'), candidate('b', 73)] });
  assert.equal(transition.state.phase, 'evaluating_images');
  assert.deepEqual(transition.state.candidates.map(({ id }) => id), ['a', 'b']);
  assert.equal('data' in transition.state.candidates[0], false, 'durable state must not retain binary image bytes');

  state = transition.state;
  transition = decideSource3DAsset(state, { type: 'candidate_selected', selectedId: 'b' });
  assert.equal(transition.state.phase, 'generating_3d');
  assert.equal(transition.state.selectedId, 'b');

  state = transition.state;
  transition = decideSource3DAsset(state, {
    type: 'three_d_generated',
    artifact: { id: 'glb-1', mediaType: 'model/gltf-binary', bytes: 123, sha256: 'a'.repeat(64) }
  });
  assert.equal(transition.state.phase, 'publishing_asset');

  state = transition.state;
  transition = decideSource3DAsset(state, { type: 'asset_published', asset: { id: 'asset-1', status: 'ready' } });
  assert.equal(transition.state.phase, 'done');
  assert.equal(transition.state.asset.id, 'asset-1');
  assert.deepEqual(transition.effects, []);
});

test('functional core rejects a VLM selection outside the generated candidate set', () => {
  const generated = decideSource3DAsset(
    decideSource3DAsset(initialSource3DAssetState({ prompt: 'chair' }), { type: 'started' }).state,
    { type: 'images_generated', candidates: [candidate('known')] }
  ).state;
  assert.throws(
    () => decideSource3DAsset(generated, { type: 'candidate_selected', selectedId: 'invented' }),
    /unknown selected candidate/
  );
});

test('imperative shell composes effects while the core remains provider-neutral', async () => {
  const calls = [];
  const candidates = [candidate('image-a'), candidate('image-b', 73)];
  const result = await runSource3DAsset(
    { prompt: 'red apple', candidateCount: 2 },
    {
      async generateImages(input) {
        calls.push(['images', input]);
        return candidates;
      },
      async evaluateImages(input) {
        calls.push(['evaluate', input.candidates.map(({ id }) => id)]);
        return { selectedId: 'image-b', reason: 'clear silhouette' };
      },
      async generate3D({ candidate: selected }) {
        calls.push(['3d', selected.id]);
        return { id: 'glb-1', mediaType: 'model/gltf-binary', bytes: 99, sha256: 'b'.repeat(64), data: Buffer.from('glb') };
      },
      async publishAsset({ artifact }) {
        calls.push(['publish', artifact.id]);
        return { id: 'asset-1', status: 'ready' };
      }
    }
  );

  assert.equal(result.state.phase, 'done');
  assert.equal(result.state.selectedId, 'image-b');
  assert.equal(result.state.asset.id, 'asset-1');
  assert.deepEqual(calls.map(([name]) => name), ['images', 'evaluate', '3d', 'publish']);
  assert.deepEqual(result.trace.map(({ phase }) => phase), [
    'generating_images',
    'evaluating_images',
    'generating_3d',
    'publishing_asset',
    'done'
  ]);
});

test('imperative shell turns invalid effect results into explicit invariant failure', async () => {
  const images = [candidate('known')];
  const result = await runSource3DAsset(
    { prompt: 'red apple', candidateCount: 1 },
    {
      async generateImages() { return images; },
      async evaluateImages() { return { selectedId: 'invented', reason: 'bad evaluator output' }; },
      async generate3D() {},
      async publishAsset() {}
    }
  );
  assert.equal(result.state.phase, 'failed');
  assert.deepEqual(result.state.error, {
    code: 'workflow_invariant_failed',
    message: 'unknown selected candidate: invented',
    retryable: false
  });
  assert.equal(result.trace.at(-1).causedBy, 'candidate_selected');
});

test('imperative shell turns effect errors into explicit failed state', async () => {
  const result = await runSource3DAsset(
    { prompt: 'red apple' },
    {
      async generateImages() {
        const error = new Error('provider unavailable');
        error.code = 'provider_unavailable';
        error.retryable = true;
        throw error;
      },
      async evaluateImages() {},
      async generate3D() {},
      async publishAsset() {}
    }
  );
  assert.equal(result.state.phase, 'failed');
  assert.deepEqual(result.state.error, {
    code: 'provider_unavailable',
    message: 'provider unavailable',
    retryable: true
  });
});

test('modal-2D adapter submits deterministic jobs, polls, and verifies artifact digest', async () => {
  const requests = [];
  const image = Buffer.from('real-ish-png-bytes');
  const sha256 = createHash('sha256').update(image).digest('hex');
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/v1/jobs') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: body.job_id, status: 'running' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (/\/v1\/jobs\/agent2d_/.test(url) && !url.endsWith('/artifact')) {
      return new Response(JSON.stringify({ status: 'succeeded' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.endsWith('/artifact')) {
      return new Response(image, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-artifact-id': 'art-1',
          'x-artifact-sha256': sha256
        }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const adapter = createModal2DAdapter({
    endpoint: 'http://sidecar.test',
    token: 'session-secret-for-test',
    baseSeed: 42,
    pollIntervalMs: 0,
    fetchImpl
  });
  const first = await adapter.generateImages({ prompt: 'red apple', count: 1 });
  const second = await adapter.generateImages({ prompt: 'red apple', count: 1 });

  assert.equal(first[0].jobId, second[0].jobId, 'same request must produce stable job identity');
  assert.equal(first[0].sha256, sha256);
  assert.equal(first[0].id, 'art-1');
  assert.equal(first[0].data.equals(image), true);
  assert.ok(requests.every(({ init }) => init.headers?.['X-Modal-2D-Session'] === 'session-secret-for-test'));
});

test('OpenAI-compatible VLM adapter sends multimodal candidates and validates selected id', async () => {
  const candidates = [candidate('image-a'), candidate('image-b')];
  let upstreamBody;
  const ranker = createOpenAICompatibleVisionRanker({
    baseUrl: 'https://vlm.example/v1',
    apiKey: 'test-key',
    model: 'vision-model',
    fetchImpl: async (_url, init) => {
      upstreamBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"selectedId":"image-b","reason":"cleaner silhouette"}' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await ranker.evaluateImages({ prompt: 'red apple', candidates });
  assert.deepEqual(result, { selectedId: 'image-b', reason: 'cleaner silhouette' });
  assert.equal(upstreamBody.model, 'vision-model');
  const content = upstreamBody.messages[1].content;
  assert.equal(content.filter(({ type }) => type === 'image_url').length, 2);
  assert.ok(content.some((part) => part.type === 'text' && part.text.includes('Candidate id: image-a')));
});

test('OpenAI-compatible VLM adapter fails closed on invented candidate ids', async () => {
  const ranker = createOpenAICompatibleVisionRanker({
    baseUrl: 'https://vlm.example/v1',
    apiKey: 'test-key',
    model: 'vision-model',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"selectedId":"invented","reason":"oops"}' } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  await assert.rejects(
    () => ranker.evaluateImages({ prompt: 'red apple', candidates: [candidate('real')] }),
    /selected unknown candidate/
  );
});
