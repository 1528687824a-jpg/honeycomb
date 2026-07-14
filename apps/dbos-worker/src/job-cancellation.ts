import { getJob } from "../../../packages/db/src/jobs";

export class JobCancelledError extends Error {
  constructor() {
    super("job_cancelled");
    this.name = "JobCancelledError";
  }
}

function cancellationPollMs(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number(env.HONEYCOMB_JOB_CANCELLATION_POLL_MS);
  return Number.isFinite(parsed) && parsed >= 100
    ? Math.min(5_000, Math.floor(parsed))
    : 750;
}

export function isJobCancellationError(error: unknown) {
  return error instanceof JobCancelledError ||
    (error instanceof Error && error.message === "job_cancelled");
}

export async function watchJobCancellation(input: {
  jobId: string;
  pollMs?: number;
  loadJob?: typeof getJob;
}) {
  const controller = new AbortController();
  const loadJob = input.loadJob ?? getJob;
  const pollMs = Math.max(100, Math.min(5_000, input.pollMs ?? cancellationPollMs()));
  let disposed = false;
  let timer: NodeJS.Timeout | null = null;

  const check = async () => {
    if (disposed || controller.signal.aborted) return;
    try {
      const job = await loadJob(input.jobId);
      if (disposed || controller.signal.aborted) return;
      if (!job || job.status === "cancelled") {
        controller.abort(new JobCancelledError());
        return;
      }
    } catch {
      // A transient database read failure must not incorrectly cancel a live provider request.
    }
    if (!disposed && !controller.signal.aborted) {
      timer = setTimeout(() => void check(), pollMs);
      timer.unref?.();
    }
  };

  const initialJob = await loadJob(input.jobId);
  if (!initialJob || initialJob.status === "cancelled") {
    throw new JobCancelledError();
  }
  timer = setTimeout(() => void check(), pollMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

export const __jobCancellationTestInternals = {
  cancellationPollMs
};
