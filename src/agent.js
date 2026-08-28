function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function assertObservationSafe(value, path = 'result', seen = new Set()) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const error = new TypeError(`Tool observation must not contain binary payloads: ${path}`);
    error.code = 'tool_result_not_serializable';
    throw error;
  }
  if (typeof value !== 'object') {
    const error = new TypeError(`Tool observation contains unsupported value at ${path}`);
    error.code = 'tool_result_not_serializable';
    throw error;
  }
  if (seen.has(value)) {
    const error = new TypeError(`Tool observation contains a cycle at ${path}`);
    error.code = 'tool_result_not_serializable';
    throw error;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertObservationSafe(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) assertObservationSafe(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function serializeToolObservation(value) {
  assertObservationSafe(value);
  return JSON.stringify(value);
}

function agentCancellationMessage(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  return 'agent run cancelled';
}

function normalizeTools(tools) {
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) throw new TypeError('tools must be an object');
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!tool || typeof tool.execute !== 'function') throw new TypeError(`tool ${name}.execute is required`);
    return [name, {
      description: requireText(tool.description, `tool ${name}.description`),
      parameters: tool.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
      execute: tool.execute
    }];
  }));
}

export function toolDefinitions(tools) {
  const normalized = normalizeTools(tools);
  return Object.entries(normalized).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

function roundDuration(started) {
  return Number((performance.now() - started).toFixed(3));
}

function stableExecutionId(scope, step, index, call) {
  const raw = [scope, step, index, call?.id ?? 'call', call?.name ?? 'tool'].join('__');
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 127);
}

function cloneToolBatch(batch) {
  if (!batch) return null;
  return {
    step: batch.step,
    nextIndex: batch.nextIndex,
    calls: batch.calls.map((call) => ({
      id: call.id ?? null,
      name: call.name,
      args: structuredClone(call.args ?? {}),
      executionId: call.executionId
    }))
  };
}

export async function runAgent({
  task,
  gateway,
  tools,
  maxSteps = 8,
  systemPrompt,
  checkpoint,
  signal,
  resume,
  executionScope = 'agent-run',
  initialTimings = []
} = {}) {
  const userTask = requireText(task ?? resume?.task, 'task');
  if (typeof gateway !== 'function') throw new TypeError('gateway is required');
  if (checkpoint != null && typeof checkpoint !== 'function') throw new TypeError('checkpoint must be a function');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 32) throw new RangeError('maxSteps must be between 1 and 32');
  const normalizedTools = normalizeTools(tools);
  const definitions = toolDefinitions(normalizedTools);
  const messages = Array.isArray(resume?.messages)
    ? structuredClone(resume.messages)
    : [
        {
          role: 'system',
          content: systemPrompt ?? 'You are the AgentScape orchestration agent. Prefer high-level tools. Do not invent tool results. Stop only when the task is complete or a tool reports a terminal failure.'
        },
        { role: 'user', content: userTask }
      ];
  const trace = Array.isArray(resume?.trace) ? structuredClone(resume.trace) : [];
  const timings = [
    ...(Array.isArray(resume?.timings) ? structuredClone(resume.timings) : []),
    ...structuredClone(initialTimings)
  ];
  let nextStep = Number.isInteger(resume?.nextStep)
    ? resume.nextStep
    : resume?.phase === 'tools'
      ? Number(resume?.step ?? 1)
      : Number(resume?.step ?? 0) + 1;
  let toolBatch = resume?.toolBatch ? cloneToolBatch(resume.toolBatch) : null;
  const recoveredExecutionIds = new Set();
  if (toolBatch && Number.isInteger(toolBatch.nextIndex) && toolBatch.calls[toolBatch.nextIndex]?.executionId) {
    recoveredExecutionIds.add(toolBatch.calls[toolBatch.nextIndex].executionId);
  }

  function snapshot(status, extra = {}) {
    return {
      status,
      phase: toolBatch ? 'tools' : 'gateway',
      task: userTask,
      step: extra.step ?? Math.max(0, nextStep - 1),
      nextStep,
      messages: structuredClone(messages),
      trace: structuredClone(trace),
      timings: structuredClone(timings),
      toolBatch: cloneToolBatch(toolBatch),
      ...extra
    };
  }

  async function saveCheckpoint(status, extra = {}, label = status) {
    if (!checkpoint) return;
    const started = performance.now();
    await checkpoint(snapshot(status, extra));
    timings.push({ kind: 'checkpoint', label, step: extra.step ?? null, durationMs: roundDuration(started) });
  }

  async function finishCancelled(step) {
    const message = agentCancellationMessage(signal);
    const result = { status: 'cancelled', message, steps: step, trace, timings };
    toolBatch = null;
    await saveCheckpoint(result.status, { step, message, phase: 'terminal', toolBatch: null }, 'terminal:cancelled');
    return result;
  }

  while (nextStep <= maxSteps || toolBatch) {
    if (signal?.aborted) return finishCancelled(Math.max(0, nextStep - 1));

    if (toolBatch) {
      const batchStep = toolBatch.step;
      while (toolBatch.nextIndex < toolBatch.calls.length) {
        if (signal?.aborted) return finishCancelled(batchStep);
        const index = toolBatch.nextIndex;
        const call = toolBatch.calls[index];
        const name = requireText(call?.name, 'tool call name');
        const executionId = call.executionId ?? stableExecutionId(executionScope, batchStep, index, call);
        call.executionId = executionId;
        await saveCheckpoint('tool_pending', {
          step: batchStep,
          pendingTool: { index, id: call.id ?? null, name, args: structuredClone(call.args ?? {}), executionId }
        }, `tool:${name}:pending`);

        const started = performance.now();
        const recovered = recoveredExecutionIds.has(executionId);
        const tool = normalizedTools[name];
        let result;
        let content;
        if (!tool) {
          result = { success: false, error: { code: 'tool_not_found', message: `Unknown tool: ${name}` } };
          content = JSON.stringify(result);
          const durationMs = roundDuration(started);
          trace.push({ step: batchStep, type: 'tool', name, success: false, code: 'tool_not_found', executionId, recovered, durationMs });
          timings.push({ kind: 'tool', name, step: batchStep, executionId, recovered, durationMs });
        } else {
          const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
          try {
            result = {
              success: true,
              result: await tool.execute(args, { signal, executionId, recovered })
            };
            content = serializeToolObservation(result);
            const durationMs = roundDuration(started);
            trace.push({ step: batchStep, type: 'tool', name, success: true, executionId, recovered, durationMs });
            timings.push({ kind: 'tool', name, step: batchStep, executionId, recovered, durationMs });
          } catch (error) {
            result = {
              success: false,
              error: {
                code: error?.code ?? 'tool_failed',
                message: error instanceof Error ? error.message : String(error),
                retryable: Boolean(error?.retryable)
              }
            };
            content = JSON.stringify(result);
            const durationMs = roundDuration(started);
            trace.push({ step: batchStep, type: 'tool', name, success: false, code: result.error.code, executionId, recovered, durationMs });
            timings.push({ kind: 'tool', name, step: batchStep, executionId, recovered, durationMs });
          }
        }

        messages.push({ role: 'tool', toolCallId: call.id ?? null, name, content });
        recoveredExecutionIds.delete(executionId);
        toolBatch.nextIndex += 1;
        if (result.success === false && result.error?.code === 'workflow_cancelled') return finishCancelled(batchStep);
        await saveCheckpoint('running', { step: batchStep, pendingTool: null }, `tool:${name}:completed`);
      }
      toolBatch = null;
      nextStep = batchStep + 1;
      await saveCheckpoint('running', { step: batchStep, phase: 'gateway', toolBatch: null, pendingTool: null }, 'gateway:ready');
      continue;
    }

    const step = nextStep;
    const gatewayStarted = performance.now();
    let response;
    try {
      response = await gateway({ messages: structuredClone(messages), tools: definitions, signal });
    } catch (error) {
      timings.push({ kind: 'gateway', step, durationMs: roundDuration(gatewayStarted), success: false });
      if (signal?.aborted || error?.name === 'AbortError') return finishCancelled(step - 1);
      throw error;
    }
    const gatewayDurationMs = roundDuration(gatewayStarted);
    timings.push({ kind: 'gateway', step, durationMs: gatewayDurationMs, success: true });
    if (signal?.aborted) return finishCancelled(step);
    if (!response || typeof response !== 'object') throw new TypeError('gateway returned an invalid response');
    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const message = typeof response.message === 'string' ? response.message : '';

    if (toolCalls.length === 0) {
      trace.push({ step, type: 'final', message, durationMs: gatewayDurationMs });
      const result = { status: 'completed', message, steps: step, trace, timings };
      nextStep = step + 1;
      await saveCheckpoint(result.status, { step, message, phase: 'terminal', toolBatch: null, pendingTool: null }, 'terminal:completed');
      return result;
    }

    const calls = toolCalls.map(({ id, name, args }, index) => {
      const normalizedCall = { id: id ?? null, name, args: args ?? {} };
      return {
        ...normalizedCall,
        executionId: stableExecutionId(executionScope, step, index, normalizedCall)
      };
    });
    messages.push({ role: 'assistant', content: message, toolCalls: calls.map(({ id, name, args }) => ({ id, name, args })) });
    toolBatch = { step, nextIndex: 0, calls };
    nextStep = step;
  }

  const result = {
    status: 'max_steps_exceeded',
    message: `Agent exceeded maxSteps=${maxSteps}`,
    steps: maxSteps,
    trace,
    timings
  };
  toolBatch = null;
  nextStep = maxSteps + 1;
  await saveCheckpoint(result.status, { step: maxSteps, message: result.message, phase: 'terminal', toolBatch: null, pendingTool: null }, 'terminal:max_steps_exceeded');
  return result;
}

function toOpenAIMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call, index) => ({
          id: call.id ?? `call_${index + 1}`,
          type: 'function',
          function: {
            name: requireText(call.name, 'assistant tool call name'),
            arguments: JSON.stringify(call.args ?? {})
          }
        }))
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: requireText(message.toolCallId, 'toolCallId'),
        content: String(message.content ?? '')
      };
    }
    return { role: message.role, content: String(message.content ?? '') };
  });
}

function parseToolArguments(value, name) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('arguments must be an object');
    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON arguments for tool ${name}: ${error.message}`);
  }
}

export function createOpenAICompatibleAgentGateway({ baseUrl, apiKey, model, fetchImpl = fetch } = {}) {
  const endpoint = requireText(baseUrl, 'baseUrl').replace(/\/$/, '');
  const key = requireText(apiKey, 'apiKey');
  const modelName = requireText(model, 'model');

  return async ({ messages, tools, signal }) => {
    if (!Array.isArray(messages)) throw new TypeError('messages are required');
    if (!Array.isArray(tools)) throw new TypeError('tools are required');
    const response = await fetchImpl(`${endpoint}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: modelName,
        temperature: 0,
        stream: false,
        tool_choice: 'auto',
        messages: toOpenAIMessages(messages),
        tools: tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        }))
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Agent LLM request failed with HTTP ${response.status}: ${payload.error?.message ?? response.statusText}`);
    const message = payload.choices?.[0]?.message;
    if (!message || typeof message !== 'object') throw new Error('Agent LLM returned no message');
    const toolCalls = (message.tool_calls ?? []).map((call, index) => {
      const name = requireText(call?.function?.name, 'tool call name');
      return {
        id: call.id ?? `call_${index + 1}`,
        name,
        args: parseToolArguments(call.function.arguments, name)
      };
    });
    return {
      message: typeof message.content === 'string' ? message.content : '',
      final: toolCalls.length === 0,
      toolCalls
    };
  };
}
