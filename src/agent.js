function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
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

export async function runAgent({ task, gateway, tools, maxSteps = 8, systemPrompt } = {}) {
  const userTask = requireText(task, 'task');
  if (typeof gateway !== 'function') throw new TypeError('gateway is required');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 32) throw new RangeError('maxSteps must be between 1 and 32');
  const normalizedTools = normalizeTools(tools);
  const definitions = toolDefinitions(normalizedTools);
  const messages = [
    {
      role: 'system',
      content: systemPrompt ?? 'You are the AgentScape orchestration agent. Prefer high-level tools. Do not invent tool results. Stop only when the task is complete or a tool reports a terminal failure.'
    },
    { role: 'user', content: userTask }
  ];
  const trace = [];

  for (let step = 1; step <= maxSteps; step++) {
    const response = await gateway({ messages: structuredClone(messages), tools: definitions });
    if (!response || typeof response !== 'object') throw new TypeError('gateway returned an invalid response');
    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const message = typeof response.message === 'string' ? response.message : '';

    if (toolCalls.length === 0) {
      trace.push({ step, type: 'final', message });
      return { status: 'completed', message, steps: step, trace };
    }

    messages.push({
      role: 'assistant',
      content: message,
      toolCalls: toolCalls.map(({ id, name, args }) => ({ id: id ?? null, name, args: args ?? {} }))
    });

    for (const call of toolCalls) {
      const name = requireText(call?.name, 'tool call name');
      const tool = normalizedTools[name];
      if (!tool) {
        const result = { success: false, error: { code: 'tool_not_found', message: `Unknown tool: ${name}` } };
        trace.push({ step, type: 'tool', name, success: false, code: 'tool_not_found' });
        messages.push({ role: 'tool', toolCallId: call.id ?? null, name, content: JSON.stringify(result) });
        continue;
      }

      const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
      let result;
      try {
        result = { success: true, result: await tool.execute(args) };
        trace.push({ step, type: 'tool', name, success: true });
      } catch (error) {
        result = {
          success: false,
          error: {
            code: error?.code ?? 'tool_failed',
            message: error instanceof Error ? error.message : String(error),
            retryable: Boolean(error?.retryable)
          }
        };
        trace.push({ step, type: 'tool', name, success: false, code: result.error.code });
      }
      messages.push({ role: 'tool', toolCallId: call.id ?? null, name, content: JSON.stringify(result) });
    }
  }

  return {
    status: 'max_steps_exceeded',
    message: `Agent exceeded maxSteps=${maxSteps}`,
    steps: maxSteps,
    trace
  };
}
