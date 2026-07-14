import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createToolApprovalRequest,
  decideToolApproval
} from "../packages/db/src/approvals";
import { getJobExecutionState } from "../packages/db/src/job-execution-state";
import { createJob, setJobStatus } from "../packages/db/src/jobs";
import { runMigrations } from "../packages/db/src/migrate";
import {
  createPipelineStages,
  markStageCompleted,
  setStageStatus
} from "../packages/db/src/pipeline";
import { createPlanForJob } from "../packages/db/src/plans";
import { closePool, pool } from "../packages/db/src/pool";

const marker = randomUUID().replace(/-/g, "");
let smokeJobId: string | null = null;

async function main() {
  await runMigrations();
  const job = await createJob({
    rawPrompt: `Unified task execution state smoke ${marker}`,
    displayTitle: "Unified task state smoke",
    ingressOrigin: "cli",
    requesterId: "job-execution-state-smoke"
  });
  smokeJobId = job.id;
  await setJobStatus(job.id, "running", { reason: "execution_state_smoke" });

  const stages = await createPipelineStages(job.id, [
    {
      stageType: "research",
      agentId: "research-agent",
      name: "Research",
      acceptanceCriteria: ["source collected"]
    },
    {
      stageType: "image",
      agentId: "image-agent",
      name: "Generate poster",
      acceptanceCriteria: ["image generated"]
    }
  ]);
  await markStageCompleted(stages[0].id);
  await setStageStatus(stages[1].id, "running");
  await createPlanForJob(job.id);

  const approval = await createToolApprovalRequest({
    jobId: job.id,
    stageId: stages[1].id,
    agentId: "image-agent",
    toolName: "workspace.write",
    actionType: "write_file",
    riskLevel: "medium",
    reason: "Smoke approval"
  });
  assert.ok(approval);

  const blocked = await getJobExecutionState(job.id);
  assert.ok(blocked);
  assert.equal(blocked.job.phase, "waiting_for_approval");
  assert.equal(blocked.primaryBlocker?.code, "tool_approval_required");
  assert.equal(blocked.plan?.items.length, 2);
  assert.equal(blocked.progress.completedStages, 1);
  assert.equal(
    blocked.agents.find((agent) => agent.agentId === "image-agent")?.state,
    "waiting_for_approval"
  );
  assert.equal(blocked.runtime.approvals.entries[0]?.toolName, "workspace.write");
  assert.equal(Object.prototype.hasOwnProperty.call(blocked.runtime.approvals.entries[0] ?? {}, "command"), false);

  await decideToolApproval({
    approvalId: approval.id,
    status: "approved",
    decidedBy: "execution-state-smoke"
  });
  const running = await getJobExecutionState(job.id);
  assert.ok(running);
  assert.equal(running.job.phase, "running");
  assert.equal(running.runtime.approvals.pending, 0);
  assert.equal(running.agents.find((agent) => agent.agentId === "image-agent")?.state, "running");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    checks: [
      "unified_execution_state_reads_stages",
      "pending_approval_overrides_running_agent",
      "approval_payload_is_sanitized",
      "plan_items_are_included",
      "approval_resolution_updates_projection"
    ]
  }, null, 2));
}

async function cleanup() {
  if (!smokeJobId) return;
  await pool.query(`delete from agent.tool_approval_requests where job_id = $1`, [smokeJobId]);
  await pool.query(
    `delete from agent.task_plan_items where plan_id in (select id from agent.task_plans where job_id = $1)`,
    [smokeJobId]
  );
  await pool.query(`delete from agent.task_plans where job_id = $1`, [smokeJobId]);
  await pool.query(`delete from agent.agent_events where job_id = $1`, [smokeJobId]);
  await pool.query(`delete from agent.job_events where job_id = $1`, [smokeJobId]);
  await pool.query(`delete from agent.job_stages where job_id = $1`, [smokeJobId]);
  await pool.query(`delete from agent.jobs where id = $1`, [smokeJobId]);
}

main()
  .then(async () => {
    await cleanup();
    await closePool();
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exitCode = 1;
  });
