import test from 'node:test';
import assert from 'node:assert/strict';
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
