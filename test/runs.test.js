import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRunStore, runCheckpointedAgent } from '../src/runs.js';

test('file run store writes atomic private JSON checkpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentscape-agent-runs-'));
  const store = createFileRunStore({ directory });
  await store.save('run_1', { status: 'running', step: 2, trace: [{ type: 'tool' }] });
  const loaded = await store.load('run_1');
  assert.equal(loaded.version, 1);
  assert.equal(loaded.runId, 'run_1');
  assert.equal(loaded.status, 'running');
  assert.equal(loaded.step, 2);
  const file = join(directory, 'run_1.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, 'utf8')).includes('"runId": "run_1"'), true);
});

test('checkpointed agent persists tool observation and terminal result', async () => {
  const snapshots = [];
  const store = { async save(runId, snapshot) { snapshots.push({ runId, ...structuredClone(snapshot) }); } };
  let gatewayStep = 0;
  const result = await runCheckpointedAgent({
    runId: 'run_checkpoint',
    store,
    task: 'make an apple',
    tools: {
      source_3d_asset: {
        description: 'source a 3D asset',
        parameters: { type: 'object' },
        async execute() { return { assetId: 'asset-1' }; }
      }
    },
    gateway: async ({ messages }) => {
      gatewayStep += 1;
      if (gatewayStep === 1) return { message: '', toolCalls: [{ id: 'call-1', name: 'source_3d_asset', args: {} }] };
      assert.match(messages.at(-1).content, /asset-1/);
      return { message: 'done', toolCalls: [] };
    }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.runId, 'run_checkpoint');
  assert.deepEqual(snapshots.map(({ status }) => status), ['created', 'running', 'completed']);
  assert.equal(snapshots[1].trace[0].type, 'tool');
  assert.equal(snapshots[2].trace.at(-1).type, 'final');
});

test('checkpoint failure stops the agent before another model step', async () => {
  let gatewayCalls = 0;
  let saves = 0;
  const store = {
    async save() {
      saves += 1;
      if (saves === 2) throw new Error('disk unavailable');
    }
  };
  await assert.rejects(
    () => runCheckpointedAgent({
      runId: 'run_failclosed',
      store,
      task: 'make an apple',
      tools: {
        source_3d_asset: {
          description: 'source a 3D asset',
          async execute() { return { assetId: 'asset-1' }; }
        }
      },
      gateway: async () => {
        gatewayCalls += 1;
        return { message: '', toolCalls: [{ id: 'call-1', name: 'source_3d_asset', args: {} }] };
      }
    }),
    /disk unavailable/
  );
  assert.equal(gatewayCalls, 1, 'agent must not continue after durable checkpoint failure');
});

test('file run store rejects path-like run ids', async () => {
  const store = createFileRunStore({ directory: '/tmp/agentscape-agent-run-id-test' });
  await assert.rejects(() => store.save('../escape', { status: 'bad' }), /runId must match/);
});
