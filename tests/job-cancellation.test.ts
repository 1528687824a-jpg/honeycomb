import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JobCancelledError,
  __jobCancellationTestInternals,
  isJobCancellationError,
  watchJobCancellation
} from "../apps/dbos-worker/src/job-cancellation";

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

test("job cancellation watcher aborts after persisted status changes", async () => {
  let cancelled = false;
  const watcher = await watchJobCancellation({
    jobId: "job-cancel-test",
    pollMs: 100,
    loadJob: async () => ({ status: cancelled ? "cancelled" : "running" } as never)
  });
  assert.equal(watcher.signal.aborted, false);
  cancelled = true;
  await wait(140);
  assert.equal(watcher.signal.aborted, true);
  assert.equal(isJobCancellationError(watcher.signal.reason), true);
  watcher.dispose();
});

test("disposed cancellation watcher does not abort", async () => {
  let cancelled = false;
  const watcher = await watchJobCancellation({
    jobId: "job-dispose-test",
    pollMs: 100,
    loadJob: async () => ({ status: cancelled ? "cancelled" : "running" } as never)
  });
  watcher.dispose();
  cancelled = true;
  await wait(140);
  assert.equal(watcher.signal.aborted, false);
});

test("job cancellation helpers normalize poll settings and errors", () => {
  assert.equal(__jobCancellationTestInternals.cancellationPollMs({}), 750);
  assert.equal(__jobCancellationTestInternals.cancellationPollMs({
    HONEYCOMB_JOB_CANCELLATION_POLL_MS: "250"
  }), 250);
  assert.equal(isJobCancellationError(new JobCancelledError()), true);
  assert.equal(isJobCancellationError(new Error("other")), false);
});
