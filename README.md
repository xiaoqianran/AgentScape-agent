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
Unit / contract tests     29 tests
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
