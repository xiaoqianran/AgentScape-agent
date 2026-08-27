import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createModal2DAdapter,
  createModal3DAdapter,
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
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({
        models: [{ id: 'sana-sprint-1.6b', profiles: [{ id: 'recommended' }] }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
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
  assert.equal(requests.filter(({ url }) => url.endsWith('/v1/models')).length, 1, 'capability preflight must be cached per adapter');
  assert.ok(requests.every(({ init }) => init.headers?.['X-Modal-2D-Session'] === 'session-secret-for-test'));
});

test('modal-2D capability preflight rejects unavailable model before job submit', async () => {
  let jobRequests = 0;
  const adapter = createModal2DAdapter({
    endpoint: 'http://sidecar.test',
    model: 'missing-model',
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ models: [{ id: 'sana-sprint-1.6b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.endsWith('/v1/jobs') && init.method === 'POST') jobRequests += 1;
      throw new Error(`unexpected request: ${url}`);
    }
  });
  await assert.rejects(() => adapter.preflight(), (error) => error.code === 'capability_unavailable');
  assert.equal(jobRequests, 0);
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


function glbBytes(payload = Buffer.alloc(16)) {
  const total = 12 + payload.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  return Buffer.concat([header, payload]);
}

test('modal-3D adapter submits source bytes with stable identity and verifies GLB', async () => {
  const source = Buffer.from('candidate-image-bytes');
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const glb = glbBytes(Buffer.from('mesh-payload'));
  const glbSha256 = createHash('sha256').update(glb).digest('hex');
  const submissions = [];
  let capabilityRequests = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/v1/models')) {
      capabilityRequests += 1;
      return new Response(JSON.stringify({
        models: [{
          id: 'fastsam3d-plus-plus',
          status: 'enabled',
          profiles: [{ id: 'recommended' }]
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/v1/jobs') && init.method === 'POST') {
      const form = init.body;
      const file = form.get('file');
      submissions.push({
        model: form.get('model'),
        profile: form.get('profile'),
        seed: form.get('seed'),
        jobId: form.get('job_id'),
        mediaType: file.type,
        bytes: Buffer.from(await file.arrayBuffer())
      });
      return new Response(JSON.stringify({ id: form.get('job_id'), status: 'running' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (/\/v1\/jobs\/agent3d_/.test(url) && !url.endsWith('/artifact')) {
      return new Response(JSON.stringify({
        status: 'succeeded',
        result: {
          artifact: {
            id: 'art-provider',
            role: 'primary-glb',
            mediaType: 'model/gltf-binary',
            bytes: glb.length,
            sha256: glbSha256,
            path: 'private/provider/path.glb',
            cache: { path: '/tmp/private-cache.glb' }
          },
          conditioning: {
            strategy: 'birefnet',
            engine: 'birefnet-general-lite',
            source_sha256: sourceSha256,
            canonical_sha256: 'c'.repeat(64),
            foreground_ratio: 0.28,
            path: 'conditioned-inputs/private.png'
          }
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/artifact')) {
      return new Response(glb, {
        status: 200,
        headers: {
          'content-type': 'model/gltf-binary',
          'x-artifact-id': 'art-provider',
          'x-artifact-sha256': glbSha256
        }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const adapter = createModal3DAdapter({
    endpoint: 'http://sidecar3d.test',
    token: 'local-3d-session',
    model: 'fastsam3d-plus-plus',
    profile: 'recommended',
    seed: 42,
    pollIntervalMs: 0,
    fetchImpl
  });
  const candidate = { id: 'img-1', mediaType: 'image/png', sha256: sourceSha256, data: source };
  const first = await adapter.generate3D({ candidate });
  const second = await adapter.generate3D({ candidate });
  assert.equal(submissions.length, 2);
  assert.equal(capabilityRequests, 1, 'capability preflight must be cached per adapter');
  assert.equal(submissions[0].jobId, submissions[1].jobId, 'same source request must reuse job identity');
  assert.equal(submissions[0].mediaType, 'image/png');
  assert.equal(submissions[0].bytes.equals(source), true, 'Sidecar source upload must preserve original bytes');
  assert.equal(first.id, 'art-provider');
  assert.equal(first.sha256, glbSha256);
  assert.equal(first.bytes, glb.length);
  assert.equal(first.data.equals(glb), true);
  assert.equal(first.conditioning.strategy, 'birefnet');
  assert.equal(first.conditioning.source_sha256, sourceSha256);
  assert.equal('path' in first, false, 'Provider-private artifact path must not escape the adapter');
  assert.equal('cache' in first, false, 'Sidecar-private cache metadata must not escape the adapter');
  assert.equal('path' in first.conditioning, false, 'Provider-private conditioning path must not escape the adapter');
});

test('modal-3D adapter fails closed on candidate digest mismatch', async () => {
  const adapter = createModal3DAdapter({ endpoint: 'http://sidecar3d.test', fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(
    () => adapter.generate3D({ candidate: { id: 'img', mediaType: 'image/png', sha256: '0'.repeat(64), data: Buffer.from('different') } }),
    /candidate digest mismatch/
  );
});

test('modal-3D adapter rejects corrupt GLB even when HTTP succeeds', async () => {
  const source = Buffer.from('image');
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const corrupt = Buffer.from('not-a-valid-glb');
  const corruptSha = createHash('sha256').update(corrupt).digest('hex');
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({
        models: [{ id: 'fastsam3d-plus-plus', status: 'enabled', profiles: [{ id: 'recommended' }] }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/v1/jobs') && init.method === 'POST') {
      return new Response(JSON.stringify({ status: 'running' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!url.endsWith('/artifact')) {
      return new Response(JSON.stringify({ status: 'succeeded', result: { artifact: {} } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(corrupt, { status: 200, headers: { 'x-artifact-sha256': corruptSha } });
  };
  const adapter = createModal3DAdapter({ endpoint: 'http://sidecar3d.test', pollIntervalMs: 0, fetchImpl });
  await assert.rejects(
    () => adapter.generate3D({ candidate: { id: 'img', mediaType: 'image/png', sha256: sourceSha256, data: source } }),
    /not a complete GLB|invalid GLB magic/
  );
});


test('modal-3D capability preflight rejects unavailable model and profile before job submit', async () => {
  const responses = {
    models: [{ id: 'fastsam3d-plus-plus', status: 'enabled', profiles: [{ id: 'recommended' }] }]
  };
  let jobRequests = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.endsWith('/v1/jobs') && init.method === 'POST') jobRequests += 1;
    throw new Error(`unexpected request: ${url}`);
  };

  const missingModel = createModal3DAdapter({
    endpoint: 'http://sidecar3d.test',
    model: 'missing-model',
    fetchImpl
  });
  await assert.rejects(() => missingModel.preflight(), (error) => error.code === 'capability_unavailable');

  const missingProfile = createModal3DAdapter({
    endpoint: 'http://sidecar3d.test',
    model: 'fastsam3d-plus-plus',
    profile: 'missing-profile',
    fetchImpl
  });
  await assert.rejects(() => missingProfile.preflight(), (error) => error.code === 'capability_unavailable');
  assert.equal(jobRequests, 0);
});
