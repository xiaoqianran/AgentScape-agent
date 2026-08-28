import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  decideTextToWorldCompletion,
  normalizeTextToWorldRequest,
  runTextToWorld
} from '../src/run_text_to_world.js';

function fixture(overrides = {}) {
  const image = Buffer.from('candidate-image');
  const glb = Buffer.concat([
    Buffer.from('glTF'),
    Buffer.from([2, 0, 0, 0]),
    Buffer.from([16, 0, 0, 0]),
    Buffer.alloc(4)
  ]);
  return {
    generateImages: async () => [{
      id: 'image_01', mediaType: 'image/png', bytes: image.length,
      sha256: createHash('sha256').update(image).digest('hex'), data: image
    }],
    evaluateImages: async () => ({ selectedId: 'image_01', reason: 'best silhouette' }),
    generate3D: async () => ({
      id: 'artifact_01', mediaType: 'model/gltf-binary', bytes: glb.length,
      sha256: createHash('sha256').update(glb).digest('hex'), data: glb
    }),
    publishAsset: async ({ assetId }) => ({ id: assetId, status: 'asset-provisional' }),
    buildWorld: async ({ asset, instanceId, support }) => ({
      status: 'world-provisional', verified: true, assetId: asset.id, instanceId,
      relation: { subject: instanceId, predicate: 'ON', object: support.instanceId, verified: true }
    }),
    ...overrides
  };
}

test('normalizes deterministic one-shot identities', () => {
  const first = normalizeTextToWorldRequest({ prompt: '  glossy red apple  ' });
  const second = normalizeTextToWorldRequest({ prompt: 'glossy red apple' });
  assert.equal(first.prompt, 'glossy red apple');
  assert.equal(first.assetId, second.assetId);
  assert.equal(first.instanceId, second.instanceId);
  assert.match(first.assetId, /^asset_[0-9a-f]{20}$/);
  assert.match(first.instanceId, /^object_[0-9a-f]{20}$/);
});

test('runs source asset then verified world in one call', async () => {
  const calls = [];
  const result = await runTextToWorld(
    { prompt: 'a glossy red apple', candidateCount: 1 },
    fixture({
      publishAsset: async ({ artifact, assetId }) => {
        calls.push(['publish', artifact.id, assetId]);
        return { id: assetId, status: 'asset-provisional' };
      },
      buildWorld: async ({ asset, instanceId, support }) => {
        calls.push(['world', asset.id, instanceId]);
        return {
          status: 'world-provisional', verified: true,
          relation: { subject: instanceId, predicate: 'ON', object: support.instanceId, verified: true }
        };
      }
    })
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.stage, 'verified');
  assert.equal(result.source.state.phase, 'done');
  assert.equal(result.world.verified, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['publish', 'world']);
  assert.equal(calls[0][2], result.request.assetId);
  assert.equal(calls[1][1], result.request.assetId);
});

test('does not build a world when source_3d_asset fails', async () => {
  let worldCalls = 0;
  const result = await runTextToWorld(
    { prompt: 'red apple', candidateCount: 1 },
    fixture({
      generateImages: async () => [],
      buildWorld: async () => { worldCalls += 1; return { status: 'world-ready', verified: true }; }
    })
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'source_3d_asset');
  assert.equal(worldCalls, 0);
});

test('fails closed when world is not verified', async () => {
  const result = await runTextToWorld(
    { prompt: 'red apple', candidateCount: 1 },
    fixture({ buildWorld: async () => ({ status: 'world-provisional', verified: false }) })
  );
  assert.deepEqual(decideTextToWorldCompletion(result.source, result.world), {
    status: 'failed', stage: 'world',
    error: { code: 'world_not_verified', message: 'world did not verify: world-provisional' }
  });
  assert.equal(result.status, 'failed');
});
