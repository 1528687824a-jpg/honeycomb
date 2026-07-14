import { pool } from "./pool";

export type JobExecutionUpdateEvent = {
  eventId: string;
  jobId: string;
  createdAt: string;
};

export type JobExecutionUpdateWindow = {
  afterEventId: string;
  cursor: string;
  events: JobExecutionUpdateEvent[];
  hasMore: boolean;
};

function toIso(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export async function getLatestJobExecutionUpdateCursor() {
  const result = await pool.query(
    `select coalesce(max(stream_id), 0)::text as cursor from agent.job_events`
  );
  return String(result.rows[0]?.cursor ?? "0");
}

export async function getJobExecutionUpdateWindow(input: {
  afterEventId: string;
  limit?: number;
}): Promise<JobExecutionUpdateWindow> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const result = await pool.query(
    `select stream_id::text as event_id, job_id, created_at
     from agent.job_events
     where stream_id > $1::bigint
     order by stream_id asc
     limit $2`,
    [input.afterEventId, limit + 1]
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const events = rows.map((row): JobExecutionUpdateEvent => ({
    eventId: String(row.event_id),
    jobId: row.job_id,
    createdAt: toIso(row.created_at)
  }));

  return {
    afterEventId: input.afterEventId,
    cursor: events.at(-1)?.eventId ?? input.afterEventId,
    events,
    hasMore
  };
}
