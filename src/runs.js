import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runAgent } from './agent.js';

function requireRunId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError('runId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}');
  }
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createFileRunStore({ directory = './data/runs' } = {}) {
  const root = resolve(directory);

  function pathFor(runId) {
    return join(root, `${requireRunId(runId)}.json`);
  }

  return {
    async save(runId, snapshot) {
      const id = requireRunId(runId);
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new TypeError('snapshot must be an object');
      }
      await mkdir(root, { recursive: true });
      const record = { version: 1, runId: id, ...cloneJson(snapshot) };
      const target = pathFor(id);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, target);
      return cloneJson(record);
    },

    async load(runId) {
      try {
        const record = JSON.parse(await readFile(pathFor(runId), 'utf8'));
        if (record?.version !== 1 || record?.runId !== runId) throw new Error(`invalid Agent Run checkpoint: ${runId}`);
        return record;
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    }
  };
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'cancelled', 'max_steps_exceeded']);

function terminalResult(runId, record) {
  return {
    runId,
    resumed: true,
    status: record.status,
    message: record.message ?? '',
    steps: Number(record.step ?? 0),
    trace: Array.isArray(record.trace) ? record.trace : [],
    timings: Array.isArray(record.timings) ? record.timings : []
  };
}

export async function runCheckpointedAgent({ runId = `run_${randomUUID()}`, store, ...options } = {}) {
  if (!store || typeof store.save !== 'function') throw new TypeError('store.save is required');
  if (store.load != null && typeof store.load !== 'function') throw new TypeError('store.load must be a function');
  const id = requireRunId(runId);
  const initialTimings = [];
  let existing = null;
  if (typeof store.load === 'function') {
    const started = performance.now();
    existing = await store.load(id);
    initialTimings.push({ kind: 'run_store_load', durationMs: Number((performance.now() - started).toFixed(3)), found: Boolean(existing) });
  }

  if (existing) {
    if (options.task != null && existing.task != null && options.task !== existing.task) {
      throw new Error(`Agent Run task mismatch for ${id}`);
    }
    if (TERMINAL_RUN_STATUSES.has(existing.status)) return terminalResult(id, existing);
  } else {
    const started = performance.now();
    await store.save(id, {
      status: 'created',
      phase: 'gateway',
      task: options.task,
      step: 0,
      nextStep: 1,
      messages: [],
      trace: [],
      timings: []
    });
    initialTimings.push({ kind: 'run_store_save_created', durationMs: Number((performance.now() - started).toFixed(3)) });
  }

  const result = await runAgent({
    ...options,
    task: options.task ?? existing?.task,
    resume: existing,
    executionScope: id,
    initialTimings,
    checkpoint: (snapshot) => store.save(id, snapshot)
  });
  return { runId: id, resumed: Boolean(existing), ...result };
}
