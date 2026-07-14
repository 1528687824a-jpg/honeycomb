import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createToolApprovalRequest,
  decideToolApproval
} from "../packages/db/src/approvals";
import { queryJobExecutionSummaries } from "../packages/db/src/job-execution-summary";
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
const jobIds: string[] = [];

async function cleanup() {
  if (jobIds.length === 0) return;
  await pool.query(`delete from agent.tool_approval_requests where job_id = any($1::text[])`, [jobIds]);
  await pool.query(
    `delete from agent.task_plan_items
     where plan_id in (select id from agent.task_plans where job_id = any($1::text[]))`,
    [jobIds]
  );
  await pool.query(`delete from agent.task_plans where job_id = any($1::text[])`, [jobIds]);
  await pool.query(`delete from agent.agent_events where job_id = any($1::text[])`, [jobIds]);
  await pool.query(`delete from agent.job_events where job_id = any($1::text[])`, [jobIds]);
  await pool.query(`delete from agent.job_stages where job_id = any($1::text[])`, [jobIds]);
  await pool.query(`delete from agent.jobs where id = any($1::text[])`, [jobIds]);
}

async function main() {
  await runMigrations();
  const activeJob = await createJob({
    rawPrompt: `Batch execution summary active ${marker}`,
    displayTitle: "Batch summary active",
    ingressOrigin: "cli",
    requesterId: "job-execution-summary-smoke"
  });
  const queuedJob = await createJob({
    rawPrompt: `Batch execution summary queued ${marker}`,
    displayTitle: "Batch summary queued",
    ingressOrigin: "cli",
    requesterId: "job-execution-summary-smoke"
  });
  jobIds.push(activeJob.id, queuedJob.id);
  await setJobStatus(activeJob.id, "running", { reason: "execution_summary_smoke" });
  await setJobStatus(queuedJob.id, "queued", { reason: "execution_summary_smoke" });

  const stages = await createPipelineStages(activeJob.id, [
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
      acceptanceCriteria: ["poster generated"]
    }
  ]);
  await markStageCompleted(stages[0].id);
  await setStageStatus(stages[1].id, "running");
  await createPlanForJob(activeJob.id);
  const approval = await createToolApprovalRequest({
    jobId: activeJob.id,
    stageId: stages[1].id,
    agentId: "image-agent",
    toolName: "workspace.write",
    actionType: "write_file",
    riskLevel: "medium",
    reason: "Batch summary approval",
    command: "must-not-appear-in-summary",
    input: { apiKey: "must-not-appear" }
  });
  assert.ok(approval);

  const missingId = `JOB-MISSING-${marker}`;
  const first = await queryJobExecutionSummaries({
    jobIds: [queuedJob.id, activeJob.id, missingId]
  });
  assert.equal(first.requested, 3);
  assert.equal(first.returned, 2);
  assert.deepEqual(first.summaries.map((summary) => summary.jobId), [queuedJob.id, activeJob.id]);
  assert.deepEqual(first.missingJobIds, [missingId]);
  assert.equal(first.summaries[0].phase, "queued");
  assert.equal(first.summaries[1].phase, "waiting_for_approval");
  assert.equal(first.summaries[1].progress.completedStages, 1);
  assert.equal(JSON.stringify(first).includes("must-not-appear"), false);

  const unchanged = await queryJobExecutionSummaries({
    jobIds: [queuedJob.id, activeJob.id],
    knownRevisions: first.revisions
  });
  assert.equal(unchanged.returned, 0);
  assert.deepEqual(unchanged.unchangedJobIds, [queuedJob.id, activeJob.id]);

  await decideToolApproval({
    approvalId: approval.id,
    status: "approved",
    decidedBy: "execution-summary-smoke"
  });
  await markStageCompleted(stages[1].id);
  const changed = await queryJobExecutionSummaries({
    jobIds: [queuedJob.id, activeJob.id],
    knownRevisions: first.revisions
  });
  assert.equal(changed.returned, 1);
  assert.equal(changed.summaries[0].jobId, activeJob.id);
  assert.notEqual(changed.summaries[0].revision, first.revisions[activeJob.id]);
  assert.deepEqual(changed.unchangedJobIds, [queuedJob.id]);

  console.log(JSON.stringify({
    ok: true,
    jobIds,
    checks: [
      "batch_query_preserves_requested_order",
      "missing_jobs_are_reported",
      "summary_payload_is_sanitized",
      "known_revisions_suppress_unchanged_jobs",
      "stage_and_approval_changes_update_revision"
    ]
  }, null, 2));
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
