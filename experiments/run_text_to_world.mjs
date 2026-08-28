import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as THREE from '../../AgentScape/node_modules/three/build/three.module.js';
import { createModal2DAdapter, createModal3DAdapter } from '../src/source_3d_asset.js';
import { runTextToWorld } from '../src/run_text_to_world.js';
import { createAssetModule } from '../../AgentScape/src/assets/createAssetModule.js';
import { AssetCompiler } from '../../AgentScape/src/compiler/AssetCompiler.js';
import { WorldRuntime } from '../../AgentScape/src/runtime/WorldRuntime.js';
import { SpatialSystem } from '../../AgentScape/src/runtime/systems/SpatialSystem.js';
import { NavigationSystem } from '../../AgentScape/src/runtime/systems/NavigationSystem.js';
import { LocomotionSystem } from '../../AgentScape/src/runtime/systems/LocomotionSystem.js';
import { InteractionSystem } from '../../AgentScape/src/runtime/systems/InteractionSystem.js';
import { SceneGraph } from '../../AgentScape/src/runtime/graph/SceneGraph.js';
import { CommandHistory } from '../../AgentScape/src/history/CommandHistory.js';
import { WorldValidator } from '../../AgentScape/src/validation/WorldValidator.js';
import { RepairEngine } from '../../AgentScape/src/validation/RepairEngine.js';
import { createCanonicalWorldPipeline } from '../../AgentScape/src/pipeline/createWorldPipeline.js';

const prompt = process.argv.slice(2).join(' ').trim()
  || 'a single glossy realistic red apple, centered, isolated object, clean neutral background, no text, no extra objects';
const token2D = process.env.AGENT_ONE_SHOT_2D_TOKEN;
const token3D = process.env.AGENT_ONE_SHOT_3D_TOKEN;
if (!token2D || !token3D) throw new Error('local Sidecar session tokens are required');

const resultDir = new URL('./results/', import.meta.url);
await mkdir(resultDir, { recursive: true });
const assetModule = createAssetModule();
const compiler = new AssetCompiler({ store: assetModule.compiledStore, version: 'agent-one-shot-e2e' });
assetModule.configurePublication({ getAssetCompiler: async () => compiler });

const shortId = (prefix, value) => `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;

async function publishGeneratedArtifact({ prompt: label, artifact, assetId }) {
  if (!Buffer.isBuffer(artifact.data)) throw new TypeError('generated artifact bytes are required');
  const sha256 = createHash('sha256').update(artifact.data).digest('hex');
  if (sha256 !== artifact.sha256) throw new Error('generated artifact digest mismatch before publication');
  const artifactId = shortId('artifact', sha256);
  const cacheKey = shortId('cache', sha256);
  const locationId = shortId('loc', sha256);
  const hash = `sha256:${sha256}`;
  const now = new Date().toISOString();

  assetModule.artifactRegistry.register({
    id: artifactId,
    role: 'primary-glb',
    type: 'asset-bundle',
    schema: { id: 'agentscape.artifact', version: '1' },
    displayName: label.slice(0, 120),
    mime: 'model/gltf-binary',
    format: 'glb',
    bytes: artifact.data.length,
    hash,
    producer: {
      jobId: artifact.jobId ?? shortId('job', sha256),
      provider: 'modal-3d',
      operation: 'modal-3d.asset.image_to_3d.v1',
      stage: 'generation',
      attempt: 1,
      model: { id: artifact.model ?? 'unknown', version: '1', revision: null }
    },
    lineage: { parents: [] },
    createdAt: now,
    retention: { class: 'project' },
    locations: []
  });
  const writer = assetModule.byteStore.begin({ artifactId, maxBytes: artifact.data.length });
  await writer.write(new Uint8Array(artifact.data));
  await writer.commit({ key: cacheKey, hash, mime: 'model/gltf-binary', bytes: artifact.data.length });
  assetModule.artifactRegistry.updateLocation(artifactId, {
    id: locationId,
    kind: 'local-cache',
    scope: 'application',
    state: 'available',
    verifiedAt: now,
    access: { kind: 'cache-key', key: cacheKey }
  });
  assetModule.artifactRegistry.verifyIntegrity(artifactId, {
    hash,
    bytes: artifact.data.length,
    mime: 'model/gltf-binary',
    verifiedAt: now,
    method: 'agent-one-shot-sha256-v1'
  });

  const published = await assetModule.publishAsset({ artifactId, assetId, label: label.slice(0, 120) });
  if (!['asset-ready', 'asset-provisional'].includes(published.status)) {
    throw Object.assign(new Error(`AgentScape rejected generated Asset: ${published.status}`), { code: 'asset_rejected' });
  }
  return {
    id: published.assetId,
    status: published.status,
    artifactId,
    admission: published.admission?.status ?? null,
    reasons: published.admission?.reasons ?? []
  };
}

async function createHeadlessRuntime() {
  globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.ProgressEvent ||= class ProgressEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  };
  const runtime = new WorldRuntime({ appendChild() {} }, { environmentFactory: null, assetModule });
  await runtime.physics.init();
  runtime.scene = new THREE.Scene();
  runtime.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 120);
  runtime.controls = { target: new THREE.Vector3(), update() {} };
  const ground = new THREE.Mesh(new THREE.BoxGeometry(12, 0.2, 12), new THREE.MeshBasicMaterial());
  ground.position.y = -0.1;
  ground.updateMatrixWorld(true);
  runtime.scene.add(ground);
  runtime.environment = {
    id: 'agent-one-shot-lab',
    root: ground,
    colliders: [{ shape: 'box', halfExtents: [6, 0.1, 6], translation: [0, -0.1, 0] }],
    layout: { bounds: { min: [-5, -5], max: [5, 5] }, groundY: 0, margin: 0.5 }
  };
  runtime.physics.addEnvironment(runtime.environment.colliders, { id: runtime.environment.id });
  runtime.spatial = new SpatialSystem({ store: runtime.store, scene: runtime.scene });
  runtime.sceneGraph = new SceneGraph({ store: runtime.store, spatial: runtime.spatial, events: runtime.events });
  runtime.history = new CommandHistory({ apply: (scene) => runtime.restore(scene), events: runtime.events });
  runtime.validator = new WorldValidator(runtime);
  runtime.repair = new RepairEngine(runtime);
  runtime.navigation = new NavigationSystem({ store: runtime.store, physics: runtime.physics, environmentRoots: [ground], events: runtime.events });
  runtime.locomotion = new LocomotionSystem({ store: runtime.store, physics: runtime.physics, navigation: runtime.navigation, events: runtime.events });
  runtime.interactions = new InteractionSystem({
    store: runtime.store,
    physics: runtime.physics,
    spatial: runtime.spatial,
    navigation: runtime.navigation,
    locomotion: runtime.locomotion,
    events: runtime.events
  });
  runtime.worldPipeline = createCanonicalWorldPipeline(runtime);
  return runtime;
}

async function buildVerifiedWorld({ prompt: description, asset, instanceId, support, actor }) {
  const runtime = await createHeadlessRuntime();
  try {
    const revisionId = shortId('world', `${asset.id}\0${instanceId}`);
    const worldIR = {
      schema: 'agentscape.world-ir',
      schemaVersion: 1,
      revision: { id: revisionId, reason: 'AgentScape-agent one-shot text-to-world execution' },
      provenance: {
        source: 'agentscape-agent-one-shot',
        createdBy: 'AgentScape-agent',
        evidenceRefs: [asset.artifactId].filter(Boolean)
      },
      intent: { name: 'One-shot Generated World', description },
      policy: { generation: { generate: false }, physics: { fallbackPolicy: 'deny' } },
      entities: [
        { id: actor.instanceId, asset: { assetId: actor.assetId }, capabilityIntent: [], initialState: {} },
        { id: support.instanceId, asset: { assetId: support.assetId }, capabilityIntent: [], initialState: {} },
        { id: instanceId, asset: { assetId: asset.id }, capabilityIntent: [], initialState: {} }
      ],
      spatial: {
        relations: [{ subject: instanceId, predicate: 'ON', object: support.instanceId, surfaceId: 'top' }],
        constraints: []
      },
      interactions: [],
      rules: [],
      acceptance: [{ id: 'generated-object-on-support', kind: 'relation-exists', subject: instanceId, predicate: 'ON', object: support.instanceId }]
    };
    const pipeline = await runtime.worldPipeline.run(worldIR);
    const admission = pipeline.state.reports.worldAdmission;
    for (let index = 0; index < 120; index += 1) runtime.physics.step(1 / 60, runtime.store);
    runtime.sceneGraph.update();
    const supportStatus = runtime.spatial.supportStatus(instanceId, support.instanceId, { surfaceId: 'top' });
    const relationAdmission = pipeline.state.reports.relationAdmission?.status ?? null;
    const verified = admission.status !== 'rejected'
      && relationAdmission === 'ready'
      && supportStatus.on === true
      && Boolean(runtime.store.get(instanceId));
    return {
      status: admission.status === 'ready' ? 'world-ready'
        : admission.status === 'provisional' ? 'world-provisional'
          : 'world-rejected',
      verified,
      admission: admission.status,
      reasons: admission.reasons ?? [],
      relationAdmission,
      relation: { subject: instanceId, predicate: 'ON', object: support.instanceId, verified: supportStatus.on === true },
      position: runtime.physics.getPosition(instanceId),
      objects: runtime.listObjects().map(({ id, assetId }) => ({ id, assetId }))
    };
  } finally {
    runtime.navigation?.dispose?.();
    runtime.physics?.dispose?.();
  }
}

const imageAdapter = createModal2DAdapter({
  endpoint: process.env.AGENT_ONE_SHOT_2D_ENDPOINT ?? 'http://127.0.0.1:3312',
  token: token2D,
  model: 'sana-sprint-1.6b',
  pollIntervalMs: 500
});
const model3DAdapter = createModal3DAdapter({
  endpoint: process.env.AGENT_ONE_SHOT_3D_ENDPOINT ?? 'http://127.0.0.1:3313',
  token: token3D,
  model: 'fastsam3d-plus-plus',
  profile: 'recommended',
  pollIntervalMs: 500
});

const startedAt = Date.now();
const result = await runTextToWorld(
  { prompt, candidateCount: 1 },
  {
    generateImages: imageAdapter.generateImages,
    evaluateImages: async ({ candidates }) => ({
      selectedId: candidates[0].id,
      reason: 'single-candidate deterministic automatic selection'
    }),
    generate3D: model3DAdapter.generate3D,
    publishAsset: publishGeneratedArtifact,
    buildWorld: buildVerifiedWorld
  }
);
const output = {
  status: result.status,
  stage: result.stage,
  elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
  request: result.request,
  source: {
    phase: result.source.state.phase,
    selectedId: result.source.state.selectedId,
    artifact: result.source.state.artifact,
    asset: result.source.state.asset
  },
  world: result.world
};
await writeFile(new URL('./results/latest.json', import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output));
if (result.status !== 'completed') process.exitCode = 1;
