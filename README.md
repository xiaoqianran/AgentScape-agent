# AgentScape-agent

`AgentScape-agent` 是 AgentScape 系统的 **Agentic Orchestration Caller**。它不拥有 Provider、Artifact Store、Asset 真值或 WorldRuntime；它只拥有 Agent Run、决策、Skill workflow 与调用证据。

## 代码原则

```text
Experiment
   ↓
Vertical Slice
   ↓
Single-file First
   ↓
Functional Core / Imperative Shell
   ↓
Contract + Evidence
   ↓
出现真实 Pressure 才 Extract
```

第一条 Vertical Slice 是 `source_3d_asset`：

```text
Text
  ↓
generate N images ──► modal-2D-client
  ↓
VLM evaluate / select
  ↓
generate 3D ────────► modal-3D-client
  ↓
publish Asset ──────► AgentScape
```

当前代码把 `decideSource3DAsset()` 保持为纯函数；HTTP、Modal Sidecar、VLM 等副作用只存在于 Imperative Shell / Adapter。没有 `service/repository/manager/factory` 横向层。

## 验证

```bash
npm test
npm run check
```

真实候选生成实验：

```bash
MODAL_2D_AGENT_TOKEN=... npm run experiment:source3d
```

如果同时提供 `AGENTSCAPE_LLM_BASE_URL / AGENTSCAPE_LLM_API_KEY / AGENTSCAPE_LLM_MODEL`，实验会继续执行真实 multimodal VLM ranking；没有凭据时会明确记录 `ranking.status=skipped`，不会伪造结果。

## Verified baseline

2026-08-27 已用正在运行的真实 `modal-2D-client` 执行第一条实验：

```text
prompt → modal-2D-client → modal-2D
       → 4 image candidates
```

结果：

```text
model      sana-sprint-1.6b
seeds      42 / 73 / 104 / 135
candidates 4/4 succeeded
elapsed    63672 ms
digests    4 distinct SHA-256
ranking    skipped (LLM credentials not configured)
```

这条 baseline 只证明“真实候选生成”已经稳定，不把未执行的 VLM ranking 伪装成成功。

## Replay / Evaluation Gate

除了真实 Provider Experiment，本仓还保留 deterministic replay，用来防止 Agent/Workflow 改动产生轨迹回退：

```text
npm run eval:source3d
```

当前 `source_3d_asset-replay-v1` 覆盖：

```text
happy path                PASS
image provider failure    PASS
VLM invented candidate    PASS
3D provider failure       PASS
Asset admission failure   PASS
```

每个 case 同时检查：

```text
Outcome      最终 phase / error code
Trajectory   Event → Effect 顺序
Efficiency   Effect count 不超过预算
```

Replay 不替代真实 Provider Experiment；两者分别回答“业务逻辑有没有漂移”和“外部能力今天是否真的能工作”。

## Agent Run Checkpoint

`src/runs.js` 是当前唯一允许独立拆出的状态模块，因为 Agent Run 有独立的持久化/故障恢复生命周期。第一版只做原子 checkpoint，不自动重放 Tool：

```text
Agent step
   ↓
messages + trace + status
   ↓
0600 JSON temp file
   ↓ atomic rename
run_<id>.json
```

如果 checkpoint 写入失败，Agent 立即停止，避免“模型继续执行但 durable evidence 已丢失”。真正的 resume 要等所有 Tool 都具有稳定 request identity / idempotency 后再开启。

## Agent Trajectory Gate

`agent-trajectory-replay-v1` 独立验证 LLM Agent 层，而不是重复测试 `source_3d_asset` 内部状态机：

```text
source_3d_asset 正常调用      PASS
未知 Tool hallucination       PASS → tool_not_found
Provider failure observation  PASS
binary result rejection       PASS
runaway tool loop             PASS → maxSteps
```

当前 CI 因此同时守两层：

```text
Agent trajectory replay   5 cases
Workflow replay           5 cases
Unit / contract tests     34 tests
```

## Verified modal-3D Sidecar Adapter

2026-08-28 已用真实 `modal-3D-client` 与 `modal-3D` 执行：

```text
real modal-2D candidate PNG
        ↓
AgentScape-agent
        ↓
modal-3D-client
        ↓
Provider InputConditioner / BiRefNet
        ↓
FastSAM3D++
        ↓
verified GLB
```

结果：

```text
jobId              agent3d_193038dd45916f91ea1b4437
artifactId         art_adf3b2520c19532daad5197a984e2
artifact bytes     7,525,252
GLB SHA-256        543694494b4482d053d1eaae47e84cdb08f9170287ad319f6be66d40fa0fb667
conditioning       birefnet / birefnet-general-lite
foreground ratio   0.2843132019042969
source SHA-256     MATCH
elapsed            220643 ms
```

Adapter 对 Artifact/conditioning 使用公共字段白名单，防止 Sidecar/Provider 私有 path/cache 在未来版本中意外泄漏到 Agent。

## Capability Preflight

2D/3D Adapter 在第一次提交 Job 前会读取 Sidecar 的公开 `/v1/models`，并在 Adapter 生命周期内缓存结果：

```text
local request validation
        ↓
GET /v1/models
        ↓
model / profile available?
   ├─ no  → capability_unavailable
   └─ yes → submit durable Job
```

2026-08-28 已对真实 Sidecar 验证：

```text
modal-2D  sana-sprint-1.6b                  available
modal-3D  fastsam3d-plus-plus/recommended   enabled
```

未知 model/profile 会在提交 Job 前 fail-closed；本地图片 digest 错误甚至不会触发 capability 网络请求。


## Verified One-shot Text → World

2026-08-28 已完成不经过 `modal-inference-hub` / Connector 的真实一次到底链路：

```text
Text
  ↓
modal-2D-client / SANA-Sprint 1.6B
  ↓
automatic candidate selection
  ↓
modal-3D-client / FastSAM3D++
  ↓
verified GLB
  ↓
AgentScape ArtifactRegistry + SHA-256 verify
  ↓
AssetCompiler / Asset admission
  ↓
canonical WorldPipeline
  ↓
ON table placement
  ↓
WorldRuntime support verification
```

运行入口：

```bash
AGENT_ONE_SHOT_2D_TOKEN=... \
AGENT_ONE_SHOT_3D_TOKEN=... \
npm run experiment:world
```

真实结果：

```text
status               completed
stage                verified
elapsed              206.432 s
GLB bytes            7,853,800
GLB SHA-256          120a9658ffad6a6c3d7232b9a717ce9737279334d87ce04b245c8e5085b0422e
Asset admission      provisional (BUDGET_RENDER_VERTICES)
World admission      provisional (ASSET_PROVISIONAL)
relation admission   ready
ON table             verified
```

`provisional` 不等于失败：当前生成 GLB 超过既有 render-vertex 预算，因此 Asset 保持 provisional；World 继承该 admission，但空间关系与 Runtime 支撑验证均通过。One-shot 只在 `world.verified=true` 时返回 `completed`。


## Verified Cancellation Propagation

2026-08-28 已把用户取消从 Agent Run 贯穿到真实 2D/3D Sidecar：

```text
AbortSignal
   ↓
Agent Run
   ↓
high-level Tool
   ↓
source_3d_asset
   ↓
2D / VLM / 3D adapter
   ↓
DELETE deterministic jobId
   ↓
Sidecar cancel_requested
   ↓
remote cancellation
   ↓
cancelled
```

关键语义：

```text
pre-abort                     → 0 LLM / 0 Provider side effects
cancel during Tool            → Agent 不再进入下一轮 LLM
cancel during 2D submit/poll  → Sidecar cancel_requested
cancel during 3D submit/poll  → Sidecar cancelled / remote.cancelled
checkpoint                    → status=cancelled
```

真实验证：

```text
2D jobId      agent2d_9f0b6f515b54d6a0b9775a27
2D final      cancel_requested
3D jobId      agent3d_bf6c61e8ca725a8bd7b1e7b0
3D appeared   running
3D final      cancelled
3D errorCode  remote.cancelled
3D retryable  false
```

为保证 submit-in-flight 期间仍可取消，2D/3D Sidecar 都保留 `cancel_requested` 意图；3D Sidecar 的阻塞 submit 已移入 threadpool，避免 async HTTP event loop 被 Modal I/O 卡死。

## Verified Multi-candidate VLM One-shot

在单候选 One-shot 基线之上，已验证真实多候选视觉选择链：

```text
Text
  ↓
4 × modal-2D-client / SANA-Sprint 1.6B
  ↓
OpenAI-compatible Vision Ranker
  ↓
stepfun-ai/step-3.7-flash
  ↓
selected candidate
  ↓
modal-3D-client / FastSAM3D++
  ↓
verified GLB → Asset → World → Runtime
```

运行时需要额外提供 OpenAI-compatible VLM 配置，凭据不写入仓库：

```bash
AGENTSCAPE_LLM_BASE_URL=... \
AGENTSCAPE_LLM_API_KEY=... \
AGENTSCAPE_LLM_MODEL=stepfun-ai/step-3.7-flash \
AGENT_ONE_SHOT_2D_TOKEN=... \
AGENT_ONE_SHOT_3D_TOKEN=... \
npm run experiment:world
```

2026-08-28 真实结果：

```text
status                 completed
stage                  verified
elapsed                169.763 s
candidateCount         4
2D seeds               42 / 73 / 104 / 135
VLM                     stepfun-ai/step-3.7-flash
selected seed           42
GLB bytes               7,853,800
GLB SHA-256             120a9658ffad6a6c3d7232b9a717ce9737279334d87ce04b245c8e5085b0422e
Asset admission         provisional (BUDGET_RENDER_VERTICES)
World admission         provisional (ASSET_PROVISIONAL)
relation admission      ready
ON table                 verified
```

另外修正了 `modal-2D-client` 的调用语义：Sidecar 的 `job_id` 是唯一 ID，而不是幂等 request key，因此 `createModal2DAdapter()` 现在为每次 `generateImages()` 调用创建独立 run scope；同一次调用中的候选仍稳定可追踪，不同 Run 不再复用历史中断 job。

## Verified Cross-process Resume + Timing Baseline

2026-08-28 已验证跨进程 Tool resume：进程 A 在 `tool_pending` 后故意 `exit=86`，进程 B 使用同一个 `runId / executionId` 自动恢复，不重新询问 LLM，也不创建重复 Sidecar Job。

```text
Process A crash window       39.099 ms
Process B resume process     38.681 ms
RunStore load                 0.228 ms
pendingTool checkpoint        0.977 ms
recovered Tool execution      0.570 ms
Tool-complete checkpoint      0.459 ms
gateway-ready checkpoint     0.299 ms
next Gateway                  0.095 ms
terminal checkpoint           1.034 ms
```

恢复模型：

```text
checkpoint pendingTool
        │
        ├─ runId
        ├─ executionId
        ├─ tool name / args
        └─ nextToolIndex
        │
        ▼
process restart
        │
        ▼
load checkpoint
        │
        ▼
same executionId
        │
        ├─ 2D Sidecar existing-job lookup / rebind
        └─ 3D Sidecar existing-job lookup / rebind
```

同日完成的首次真实生产链 timing 基准中，4 个 candidate 曾被映射成 4 个独立 GPU Job，2D slice 为 `54.199s`。该数字现在只作为 **pre-batch baseline**，不再代表当前实现。


3D 细分：

```text
preflight            4.036 ms
existing-job lookup  1.471 ms
submit            7062.667 ms
wait            170346.305 ms
artifact fetch       24.632 ms
total            177445.086 ms
```



## Verified 2D Candidate Batch

2026-08-28，2D candidate generation 从“每张图一个远端 GPU Job”迁移为“一个 batch Job / 一个 warm SANA worker”：

```text
Text prompt
  ↓
seeds=[42,73,104,135]
  ↓
ONE modal-2D-client Job
  ↓
ONE modal-2D submit_batch FunctionCall
  ↓
ONE SanaSprintWorker / L40S
  ├─ seed 42
  ├─ seed 73
  ├─ seed 104
  └─ seed 135
```

最终连续 cold → warm 实测：

```text
pre-batch baseline             ~54.2 s
cold batch                      43.362 s
warm batch                       9.075 s
warm provider batch compute      6.782 s
```

Warm worker 内单图 inference：

| Seed | Inference |
|---:|---:|
| 42 | 1.352 s |
| 73 | 1.353 s |
| 104 | 1.240 s |
| 135 | 2.428 s |

Warm batch 只创建一个 `agent2d_*` Job，`providerBatch.workerReused=true` 且 `workerLoadMs=null`。Provider worker 保温窗口为 300s；generation hot path 不再同步执行 `prefetch.remote()`。同一个 `executionId` 恢复时会 rebind 同一个 batch Job，而不是重复创建 4 个 GPU Job。
