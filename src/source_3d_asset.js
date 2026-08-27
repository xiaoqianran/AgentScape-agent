import { createHash } from 'node:crypto';

const TERMINAL_PHASES = new Set(['done', 'failed']);
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
    seed: candidate.seed ?? null
  };
}

function summarizeArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') throw new TypeError('3D artifact is required');
  return {
    id: requireText(artifact.id, 'artifact.id'),
    mediaType: requireText(artifact.mediaType ?? artifact.mime, 'artifact.mediaType'),
    bytes: Number(artifact.bytes ?? 0),
    sha256: requireText(artifact.sha256, 'artifact.sha256')
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
    artifact: null,
    asset: null,
    error: null
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
        state: { ...state, phase: 'generating_3d', selectedId },
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
          }
        },
        effects: []
      };

    default:
      throw new Error(`unknown source_3d_asset event: ${event.type}`);
  }
}

export async function runSource3DAsset(request, deps) {
  const required = ['generateImages', 'evaluateImages', 'generate3D', 'publishAsset'];
  for (const name of required) if (typeof deps?.[name] !== 'function') throw new TypeError(`deps.${name} is required`);

  let state = initialSource3DAssetState(request);
  let event = { type: 'started' };
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

    try {
      event = await executeEffect(transition.effects[0], state, resources, deps);
    } catch (error) {
      event = {
        type: 'failed',
        code: error?.code ?? 'effect_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: Boolean(error?.retryable)
      };
    }
  }

  return { state, trace };
}

async function executeEffect(effect, state, resources, deps) {
  switch (effect.type) {
    case EFFECT.GENERATE_IMAGES: {
      const candidates = await deps.generateImages({ prompt: effect.prompt, count: effect.count });
      for (const candidate of candidates) resources.set(candidate.id, candidate);
      return { type: 'images_generated', candidates };
    }
    case EFFECT.EVALUATE_IMAGES: {
      const candidates = effect.candidateIds.map((id) => resources.get(id));
      if (candidates.some((candidate) => !candidate)) throw new Error('candidate payload is unavailable');
      const decision = await deps.evaluateImages({ prompt: effect.prompt, candidates });
      return { type: 'candidate_selected', selectedId: decision.selectedId, evaluation: decision };
    }
    case EFFECT.GENERATE_3D: {
      const candidate = resources.get(effect.candidateId);
      if (!candidate) throw new Error(`candidate payload is unavailable: ${effect.candidateId}`);
      const artifact = await deps.generate3D({ prompt: effect.prompt, candidate });
      resources.set(artifact.id, artifact);
      return { type: 'three_d_generated', artifact };
    }
    case EFFECT.PUBLISH_ASSET: {
      const artifact = resources.get(effect.artifactId);
      if (!artifact) throw new Error(`artifact payload is unavailable: ${effect.artifactId}`);
      return { type: 'asset_published', asset: await deps.publishAsset({ prompt: effect.prompt, artifact }) };
    }
    default:
      throw new Error(`unknown effect: ${effect.type}`);
  }
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

  async function wait(jobId) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await jsonRequest(fetchImpl, `${base}/v1/jobs/${encodeURIComponent(jobId)}`, {
        headers: requestHeaders(token)
      });
      if (state.status === 'succeeded') return state;
      if (['failed', 'cancelled', 'expired'].includes(state.status)) {
        const error = new Error(`modal-2D job ${jobId} ended as ${state.status}`);
        error.code = state.error_code ?? `image_${state.status}`;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    const error = new Error(`modal-2D job ${jobId} timed out`);
    error.code = 'image_timeout';
    error.retryable = true;
    throw error;
  }

  async function generateOne(prompt, seed) {
    const identity = createHash('sha256').update(`${model}\0${seed}\0${prompt}`).digest('hex').slice(0, 24);
    const jobId = `agent2d_${identity}`;
    await jsonRequest(fetchImpl, `${base}/v1/jobs`, {
      method: 'POST',
      headers: requestHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ prompt, model, seed, job_id: jobId })
    });
    await wait(jobId);
    const response = await fetchImpl(`${base}/v1/jobs/${encodeURIComponent(jobId)}/artifact`, {
      headers: requestHeaders(token)
    });
    if (!response.ok) throw new Error(`modal-2D artifact ${jobId} failed with HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash('sha256').update(data).digest('hex');
    const expected = response.headers.get('x-artifact-sha256');
    if (expected && expected !== sha256) throw new Error(`modal-2D artifact digest mismatch for ${jobId}`);
    return {
      id: response.headers.get('x-artifact-id') ?? jobId,
      jobId,
      mediaType: response.headers.get('content-type')?.split(';')[0] ?? 'image/png',
      bytes: data.length,
      sha256,
      model,
      seed,
      data
    };
  }

  return {
    async generateImages({ prompt, count = 4 }) {
      const normalized = requireText(prompt, 'prompt');
      return Promise.all(Array.from({ length: count }, (_, index) => generateOne(normalized, baseSeed + index * 31)));
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
    async evaluateImages({ prompt, candidates }) {
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
      return { selectedId: decision.selectedId, reason: String(decision.reason ?? '') };
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
    async execute({ prompt, candidateCount = 4 }) {
      const result = await runSource3DAsset({ prompt, candidateCount }, deps);
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
        trace: result.trace
      };
    }
  };
}
