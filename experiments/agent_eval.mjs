import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runAgent } from '../src/agent.js';

const cases = (await readFile(new URL('./agent_cases.jsonl', import.meta.url), 'utf8'))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function sourceTool(scenario) {
  return {
    description: 'Source or generate a reusable 3D asset from text.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    async execute() {
      if (scenario === 'tool_failure') {
        const error = new Error('3D provider unavailable');
        error.code = 'provider_unavailable';
        error.retryable = true;
        throw error;
      }
      if (scenario === 'binary_result') return { artifact: Buffer.from('forbidden-binary') };
      return { assetId: 'asset-1', status: 'ready' };
    }
  };
}

function scriptedGateway(testCase, observations) {
  let step = 0;
  return async ({ messages }) => {
    step += 1;
    const last = messages.at(-1);
    if (last?.role === 'tool') observations.push(JSON.parse(last.content));

    switch (testCase.scenario) {
      case 'source_asset':
        return step === 1
          ? { message: '', toolCalls: [{ id: 'call-1', name: 'source_3d_asset', args: { prompt: 'red apple' } }] }
          : { message: 'asset ready', toolCalls: [] };
      case 'unknown_tool':
        return step === 1
          ? { message: '', toolCalls: [{ id: 'call-1', name: 'shell_exec', args: { command: 'unsafe' } }] }
          : { message: 'unsupported tool rejected', toolCalls: [] };
      case 'tool_failure':
      case 'binary_result':
        return step === 1
          ? { message: '', toolCalls: [{ id: 'call-1', name: 'source_3d_asset', args: { prompt: 'red apple' } }] }
          : { message: 'tool failure observed', toolCalls: [] };
      case 'runaway':
        return { message: '', toolCalls: [{ id: `call-${step}`, name: 'source_3d_asset', args: { prompt: 'red apple' } }] };
      default:
        throw new Error(`unknown scenario: ${testCase.scenario}`);
    }
  };
}

function evaluate(testCase, run, observations) {
  const toolTrace = run.trace.filter(({ type }) => type === 'tool');
  const toolNames = toolTrace.map(({ name }) => name);
  const errorCodes = toolTrace.filter(({ success }) => success === false).map(({ code }) => code);
  const failures = [];
  if (run.status !== testCase.expected.status) failures.push(`status expected=${testCase.expected.status} actual=${run.status}`);
  if (JSON.stringify(toolNames) !== JSON.stringify(testCase.expected.toolNames)) {
    failures.push(`tools expected=${JSON.stringify(testCase.expected.toolNames)} actual=${JSON.stringify(toolNames)}`);
  }
  const expectedCodes = testCase.expected.errorCodes ?? [];
  if (JSON.stringify(errorCodes) !== JSON.stringify(expectedCodes)) {
    failures.push(`errorCodes expected=${JSON.stringify(expectedCodes)} actual=${JSON.stringify(errorCodes)}`);
  }
  if (toolTrace.length > testCase.expected.maxToolCalls) {
    failures.push(`tool budget exceeded: ${toolTrace.length} > ${testCase.expected.maxToolCalls}`);
  }
  if (run.steps > testCase.expected.maxSteps) failures.push(`step budget exceeded: ${run.steps} > ${testCase.expected.maxSteps}`);
  return {
    id: testCase.id,
    passed: failures.length === 0,
    failures,
    outcome: { status: run.status, steps: run.steps, message: run.message },
    trajectory: run.trace,
    observations: observations.map(({ success, error, result }) => ({
      success,
      errorCode: error?.code ?? null,
      resultKeys: result && typeof result === 'object' ? Object.keys(result) : []
    })),
    metrics: { toolCalls: toolTrace.length, toolBudget: testCase.expected.maxToolCalls }
  };
}

const started = Date.now();
const results = [];
for (const testCase of cases) {
  const observations = [];
  const run = await runAgent({
    task: `eval:${testCase.id}`,
    maxSteps: testCase.expected.maxSteps,
    tools: { source_3d_asset: sourceTool(testCase.scenario) },
    gateway: scriptedGateway(testCase, observations)
  });
  results.push(evaluate(testCase, run, observations));
}

const report = {
  experiment: 'agent-trajectory-replay-v1',
  status: results.every(({ passed }) => passed) ? 'passed' : 'failed',
  elapsedMs: Date.now() - started,
  summary: {
    cases: results.length,
    passed: results.filter(({ passed }) => passed).length,
    failed: results.filter(({ passed }) => !passed).length
  },
  results
};
const outputDir = resolve('results/agent_eval');
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (report.status !== 'passed') process.exitCode = 1;
