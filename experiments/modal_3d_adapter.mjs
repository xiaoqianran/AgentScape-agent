import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createModal3DAdapter } from '../src/source_3d_asset.js';

const sourcePath = resolve(process.env.AGENTSCAPE_AGENT_3D_SOURCE ?? 'results/source_3d_asset/candidate-1.png');
const source = await readFile(sourcePath);
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const adapter = createModal3DAdapter({
  endpoint: process.env.AGENTSCAPE_MODAL_3D_ENDPOINT ?? 'http://127.0.0.1:3213',
  token: process.env.MODAL_3D_AGENT_TOKEN,
  model: process.env.AGENTSCAPE_MODAL_3D_MODEL ?? 'fastsam3d-plus-plus',
  profile: process.env.AGENTSCAPE_MODAL_3D_PROFILE ?? 'recommended',
  seed: Number(process.env.AGENTSCAPE_MODAL_3D_SEED ?? 42),
  pollIntervalMs: 1500,
  timeoutMs: 20 * 60 * 1000
});

const started = Date.now();
const artifact = await adapter.generate3D({
  candidate: {
    id: 'experiment-source',
    mediaType: 'image/png',
    sha256: sourceSha256,
    data: source
  }
});
const { data: _data, ...publicArtifact } = artifact;
const report = {
  experiment: 'modal-3d-adapter-real-v1',
  status: 'passed',
  elapsedMs: Date.now() - started,
  source: {
    file: sourcePath,
    bytes: source.length,
    sha256: sourceSha256
  },
  artifact: publicArtifact
};
const outputDir = resolve('results/modal_3d_adapter');
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
