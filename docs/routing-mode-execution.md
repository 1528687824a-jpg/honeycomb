# Routing Mode Execution Contract

This document describes the current Windows backend behavior for Honeycomb's four routing modes.

## Behavior Matrix

| Mode | Production order | Context flow | Quality control | Main-agent finish |
| --- | --- | --- | --- | --- |
| `supervisor_pipeline` | One stage at a time | A passed output becomes the next stage input | `test-agent` reviews every attempt; retryable failures return to the same agent | Deterministic finalization after every stage passes |
| `pipeline` | One stage at a time | Every output becomes the next stage input | One final `test-agent` gate | Deterministic finalization |
| `classic_master_slave` | Independent stage model calls start concurrently | Workers receive the user request but no peer output | Optional final gate through `classicFinalGateEnabled` | `main-agent` synthesizes every worker output before the optional gate |
| `master_slave_discussion` | Participants speak in stage order for each configured round | Every next participant receives the ordered prior contribution artifacts | One final gate over the synthesis | `main-agent` synthesizes the deduplicated discussion ledger |

## Classic Parallel Execution

Classic mode starts all `runStageAgent` DBOS steps in deterministic stage order and waits with `Promise.allSettled`. This is the DBOS-supported pattern for parallel steps. A failed worker does not leave other worker rejections unobserved, and successful workers are persisted before the combined failure is reported.

Before fan-out, one batch budget check covers every worker model-call key. Global, provider, and per-agent concurrency limits remain enforced by the existing model-call queue.

## Discussion Context

Discussion mode carries an ordered list of prior output artifact IDs into each next participant. The worker activity loads those artifacts and adds bounded contribution summaries to both native OpenClaw and provider-direct prompts. The context is deduplicated and limited to the latest 24 artifacts.

Manual workflow replay can append duplicate completion events. Synthesis therefore deduplicates by output artifact and counts unique discussion rounds before validating that the ledger is complete.

## Recovery And Budgets

Logical model calls use the stable key:

```text
<jobId>:<stageId-or-job>:<attemptNo>:<actionType>
```

On manual resume, budget checks query those keys and charge capacity only for calls that do not already exist. A succeeded call can therefore be reused even when the job has reached its configured call limit.

Attempt state files are immutable:

```text
state/stage-001-writing-output-attempt-01.json
state/stage-001-writing-test-attempt-01.json
```

The previous stable names remain as latest-state compatibility copies:

```text
state/stage-001-writing-output.json
state/stage-001-writing-test.json
```

Artifact records point to immutable attempt files, so later retries do not rewrite historical artifact URIs.

## Panel-Agent Planning

Before each panel model request, Honeycomb now supplies:

- the current panel-agent `AGENTS.md` prompt snapshot when available;
- the latest linked task's final summary;
- adopted experience memory;
- the enabled child-agent capability catalog;
- explicit definitions for all four routing modes.

The panel agent must choose the mode and minimum sufficient specialist set from the current task. A still-image request should not select `video-agent`; a video request may add writing or image support only when those intermediate deliverables are actually needed.

## Regression Coverage

The unit suite verifies:

- strict pipeline ordering and handoff;
- supervisor test, repair, and pass order;
- real classic worker concurrency and all-settled failure handling;
- ordered discussion context across participants and rounds;
- cancellation and model-call budget stops;
- resume-aware model-call keys;
- replay ledger deduplication;
- immutable attempt state paths;
- panel prompt snapshot loading and main-agent preflight requirements.

DBOS parallel-step guidance: <https://docs.dbos.dev/typescript/tutorials/workflow-tutorial#running-steps-in-parallel>
