import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createFileRunStore, runCheckpointedAgent } from '../src/runs.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, 'results', 'resume');
const runsDir = resolve(root, 'runs');
const sideEffectFile = resolve(root, 'side-effect.json');
const childResultFile = resolve(root, 'child-resume-result.json');
const finalResultFile = resolve(root, 'latest.json');
const runId = 'resume_probe';
const mode = process.argv[2] ?? 'parent';

function gatewayFor(modeName) {
  let calls = 0;
  return async ({ messages }) => {
    calls += 1;
    if (modeName === 'crash') {
      if (calls !== 1) throw new Error('crash phase must ask the model exactly once');
      return {
        message: '',
        toolCalls: [{ id: 'call-1', name: 'durable_probe', args: { value: 'apple' } }]
      };
    }
    const last = messages.at(-1);
    if (last?.role !== 'tool') {
      throw new Error('resume phase called the gateway before completing the pending tool');
    }
    return { message: 'resume completed', toolCalls: [] };
  };
}

async function childCrash() {
  await mkdir(root, { recursive: true });
  const store = createFileRunStore({ directory: runsDir });
  await runCheckpointedAgent({
    runId,
    store,
    task: 'verify cross-process tool resume',
    gateway: gatewayFor('crash'),
    tools: {
      durable_probe: {
        description: 'write one durable side effect',
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
        async execute(args, { executionId, recovered }) {
          assert.equal(recovered, false);
          await writeFile(sideEffectFile, `${JSON.stringify({ executionId, args, writtenAt: new Date().toISOString() }, null, 2)}\n`);
          process.exit(86);
        }
      }
    }
  });
  throw new Error('crash phase unexpectedly returned');
}

async function childResume() {
  const store = createFileRunStore({ directory: runsDir });
  const durable = JSON.parse(await readFile(sideEffectFile, 'utf8'));
  let toolExecutions = 0;
  const result = await runCheckpointedAgent({
    runId,
    store,
    task: 'verify cross-process tool resume',
    gateway: gatewayFor('resume'),
    tools: {
      durable_probe: {
        description: 'write one durable side effect',
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
        async execute(args, { executionId, recovered }) {
          toolExecutions += 1;
          assert.equal(recovered, true);
          assert.equal(executionId, durable.executionId);
          assert.deepEqual(args, durable.args);
          return {
            executionId,
            recovered,
            durableSideEffectAlreadyExists: true
          };
        }
      }
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.resumed, true);
  assert.equal(toolExecutions, 1);
  const recoveredTool = result.trace.find((entry) => entry.type === 'tool');
  assert.equal(recoveredTool.recovered, true);
  assert.equal(recoveredTool.executionId, durable.executionId);
  await writeFile(childResultFile, `${JSON.stringify(result, null, 2)}\n`);
}

async function parent() {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const script = fileURLToPath(import.meta.url);

  const crashStarted = performance.now();
  const crash = spawnSync(process.execPath, [script, 'crash'], { stdio: 'inherit' });
  const crashProcessMs = Number((performance.now() - crashStarted).toFixed(3));
  assert.equal(crash.status, 86, `crash child exit=${crash.status}`);

  const store = createFileRunStore({ directory: runsDir });
  const pending = await store.load(runId);
  assert.equal(pending.status, 'tool_pending');
  assert.equal(pending.phase, 'tools');
  assert.equal(pending.toolBatch.nextIndex, 0);
  assert.equal(pending.pendingTool.executionId, pending.toolBatch.calls[0].executionId);

  const resumeStarted = performance.now();
  const resumed = spawnSync(process.execPath, [script, 'resume'], { stdio: 'inherit' });
  const resumeProcessMs = Number((performance.now() - resumeStarted).toFixed(3));
  assert.equal(resumed.status, 0, `resume child exit=${resumed.status}`);

  const childResult = JSON.parse(await readFile(childResultFile, 'utf8'));
  const final = await store.load(runId);
  assert.equal(final.status, 'completed');
  const report = {
    experiment: 'cross-process-tool-resume-v1',
    status: 'passed',
    runId,
    crashExitCode: crash.status,
    crashProcessMs,
    resumeProcessMs,
    executionId: pending.pendingTool.executionId,
    checkpointAfterCrash: {
      status: pending.status,
      phase: pending.phase,
      step: pending.step,
      nextStep: pending.nextStep
    },
    finalStatus: final.status,
    timings: childResult.timings,
    recoveredTool: childResult.trace.find((entry) => entry.type === 'tool')
  };
  await writeFile(finalResultFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

if (mode === 'crash') await childCrash();
else if (mode === 'resume') await childResume();
else await parent();
