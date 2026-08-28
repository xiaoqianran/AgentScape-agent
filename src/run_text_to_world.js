import { createHash } from 'node:crypto';
import { runSource3DAsset } from './source_3d_asset.js';

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function stableId(prefix, text) {
  return `${prefix}_${createHash('sha256').update(text).digest('hex').slice(0, 20)}`;
}

export function normalizeTextToWorldRequest({
  prompt,
  candidateCount = 4,
  assetId,
  instanceId,
  supportAssetId = 'table',
  supportInstanceId = 'table_01',
  actorAssetId = 'agent',
  actorInstanceId = 'agent_01'
} = {}) {
  const normalizedPrompt = requireText(prompt, 'prompt');
  return {
    prompt: normalizedPrompt,
    candidateCount,
    assetId: assetId ?? stableId('asset', normalizedPrompt),
    instanceId: instanceId ?? stableId('object', normalizedPrompt),
    supportAssetId: requireText(supportAssetId, 'supportAssetId'),
    supportInstanceId: requireText(supportInstanceId, 'supportInstanceId'),
    actorAssetId: requireText(actorAssetId, 'actorAssetId'),
    actorInstanceId: requireText(actorInstanceId, 'actorInstanceId')
  };
}

export function decideTextToWorldCompletion(sourceResult, worldResult) {
  if (sourceResult?.state?.phase !== 'done') {
    return {
      status: 'failed',
      stage: 'source_3d_asset',
      error: sourceResult?.state?.error ?? {
        code: 'source_3d_asset_incomplete',
        message: 'source_3d_asset did not complete'
      }
    };
  }
  if (!worldResult || typeof worldResult !== 'object') {
    return {
      status: 'failed',
      stage: 'world',
      error: { code: 'world_result_invalid', message: 'buildWorld returned no result' }
    };
  }
  if (worldResult.status === 'world-rejected' || worldResult.verified !== true) {
    return {
      status: 'failed',
      stage: 'world',
      error: {
        code: worldResult.error?.code ?? 'world_not_verified',
        message: worldResult.error?.message ?? `world did not verify: ${worldResult.status ?? 'unknown'}`
      }
    };
  }
  return { status: 'completed', stage: 'verified' };
}

export async function runTextToWorld(request, deps = {}) {
  if (typeof deps.buildWorld !== 'function') throw new TypeError('deps.buildWorld is required');
  const totalStarted = performance.now();
  const startedAt = new Date().toISOString();
  const normalized = normalizeTextToWorldRequest(request);
  const source = await runSource3DAsset(
    { prompt: normalized.prompt, candidateCount: normalized.candidateCount },
    {
      ...deps,
      publishAsset: ({ prompt, artifact, executionId }) => deps.publishAsset({
        prompt,
        artifact,
        assetId: normalized.assetId,
        executionId
      })
    },
    { executionId: deps.executionId }
  );

  const sourceTimings = source.trace
    .filter(({ durationMs }) => Number.isFinite(durationMs))
    .map(({ phase, effects, startedAt: stageStartedAt, finishedAt, durationMs }) => ({
      phase,
      effect: effects?.[0] ?? null,
      startedAt: stageStartedAt,
      finishedAt,
      durationMs
    }));

  if (source.state.phase !== 'done') {
    return {
      ...decideTextToWorldCompletion(source, null),
      request: normalized,
      source,
      world: null,
      timings: {
        startedAt,
        source: sourceTimings,
        worldMs: 0,
        totalMs: Number((performance.now() - totalStarted).toFixed(3))
      }
    };
  }

  let world;
  const worldStarted = performance.now();
  try {
    world = await deps.buildWorld({
      prompt: normalized.prompt,
      asset: source.state.asset,
      artifact: source.state.artifact,
      instanceId: normalized.instanceId,
      support: {
        assetId: normalized.supportAssetId,
        instanceId: normalized.supportInstanceId
      },
      actor: {
        assetId: normalized.actorAssetId,
        instanceId: normalized.actorInstanceId
      },
      executionId: deps.executionId
    });
  } catch (error) {
    world = {
      status: 'world-rejected',
      verified: false,
      error: {
        code: error?.code ?? 'world_effect_failed',
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
  const worldMs = Number((performance.now() - worldStarted).toFixed(3));

  return {
    ...decideTextToWorldCompletion(source, world),
    request: normalized,
    source,
    world,
    timings: {
      startedAt,
      source: sourceTimings,
      worldMs,
      totalMs: Number((performance.now() - totalStarted).toFixed(3))
    }
  };
}
