export const JOB_EXECUTION_UPDATE_STREAM_VERSION = "honeycomb.job-execution-update-stream.v1" as const;
export const JOB_EXECUTION_UPDATE_CURSOR_MAX = "9223372036854775807" as const;

export function isJobExecutionUpdateCursor(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{1,20}$/.test(value) &&
    BigInt(value) <= BigInt(JOB_EXECUTION_UPDATE_CURSOR_MAX);
}

export type JobExecutionUpdateReady = {
  version: typeof JOB_EXECUTION_UPDATE_STREAM_VERSION;
  cursor: string;
  resyncRequired: boolean;
  reason: "initial_snapshot_required" | "cursor_ahead" | null;
  pollMs: number;
  heartbeatMs: number;
  batchLimit: number;
};

export type JobExecutionUpdateNotice = {
  version: typeof JOB_EXECUTION_UPDATE_STREAM_VERSION;
  cursor: string;
  jobIds: string[];
  eventCount: number;
  occurredAt: string;
  hasMore: boolean;
};

export type JobExecutionUpdateStreamError = {
  version: typeof JOB_EXECUTION_UPDATE_STREAM_VERSION;
  cursor: string;
  code: "job_execution_update_poll_failed";
  retryable: true;
};

export type JobExecutionUpdateStreamEvent =
  | { type: "ready"; data: JobExecutionUpdateReady }
  | { type: "jobs_changed"; data: JobExecutionUpdateNotice }
  | { type: "stream_error"; data: JobExecutionUpdateStreamError };
