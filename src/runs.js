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

export async function runCheckpointedAgent({ runId = `run_${randomUUID()}`, store, ...options } = {}) {
  if (!store || typeof store.save !== 'function') throw new TypeError('store.save is required');
  const id = requireRunId(runId);
  await store.save(id, {
    status: 'created',
    task: options.task,
    step: 0,
    messages: [],
    trace: []
  });
  const result = await runAgent({
    ...options,
    checkpoint: (snapshot) => store.save(id, snapshot)
  });
  return { runId: id, ...result };
}
