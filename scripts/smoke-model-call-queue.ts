import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getModelCallQueueOverview,
  releaseModelCallSlot,
  tryAcquireModelCallSlot
} from "../packages/db/src/model-call-queue";
import {
  clearJobExecutionQueue,
  createJob,
  getJob,
  setJobExecutionQueue
} from "../packages/db/src/jobs";
import { runMigrations } from "../packages/db/src/migrate";
import { closePool, pool } from "../packages/db/src/pool";

const marker = randomUUID().replace(/-/g, "");
const limits = { global: 2, provider: 1, agent: 1 };
let smokeJobId: string | null = null;

async function main() {
  await runMigrations();
  const job = await createJob({
    rawPrompt: `Model call queue smoke ${marker}`,
    displayTitle: "Model call queue smoke",
    ingressOrigin: "cli",
    requesterId: "model-call-queue-smoke"
  });
  smokeJobId = job.id;

  const request = (input: {
    suffix: string;
    providerId: string;
    agentId: string;
    ownerId: string;
  }) => tryAcquireModelCallSlot({
    requestKey: `${job.id}:${input.suffix}`,
    idempotencyKey: `${job.id}:${input.suffix}`,
    jobId: job.id,
    routeIndex: 0,
    agentId: input.agentId,
    providerId: input.providerId,
    ownerId: input.ownerId,
    limits,
    queueLeaseSeconds: 30,
    leaseSeconds: 60,
    retryAfterMs: 100
  });

  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const ownerC = randomUUID();
  const first = await request({
    suffix: "a",
    providerId: "queue-smoke-provider-a",
    agentId: "queue-smoke-agent-a",
    ownerId: ownerA
  });
  assert.equal(first.acquired, true);

  const sameProvider = await request({
    suffix: "b",
    providerId: "queue-smoke-provider-a",
    agentId: "queue-smoke-agent-b",
    ownerId: ownerB
  });
  assert.equal(sameProvider.acquired, false);
  assert.equal(sameProvider.state.blockingScopes.includes("provider"), true);

  const independent = await request({
    suffix: "c",
    providerId: "queue-smoke-provider-b",
    agentId: "queue-smoke-agent-c",
    ownerId: ownerC
  });
  assert.equal(independent.acquired, true);

  await setJobExecutionQueue(job.id, sameProvider.state);
  assert.equal((await getJob(job.id))?.executionQueue?.status, "queued");

  const overview = await getModelCallQueueOverview();
  assert.equal(overview.summary.acquired >= 2, true);
  assert.equal(overview.summary.queued >= 1, true);

  await releaseModelCallSlot({
    requestKey: `${job.id}:a`,
    ownerId: ownerA,
    reason: "smoke_release"
  });
  const promoted = await request({
    suffix: "b",
    providerId: "queue-smoke-provider-a",
    agentId: "queue-smoke-agent-b",
    ownerId: ownerB
  });
  assert.equal(promoted.acquired, true);

  await releaseModelCallSlot({
    requestKey: `${job.id}:b`,
    ownerId: ownerB,
    reason: "smoke_release"
  });
  await releaseModelCallSlot({
    requestKey: `${job.id}:c`,
    ownerId: ownerC,
    reason: "smoke_release"
  });
  await clearJobExecutionQueue(job.id, `${job.id}:b`);

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    checked: [
      "global_limit",
      "provider_limit",
      "independent_provider_parallelism",
      "queued_job_state",
      "queue_overview",
      "release_and_promotion"
    ]
  }, null, 2));

}

async function cleanup() {
  if (!smokeJobId) return;
  await pool.query(`delete from agent.model_call_queue where job_id = $1`, [smokeJobId]);
  await pool.query(`delete from agent.job_events where job_id = $1`, [smokeJobId]);
  await pool.query(`delete from agent.jobs where id = $1`, [smokeJobId]);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error(error));
    await closePool();
  });
