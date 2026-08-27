import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runAgent, toolDefinitions } from '../src/agent.js';

const sourceTool = (execute) => ({
  description: 'Source or generate a reusable 3D asset from a text description.',
  parameters: {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
    additionalProperties: false
  },
  execute
});

test('agent exposes only high-level tool definitions and completes after observation', async () => {
  const requests = [];
  let invocation = 0;
  const result = await runAgent({
    task: 'create a red apple asset',
    tools: {
      source_3d_asset: sourceTool(async ({ prompt }) => ({ assetId: 'asset-1', prompt }))
    },
    gateway: async (request) => {
      requests.push(request);
      invocation += 1;
      if (invocation === 1) {
        return {
          message: '',
          toolCalls: [{ id: 'call-1', name: 'source_3d_asset', args: { prompt: 'red apple' } }]
        };
      }
      const observation = JSON.parse(request.messages.at(-1).content);
      assert.equal(observation.result.assetId, 'asset-1');
      return { message: 'asset ready', toolCalls: [] };
    }
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.message, 'asset ready');
  assert.deepEqual(requests[0].tools.map(({ name }) => name), ['source_3d_asset']);
  assert.deepEqual(result.trace.map(({ type }) => type), ['tool', 'final']);
});

test('agent turns unknown tools into observations instead of executing arbitrary names', async () => {
  let step = 0;
  const result = await runAgent({
    task: 'do something',
    tools: { source_3d_asset: sourceTool(async () => ({ id: 'never' })) },
    gateway: async ({ messages }) => {
      step += 1;
      if (step === 1) return { message: '', toolCalls: [{ id: 'x', name: 'shell_exec', args: { command: 'rm -rf /' } }] };
      const observation = JSON.parse(messages.at(-1).content);
      assert.equal(observation.error.code, 'tool_not_found');
      return { message: 'cannot use that tool', toolCalls: [] };
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.trace[0].success, false);
  assert.equal(result.trace[0].code, 'tool_not_found');
});

test('agent records tool failures as structured observations', async () => {
  let step = 0;
  const result = await runAgent({
    task: 'generate chair',
    tools: {
      source_3d_asset: sourceTool(async () => {
        const error = new Error('3D provider unavailable');
        error.code = 'provider_unavailable';
        error.retryable = true;
        throw error;
      })
    },
    gateway: async ({ messages }) => {
      step += 1;
      if (step === 1) return { message: '', toolCalls: [{ id: 'x', name: 'source_3d_asset', args: { prompt: 'chair' } }] };
      const observation = JSON.parse(messages.at(-1).content);
      assert.deepEqual(observation.error, {
        code: 'provider_unavailable',
        message: '3D provider unavailable',
        retryable: true
      });
      return { message: 'generation is unavailable', toolCalls: [] };
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.trace[0].code, 'provider_unavailable');
});

test('tool definitions do not leak execute functions into the model schema', () => {
  const definitions = toolDefinitions({ source_3d_asset: sourceTool(async () => {}) });
  assert.equal(definitions.length, 1);
  assert.equal(typeof definitions[0].description, 'string');
  assert.equal('execute' in definitions[0], false);
});

import { createOpenAICompatibleAgentGateway } from '../src/agent.js';
import { createSource3DAssetTool } from '../src/source_3d_asset.js';

test('OpenAI-compatible agent gateway serializes tools and parses tool calls fail-closed', async () => {
  let upstreamBody;
  const gateway = createOpenAICompatibleAgentGateway({
    baseUrl: 'https://llm.example/v1',
    apiKey: 'test-key',
    model: 'agent-model',
    fetchImpl: async (_url, init) => {
      upstreamBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'source_3d_asset', arguments: '{"prompt":"red apple"}' }
            }]
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const response = await gateway({
    messages: [{ role: 'user', content: 'make an apple' }],
    tools: [{ name: 'source_3d_asset', description: 'source asset', parameters: { type: 'object' } }]
  });
  assert.deepEqual(response.toolCalls, [{ id: 'call-1', name: 'source_3d_asset', args: { prompt: 'red apple' } }]);
  assert.equal(upstreamBody.tool_choice, 'auto');
  assert.equal(upstreamBody.tools[0].function.name, 'source_3d_asset');
});

test('OpenAI-compatible agent gateway rejects malformed tool arguments', async () => {
  const gateway = createOpenAICompatibleAgentGateway({
    baseUrl: 'https://llm.example/v1',
    apiKey: 'test-key',
    model: 'agent-model',
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'source_3d_asset', arguments: '{broken' } }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  await assert.rejects(
    () => gateway({ messages: [], tools: [] }),
    /Invalid JSON arguments for tool source_3d_asset/
  );
});

test('Agent can invoke source_3d_asset as one deep high-level tool', async () => {
  const image = Buffer.from('image');
  const sourceTool = createSource3DAssetTool({
    async generateImages() {
      return [{
        id: 'img-1',
        mediaType: 'image/png',
        bytes: image.length,
        sha256: createHash('sha256').update(image).digest('hex'),
        data: image
      }];
    },
    async evaluateImages() {
      return { selectedId: 'img-1', reason: 'only candidate' };
    },
    async generate3D() {
      return { id: 'glb-1', mediaType: 'model/gltf-binary', bytes: 12, sha256: 'a'.repeat(64), data: Buffer.from('glb') };
    },
    async publishAsset() {
      return { id: 'asset-1', status: 'ready' };
    }
  });
  let step = 0;
  const result = await runAgent({
    task: 'make a red apple asset',
    tools: { source_3d_asset: sourceTool },
    gateway: async ({ messages }) => {
      step += 1;
      if (step === 1) return { message: '', toolCalls: [{ id: 'call-1', name: 'source_3d_asset', args: { prompt: 'red apple', candidateCount: 1 } }] };
      const observation = JSON.parse(messages.at(-1).content);
      assert.equal(observation.result.asset.id, 'asset-1');
      assert.equal(observation.result.selectedId, 'img-1');
      return { message: 'asset ready', toolCalls: [] };
    }
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map(({ type }) => type), ['tool', 'final']);
});
