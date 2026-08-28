import { createHash, randomUUID } from 'node:crypto';

const TERMINAL_PHASES = new Set(['done', 'failed', 'cancelled']);
const EFFECT = Object.freeze({
  GENERATE_IMAGES: 'generate_images',
  EVALUATE_IMAGES: 'evaluate_images',
  GENERATE_3D: 'generate_3d',
  PUBLISH_ASSET: 'publish_asset'
});

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function summarizeCandidate(candidate) {
  return {
    id: requireText(candidate.id, 'candidate.id'),
    jobId: candidate.jobId ?? null,
    mediaType: candidate.mediaType ?? 'image/png',
    bytes: Number(candidate.bytes ?? candidate.data?.byteLength ?? 0),
    sha256: requireText(candidate.sha256, 'candidate.sha256'),
    model: candidate.model ?? null,
    seed: candidate.seed ?? null,
    timing: candidate.timing ? { ...candidate.timing } : null
  };
}

function summarizeArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') throw new TypeError('3D artifact is required');
  return {
    id: requireText(artifact.id, 'artifact.id'),
    mediaType: requireText(artifact.mediaType ?? artifact.mime, 'artifact.mediaType'),
    bytes: Number(artifact.bytes ?? 0),
    sha256: requireText(artifact.sha256, 'artifact.sha256'),
    timing: artifact.timing ? { ...artifact.timing } : null
  };
}

export function initialSource3DAssetState({ prompt, candidateCount = 4 } = {}) {
  const count = Number(candidateCount);
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new RangeError('candidateCount must be an integer between 1 and 8');
  }
  return {
    phase: 'idle',
    prompt: requireText(prompt, 'prompt'),
    candidateCount: count,
    candidates: [],
    selectedId: null,
    evaluation: null,
    artifact: null,
    asset: null,
    error: null,
    cancellation: null
  };
}

export function decideSource3DAsset(state, event) {
  if (!state || typeof state !== 'object') throw new TypeError('state is required');
  if (!event || typeof event.type !== 'string') throw new TypeError('event.type is required');
  if (TERMINAL_PHASES.has(state.phase)) return { state, effects: [] };

  switch (event.type) {
    case 'started':
      if (state.phase !== 'idle') throw new Error(`started is invalid during ${state.phase}`);
      return {
        state: { ...state, phase: 'generating_images' },
        effects: [{ type: EFFECT.GENERATE_IMAGES, prompt: state.prompt, count: state.candidateCount }]
      };

    case 'images_generated': {
      if (state.phase !== 'generating_images') throw new Error(`images_generated is invalid during ${state.phase}`);
      if (!Array.isArray(event.candidates) || event.candidates.length === 0) throw new Error('image generation returned no candidates');
      const candidates = event.candidates.map(summarizeCandidate);
      return {
        state: { ...state, phase: 'evaluating_images', candidates },
        effects: [{ type: EFFECT.EVALUATE_IMAGES, prompt: state.prompt, candidateIds: candidates.map(({ id }) => id) }]
      };
    }

    case 'candidate_selected': {
      if (state.phase !== 'evaluating_images') throw new Error(`candidate_selected is invalid during ${state.phase}`);
      const selectedId = requireText(event.selectedId, 'selectedId');
      if (!state.candidates.some(({ id }) => id === selectedId)) throw new Error(`unknown selected candidate: ${selectedId}`);
      return {
        state: {
          ...state,
          phase: 'generating_3d',
          selectedId,
          evaluation: event.evaluation && typeof event.evaluation === 'object'
            ? {
                reason: String(event.evaluation.reason ?? ''),
                timing: event.evaluation.timing ? { ...event.evaluation.timing } : null
              }
            : null
        },
        effects: [{ type: EFFECT.GENERATE_3D, prompt: state.prompt, candidateId: selectedId }]
      };
    }

    case 'three_d_generated': {
      if (state.phase !== 'generating_3d') throw new Error(`three_d_generated is invalid during ${state.phase}`);
      const artifact = summarizeArtifact(event.artifact);
      return {
        state: { ...state, phase: 'publishing_asset', artifact },
        effects: [{ type: EFFECT.PUBLISH_ASSET, prompt: state.prompt, artifactId: artifact.id }]
      };
    }

    case 'asset_published':
      if (state.phase !== 'publishing_asset') throw new Error(`asset_published is invalid during ${state.phase}`);
      if (!event.asset || typeof event.asset !== 'object' || !event.asset.id) throw new Error('published asset is invalid');
      return { state: { ...state, phase: 'done', asset: { ...event.asset }, error: null }, effects: [] };

    case 'failed':
      return {
        state: {
          ...state,
          phase: 'failed',
          error: {
            code: event.code ?? 'workflow_failed',
            message: requireText(event.message, 'failure message'),
            retryable: Boolean(event.retryable)
          },
          cancellation: null
        },
        effects: []
      };

    case 'cancelled':
      return {
        state: {
          ...state,
          phase: 'cancelled',
          error: null,
          cancellation: {
            code: 'workflow_cancelled',
            message: requireText(event.message ?? 'workflow cancelled', 'cancellation message')
          }
        },
        effects: []
      };

    default:
      throw new Error(`unknown source_3d_asset event: ${event.type}`);
  }
}

export async function runSource3DAsset(request, deps, { signal, executionId } = {}) {
  const required = ['generateImages', 'evaluateImages', 'generate3D', 'publishAsset'];
  for (const name of required) if (typeof deps?.[name] !== 'function') throw new TypeError(`deps.${name} is required`);

  let state = initialSource3DAssetState(request);
  let event = signal?.aborted
    ? { type: 'cancelled', message: cancellationMessage(signal) }
    : { type: 'started' };
  const resources = new Map();
  const trace = [];

  while (!TERMINAL_PHASES.has(state.phase)) {
    let transition;
    try {
      transition = decideSource3DAsset(state, event);
    } catch (error) {
      const failedEvent = {
        type: 'failed',
        code: error?.code ?? 'workflow_invariant_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      };
      transition = decideSource3DAsset(state, failedEvent);
      state = transition.state;
      trace.push({
        event: failedEvent.type,
        causedBy: event.type,
        phase: state.phase,
        effects: [],
        code: failedEvent.code
      });
      break;
    }

    state = transition.state;
    trace.push({ event: event.type, phase: state.phase, effects: transition.effects.map(({ type }) => type) });
    if (transition.effects.length === 0) break;
    if (transition.effects.length !== 1) {
      event = {
        type: 'failed',
        code: 'workflow_invariant_failed',
        message: 'source_3d_asset currently requires one effect per transition',
        retryable: false
      };
      continue;
    }

    const effectStartedAt = new Date().toISOString();
    const effectStarted = performance.now();
    try {
      event = await executeEffect(transition.effects[0], state, resources, deps, signal, executionId);
      const durationMs = Number((performance.now() - effectStarted).toFixed(3));
      Object.assign(trace.at(-1), {
        startedAt: effectStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs
      });
    } catch (error) {
      const durationMs = Number((performance.now() - effectStarted).toFixed(3));
      Object.assign(trace.at(-1), {
        startedAt: effectStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs
      });
      event = signal?.aborted || error?.code === 'workflow_cancelled' || error?.name === 'AbortError'
        ? { type: 'cancelled', message: error?.message ?? cancellationMessage(signal) }
        : {
            type: 'failed',
            code: error?.code ?? 'effect_failed',
            message: error instanceof Error ? error.message : String(error),
            retryable: Boolean(error?.retryable)
          };
    }
  }

  return { state, trace };
}

async function executeEffect(effect, state, resources, deps, signal, executionId) {
  throwIfCancelled(signal);
  switch (effect.type) {
    case EFFECT.GENERATE_IMAGES: {
      const candidates = await deps.generateImages({ prompt: effect.prompt, count: effect.count, signal, executionId });
      for (const candidate of candidates) resources.set(candidate.id, candidate);
      return { type: 'images_generated', candidates };
    }
    case EFFECT.EVALUATE_IMAGES: {
      const candidates = effect.candidateIds.map((id) => resources.get(id));
      if (candidates.some((candidate) => !candidate)) throw new Error('candidate payload is unavailable');
      const decision = await deps.evaluateImages({ prompt: effect.prompt, candidates, signal, executionId });
      return { type: 'candidate_selected', selectedId: decision.selectedId, evaluation: decision };
    }
    case EFFECT.GENERATE_3D: {
      const candidate = resources.get(effect.candidateId);
      if (!candidate) throw new Error(`candidate payload is unavailable: ${effect.candidateId}`);
      const artifact = await deps.generate3D({ prompt: effect.prompt, candidate, signal, executionId });
      resources.set(artifact.id, artifact);
      return { type: 'three_d_generated', artifact };
    }
    case EFFECT.PUBLISH_ASSET: {
      const artifact = resources.get(effect.artifactId);
      if (!artifact) throw new Error(`artifact payload is unavailable: ${effect.artifactId}`);
      return { type: 'asset_published', asset: await deps.publishAsset({ prompt: effect.prompt, artifact, signal, executionId }) };
    }
    default:
      throw new Error(`unknown effect: ${effect.type}`);
  }
}

function cancellationMessage(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  return 'workflow cancelled';
}

function cancellationError(signal) {
  const error = new Error(cancellationMessage(signal));
  error.code = 'workflow_cancelled';
  error.retryable = false;
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError(signal);
}

function delayOrCancel(ms, signal) {
  if (!ms) {
    throwIfCancelled(signal);
    return Promise.resolve();
  }
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancellationError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function requestHeaders(token, extra = {}) {
  return token ? { ...extra, 'X-Modal-2D-Session': token } : extra;
}

async function jsonRequest(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${payload.detail ?? payload.error ?? response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function existingJob(fetchImpl, url, init) {
  const response = await fetchImpl(url, init);
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${payload.detail ?? payload.error ?? response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function elapsedMs(started) {
  return Number((performance.now() - started).toFixed(3));
}

async function cancelSidecarJob(fetchImpl, base, jobId, headers) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetchImpl(`${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers
      });
      if (response.status === 404 && attempt < 19) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`cancel ${jobId} failed with HTTP ${response.status}: ${payload.detail ?? response.statusText}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < 19) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
    }
  }
  throw lastError ?? new Error(`cancel ${jobId} failed`);
}

async function cancelAfterAbort(fetchImpl, base, jobId, headers, signal) {
  try {
    await cancelSidecarJob(fetchImpl, base, jobId, headers);
  } catch (error) {
    const cancelled = cancellationError(signal);
    cancelled.cancelError = error instanceof Error ? error.message : String(error);
    throw cancelled;
  }
  throw cancellationError(signal);
}

function profileIds(model) {
  if (!Array.isArray(model?.profiles)) return [];
  return model.profiles
    .map((profile) => typeof profile === 'string' ? profile : profile?.id)
    .filter((id) => typeof id === 'string' && id);
}

function createCapabilityPreflight({ base, headers, model, profile, providerName, fetchImpl }) {
  let cached;
  return async function preflight(signal) {
    if (!cached) {
      cached = (async () => {
        const payload = await jsonRequest(fetchImpl, `${base}/v1/models`, { headers, signal });
        if (!Array.isArray(payload.models)) throw new Error(`${providerName} model capability response is invalid`);
        const selected = payload.models.find((candidate) => candidate?.id === model);
        if (!selected) {
          const error = new Error(`${providerName} model is unavailable: ${model}`);
          error.code = 'capability_unavailable';
          throw error;
        }
        if (selected.status && selected.status !== 'enabled') {
          const error = new Error(`${providerName} model is not enabled: ${model}`);
          error.code = 'capability_unavailable';
          throw error;
        }
        const profiles = profileIds(selected);
        if (profile && !profiles.includes(profile)) {
          const error = new Error(`${providerName} profile is unavailable: ${model}/${profile}`);
          error.code = 'capability_unavailable';
          throw error;
        }
        return {
          model,
          profile: profile ?? null,
          status: selected.status ?? 'available',
          profiles
        };
      })().catch((error) => {
        cached = undefined;
        throw error;
      });
    }
    return cached;
  };
}

export function createModal2DAdapter({
  endpoint = 'http://127.0.0.1:3212',
  token,
  model = 'sana-sprint-1.6b',
  baseSeed = 42,
  pollIntervalMs = 1000,
  timeoutMs = 10 * 60 * 1000,
  fetchImpl = fetch
} = {}) {
  const base = String(endpoint).replace(/\/$/, '');
  const preflight = createCapabilityPreflight({
    base,
    headers: requestHeaders(token),
    model,
    providerName: 'modal-2D',
    fetchImpl
  });

  async function wait(jobId, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) await cancelAfterAbort(fetchImpl, base, jobId, requestHeaders(token), signal);
      let state;
      try {
        state = await jsonRequest(fetchImpl, `${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
          headers: requestHeaders(token),
          signal
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') await cancelAfterAbort(fetchImpl, base, jobId, requestHeaders(token), signal);
        throw error;
      }
      if (state.status === 'succeeded') return state;
      if (['failed', 'cancelled', 'expired'].includes(state.status)) {
        const error = new Error(`modal-2D job ${jobId} ended as ${state.status}`);
        error.code = state.error_code ?? `image_${state.status}`;
        throw error;
      }
      try {
        await delayOrCancel(pollIntervalMs, signal);
      } catch (error) {
        if (error?.code === 'workflow_cancelled') await cancelAfterAbort(fetchImpl, base, jobId, requestHeaders(token), signal);
        throw error;
      }
    }
    const error = new Error(`modal-2D job ${jobId} timed out`);
    error.code = 'image_timeout';
    error.retryable = true;
    throw error;
  }

  async function fetchBatchArtifact(jobId, index, seed, sharedTiming, providerItem, signal) {
    const artifactStarted = performance.now();
    const response = await fetchImpl(
      `${base}/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${index}`,
      { headers: requestHeaders(token), signal }
    );
    if (!response.ok) throw new Error(`modal-2D batch artifact ${jobId}/${index} failed with HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    const artifactFetchMs = elapsedMs(artifactStarted);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const expected = response.headers.get('x-artifact-sha256');
    if (expected && expected !== sha256) throw new Error(`modal-2D artifact digest mismatch for ${jobId}/${index}`);
    return {
      id: response.headers.get('x-artifact-id') ?? `${jobId}_${index}`,
      jobId,
      mediaType: response.headers.get('content-type')?.split(';')[0] ?? 'image/png',
      bytes: data.length,
      sha256,
      timing: {
        ...sharedTiming,
        artifactFetchMs,
        providerBatch: sharedTiming.providerBatch ?? null,
        providerItem: providerItem ?? null
      },
      model,
      seed,
      data
    };
  }

  async function generateBatch(prompt, seeds, runScope, signal) {
    const totalStarted = performance.now();
    throwIfCancelled(signal);
    const preflightStarted = performance.now();
    await preflight(signal);
    const preflightMs = elapsedMs(preflightStarted);
    const identity = createHash('sha256')
      .update(`${runScope}\0${model}\0${seeds.join(',')}\0${prompt}`)
      .digest('hex')
      .slice(0, 24);
    const jobId = `agent2d_${identity}`;
    const lookupStarted = performance.now();
    let state = await existingJob(fetchImpl, `${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: requestHeaders(token), signal
    });
    const lookupMs = elapsedMs(lookupStarted);
    let submitMs = 0;
    const reusedJob = Boolean(state);
    if (!state) {
      const submitStarted = performance.now();
      try {
        state = await jsonRequest(fetchImpl, `${base}/v1/jobs`, {
          method: 'POST',
          headers: requestHeaders(token, { 'content-type': 'application/json' }),
          body: JSON.stringify({ prompt, model, seeds, job_id: jobId }),
          signal
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') await cancelAfterAbort(fetchImpl, base, jobId, requestHeaders(token), signal);
        throw error;
      }
      submitMs = elapsedMs(submitStarted);
    }
    const waitStarted = performance.now();
    state = await wait(jobId, signal);
    const waitMs = elapsedMs(waitStarted);
    throwIfCancelled(signal);
    const result = state?.result;
    const descriptors = Array.isArray(result?.artifacts) ? result.artifacts : [];
    if (descriptors.length !== seeds.length) {
      throw new Error(`modal-2D batch returned ${descriptors.length} artifacts for ${seeds.length} seeds`);
    }
    const providerTiming = result?.timing && typeof result.timing === 'object' ? result.timing : null;
    const providerItems = Array.isArray(providerTiming?.items) ? providerTiming.items : [];
    const sharedTiming = {
      preflightMs,
      lookupMs,
      submitMs,
      waitMs,
      totalMs: elapsedMs(totalStarted),
      reusedJob,
      providerBatch: providerTiming
        ? {
            workerReused: providerTiming.worker_reused ?? null,
            workerLoadMs: providerTiming.worker_load_ms ?? null,
            batchTotalMs: providerTiming.batch_total_ms ?? null
          }
        : null
    };
    return Promise.all(seeds.map((seed, index) =>
      fetchBatchArtifact(jobId, index, seed, sharedTiming, providerItems[index] ?? null, signal)
    ));
  }

  return {
    preflight,
    async generateImages({ prompt, count = 4, signal, executionId }) {
      const normalized = requireText(prompt, 'prompt');
      throwIfCancelled(signal);
      const runScope = executionId ?? randomUUID();
      const seeds = Array.from({ length: count }, (_, index) => baseSeed + index * 31);
      return generateBatch(normalized, seeds, runScope, signal);
    }
  };
}

function parseJsonContent(content) {
  const text = requireText(content, 'VLM response');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

export function createOpenAICompatibleVisionRanker({ baseUrl, apiKey, model, fetchImpl = fetch } = {}) {
  const endpoint = requireText(baseUrl, 'baseUrl').replace(/\/$/, '');
  const key = requireText(apiKey, 'apiKey');
  const modelName = requireText(model, 'model');

  return {
    async evaluateImages({ prompt, candidates, signal }) {
      const started = performance.now();
      throwIfCancelled(signal);
      if (!Array.isArray(candidates) || candidates.length === 0) throw new TypeError('candidates are required');
      const content = [{
        type: 'text',
        text: `Select the single best image for later image-to-3D reconstruction. User intent: ${prompt}\nJudge subject completeness, silhouette clarity, single-object composition, visual fidelity, and absence of text/extra objects. Return JSON only: {"selectedId":"...","reason":"..."}. Candidate ids follow each label.`
      }];
      for (const candidate of candidates) {
        content.push({ type: 'text', text: `Candidate id: ${candidate.id}` });
        content.push({
          type: 'image_url',
          image_url: { url: `data:${candidate.mediaType};base64,${Buffer.from(candidate.data).toString('base64')}` }
        });
      }
      const response = await fetchImpl(`${endpoint}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: modelName,
          temperature: 0,
          stream: false,
          messages: [
            { role: 'system', content: 'You are an image candidate evaluator for a 3D asset generation pipeline.' },
            { role: 'user', content }
          ]
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`VLM request failed with HTTP ${response.status}: ${payload.error?.message ?? response.statusText}`);
      const decision = parseJsonContent(payload.choices?.[0]?.message?.content);
      if (!candidates.some(({ id }) => id === decision.selectedId)) throw new Error(`VLM selected unknown candidate: ${decision.selectedId}`);
      return { selectedId: decision.selectedId, reason: String(decision.reason ?? ''), timing: { totalMs: elapsedMs(started) } };
    }
  };
}

export function createSource3DAssetTool(deps) {
  return {
    description: 'Source or generate a reusable 3D asset from a text description. The workflow may generate image candidates, evaluate them, generate 3D, verify it, and publish an Asset.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1 },
        candidateCount: { type: 'integer', minimum: 1, maximum: 8, default: 4 }
      },
      required: ['prompt'],
      additionalProperties: false
    },
    async execute({ prompt, candidateCount = 4 }, { signal, executionId } = {}) {
      const result = await runSource3DAsset({ prompt, candidateCount }, deps, { signal, executionId });
      if (result.state.phase === 'cancelled') {
        const error = new Error(result.state.cancellation?.message ?? 'workflow cancelled');
        error.code = 'workflow_cancelled';
        error.retryable = false;
        throw error;
      }
      if (result.state.phase === 'failed') {
        const error = new Error(result.state.error.message);
        error.code = result.state.error.code;
        error.retryable = result.state.error.retryable;
        throw error;
      }
      if (result.state.phase !== 'done') throw new Error(`source_3d_asset ended in unexpected phase: ${result.state.phase}`);
      return {
        asset: result.state.asset,
        artifact: result.state.artifact,
        selectedId: result.state.selectedId,
        candidates: result.state.candidates,
        trace: result.trace,
        timings: result.trace
          .filter(({ durationMs }) => Number.isFinite(durationMs))
          .map(({ phase, effects, startedAt, finishedAt, durationMs }) => ({
            phase, effect: effects?.[0] ?? null, startedAt, finishedAt, durationMs
          }))
      };
    }
  };
}

function modal3DHeaders(token, extra = {}) {
  return token ? { ...extra, 'X-Modal-3D-Session': token } : extra;
}

const PUBLIC_3D_ARTIFACT_FIELDS = new Set([
  'id', 'role', 'mediaType', 'digest', 'mime', 'sha256', 'bytes', 'glb_version'
]);
const PUBLIC_CONDITIONING_FIELDS = new Set([
  'strategy', 'engine', 'source_sha256', 'canonical_sha256', 'source_format',
  'source_size', 'foreground_bbox', 'foreground_ratio', 'canonical_size',
  'bytes', 'mask_elapsed_ms'
]);

function pickPublicFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
}

function verifyGlb(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) throw new Error('modal-3D artifact is not a complete GLB');
  if (data.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('modal-3D artifact has invalid GLB magic');
  const version = data.readUInt32LE(4);
  const declaredBytes = data.readUInt32LE(8);
  if (version !== 2) throw new Error(`modal-3D artifact has unsupported GLB version: ${version}`);
  if (declaredBytes !== data.length) throw new Error(`modal-3D artifact byte length mismatch: declared=${declaredBytes} actual=${data.length}`);
  return { version, declaredBytes };
}

export function createModal3DAdapter({
  endpoint = 'http://127.0.0.1:3213',
  token,
  model = 'fastsam3d-plus-plus',
  profile = 'recommended',
  seed = 42,
  pollIntervalMs = 1000,
  timeoutMs = 40 * 60 * 1000,
  fetchImpl = fetch
} = {}) {
  const base = String(endpoint).replace(/\/$/, '');
  const preflight = createCapabilityPreflight({
    base,
    headers: modal3DHeaders(token),
    model,
    profile,
    providerName: 'modal-3D',
    fetchImpl
  });

  async function wait(jobId, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) await cancelAfterAbort(fetchImpl, base, jobId, modal3DHeaders(token), signal);
      let state;
      try {
        state = await jsonRequest(fetchImpl, `${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
          headers: modal3DHeaders(token),
          signal
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') await cancelAfterAbort(fetchImpl, base, jobId, modal3DHeaders(token), signal);
        throw error;
      }
      if (state.status === 'succeeded') return state;
      if (['failed', 'cancelled', 'expired'].includes(state.status)) {
        const error = new Error(`modal-3D job ${jobId} ended as ${state.status}`);
        error.code = state.error_code ?? `three_d_${state.status}`;
        error.retryable = Boolean(state.retryable);
        throw error;
      }
      try {
        await delayOrCancel(pollIntervalMs, signal);
      } catch (error) {
        if (error?.code === 'workflow_cancelled') await cancelAfterAbort(fetchImpl, base, jobId, modal3DHeaders(token), signal);
        throw error;
      }
    }
    const error = new Error(`modal-3D job ${jobId} timed out`);
    error.code = 'three_d_timeout';
    error.retryable = true;
    throw error;
  }

  return {
    preflight,
    async generate3D({ candidate, signal, executionId }) {
      const totalStarted = performance.now();
      throwIfCancelled(signal);
      if (!candidate || typeof candidate !== 'object') throw new TypeError('candidate is required');
      if (!Buffer.isBuffer(candidate.data)) throw new TypeError('candidate.data must be a Buffer');
      const mediaType = candidate.mediaType ?? 'image/png';
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mediaType];
      if (!extension) throw new TypeError(`unsupported 3D source media type: ${mediaType}`);
      const sourceSha256 = createHash('sha256').update(candidate.data).digest('hex');
      if (candidate.sha256 && candidate.sha256 !== sourceSha256) throw new Error(`candidate digest mismatch: ${candidate.id ?? 'unknown'}`);
      const preflightStarted = performance.now();
      await preflight(signal);
      const preflightMs = elapsedMs(preflightStarted);
      throwIfCancelled(signal);
      const runScope = executionId ?? randomUUID();
      const identity = createHash('sha256')
        .update(`${runScope}\0${model}\0${profile}\0${seed}\0${sourceSha256}`)
        .digest('hex')
        .slice(0, 24);
      const jobId = `agent3d_${identity}`;
      const form = new FormData();
      form.append('file', new Blob([candidate.data], { type: mediaType }), `source.${extension}`);
      form.append('model', model);
      form.append('profile', profile);
      form.append('seed', String(seed));
      form.append('job_id', jobId);

      const lookupStarted = performance.now();
      let state = await existingJob(fetchImpl, `${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
        headers: modal3DHeaders(token),
        signal
      });
      const lookupMs = elapsedMs(lookupStarted);
      let submitMs = 0;
      const reusedJob = Boolean(state);
      if (!state) {
        const submitStarted = performance.now();
        try {
          state = await jsonRequest(fetchImpl, `${base}/v1/jobs`, {
            method: 'POST',
            headers: modal3DHeaders(token),
            body: form,
            signal
          });
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') await cancelAfterAbort(fetchImpl, base, jobId, modal3DHeaders(token), signal);
          throw error;
        }
        submitMs = elapsedMs(submitStarted);
      }
      const waitStarted = performance.now();
      state = await wait(jobId, signal);
      const waitMs = elapsedMs(waitStarted);
      throwIfCancelled(signal);
      const artifactStarted = performance.now();
      const response = await fetchImpl(`${base}/v1/jobs/${encodeURIComponent(jobId)}/artifact`, {
        headers: modal3DHeaders(token),
        signal
      });
      if (!response.ok) throw new Error(`modal-3D artifact ${jobId} failed with HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      const artifactFetchMs = elapsedMs(artifactStarted);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const expected = response.headers.get('x-artifact-sha256');
      if (expected && expected !== sha256) throw new Error(`modal-3D artifact digest mismatch for ${jobId}`);
      verifyGlb(data);
      const providerArtifact = pickPublicFields(state.result?.artifact, PUBLIC_3D_ARTIFACT_FIELDS);
      const conditioning = pickPublicFields(state.result?.conditioning, PUBLIC_CONDITIONING_FIELDS);
      return {
        ...providerArtifact,
        id: response.headers.get('x-artifact-id') ?? providerArtifact.id ?? jobId,
        jobId,
        mediaType: 'model/gltf-binary',
        bytes: data.length,
        sha256,
        model,
        conditioning: Object.keys(conditioning).length ? conditioning : null,
        timing: {
          preflightMs,
          lookupMs,
          submitMs,
          waitMs,
          artifactFetchMs,
          totalMs: elapsedMs(totalStarted),
          reusedJob
        },
        data
      };
    }
  };
}
