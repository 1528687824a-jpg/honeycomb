import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getJobExecutionUpdateWindow,
  getLatestJobExecutionUpdateCursor
} from "../packages/db/src/job-execution-updates";
import { appendJobEvent, createJob } from "../packages/db/src/jobs";
import { runMigrations } from "../packages/db/src/migrate";
import { closePool, pool } from "../packages/db/src/pool";

const marker = randomUUID().replace(/-/g, "");
const jobIds: string[] = [];

async function verifyCommittedCursorOrdering(firstJobId: string, secondJobId: string) {
  const first = await pool.connect();
  const second = await pool.connect();
  let firstTransactionOpen = false;
  let secondTransactionOpen = false;

  try {
    await first.query("begin");
    firstTransactionOpen = true;
    await second.query("begin");
    secondTransactionOpen = true;
    const firstInsert = await first.query(
      `insert into agent.job_events (job_id, event_type, payload)
       values ($1, 'smoke.execution_update.concurrent_first', $2::jsonb)
       returning stream_id::text as stream_id`,
      [firstJobId, JSON.stringify({ marker })]
    );
    let secondInsertSettled = false;
    const secondInsertPromise = second.query(
      `insert into agent.job_events (job_id, event_type, payload)
       values ($1, 'smoke.execution_update.concurrent_second', $2::jsonb)
       returning stream_id::text as stream_id`,
      [secondJobId, JSON.stringify({ marker })]
    ).then((result) => {
      secondInsertSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(secondInsertSettled, false);
    await first.query("commit");
    firstTransactionOpen = false;
    const secondInsert = await secondInsertPromise;
    await second.query("commit");
    secondTransactionOpen = false;

    const firstStreamId = BigInt(firstInsert.rows[0].stream_id);
    const secondStreamId = BigInt(secondInsert.rows[0].stream_id);
    assert.ok(secondStreamId > firstStreamId);
    return secondStreamId.toString();
  } finally {
    if (firstTransactionOpen) await first.query("rollback").catch(() => undefined);
    if (secondTransactionOpen) await second.query("rollback").catch(() => undefined);
    first.release();
    second.release();
  }
}

async function cleanup() {
  if (jobIds.length === 0) return;
  await pool.query(`delete from agent.agent_events where job_id = any($1::text[])`, [jobIds]);
  await pool.query(`delete from agent.job_events where job_id = any($1::text[])`, [jobIds]);
  await pool.query(`delete from agent.jobs where id = any($1::text[])`, [jobIds]);
}

async function main() {
  await runMigrations();
  const firstJob = await createJob({
    rawPrompt: `Execution update stream first ${marker}`,
    displayTitle: "Execution update stream first",
    ingressOrigin: "cli",
    requesterId: "job-execution-update-smoke"
  });
  const secondJob = await createJob({
    rawPrompt: `Execution update stream second ${marker}`,
    displayTitle: "Execution update stream second",
    ingressOrigin: "cli",
    requesterId: "job-execution-update-smoke"
  });
  jobIds.push(firstJob.id, secondJob.id);
  const baseline = await getLatestJobExecutionUpdateCursor();

  await appendJobEvent(firstJob.id, "smoke.execution_update.first", { marker });
  await appendJobEvent(firstJob.id, "smoke.execution_update.second", { marker });
  await appendJobEvent(secondJob.id, "smoke.execution_update.third", { marker });

  const firstWindow = await getJobExecutionUpdateWindow({
    afterEventId: baseline,
    limit: 2
  });
  assert.equal(firstWindow.events.length, 2);
  assert.deepEqual(firstWindow.events.map((event) => event.jobId), [firstJob.id, firstJob.id]);
  assert.equal(firstWindow.hasMore, true);

  const secondWindow = await getJobExecutionUpdateWindow({
    afterEventId: firstWindow.cursor,
    limit: 2
  });
  assert.equal(secondWindow.events.length, 1);
  assert.equal(secondWindow.events[0].jobId, secondJob.id);
  assert.equal(secondWindow.hasMore, false);
  assert.equal(await getLatestJobExecutionUpdateCursor(), secondWindow.cursor);
  const concurrencyCursor = await verifyCommittedCursorOrdering(firstJob.id, secondJob.id);
  assert.equal(await getLatestJobExecutionUpdateCursor(), concurrencyCursor);

  console.log(JSON.stringify({
    ok: true,
    jobIds,
    baseline,
    finalCursor: concurrencyCursor,
    checks: [
      "global_job_event_cursor_is_monotonic",
      "cursor_allocation_follows_transaction_commit_order",
      "bounded_windows_report_backlog",
      "disconnect_resume_skips_delivered_events"
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
