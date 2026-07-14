import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  getJobExecutionUpdateWindow,
  getLatestJobExecutionUpdateCursor,
  type JobExecutionUpdateWindow
} from "../../../packages/db/src/job-execution-updates";
import {
  JOB_EXECUTION_UPDATE_STREAM_VERSION,
  isJobExecutionUpdateCursor,
  type JobExecutionUpdateNotice,
  type JobExecutionUpdateReady,
  type JobExecutionUpdateStreamError
} from "../../../packages/shared/src/job-execution-updates";

const eventCursorSchema = z.string().trim().refine(isJobExecutionUpdateCursor, {
  message: "invalid_job_execution_update_cursor"
});
const streamQuerySchema = z.object({
  afterEventId: eventCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  pollMs: z.coerce.number().int().min(250).max(10000).optional(),
  heartbeatMs: z.coerce.number().int().min(5000).max(60000).optional()
});

export type JobExecutionUpdateStreamCursor = {
  cursor: string;
  resyncRequired: boolean;
  reason: JobExecutionUpdateReady["reason"];
};

export function resolveJobExecutionUpdateStreamCursor(
  latestCursor: string,
  requestedCursor?: string | null
): JobExecutionUpdateStreamCursor {
  const latest = BigInt(latestCursor);
  if (!requestedCursor) {
    return {
      cursor: latest.toString(),
      resyncRequired: true,
      reason: "initial_snapshot_required"
    };
  }

  const requested = BigInt(requestedCursor);
  if (requested > latest) {
    return {
      cursor: latest.toString(),
      resyncRequired: true,
      reason: "cursor_ahead"
    };
  }

  return {
    cursor: requested.toString(),
    resyncRequired: false,
    reason: null
  };
}

export function projectJobExecutionUpdateNotice(
  window: JobExecutionUpdateWindow
): JobExecutionUpdateNotice | null {
  if (window.events.length === 0) return null;
  return {
    version: JOB_EXECUTION_UPDATE_STREAM_VERSION,
    cursor: window.cursor,
    jobIds: [...new Set(window.events.map((event) => event.jobId))],
    eventCount: window.events.length,
    occurredAt: window.events.at(-1)!.createdAt,
    hasMore: window.hasMore
  };
}

function environmentInteger(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function writeSseEvent(response: Response, event: string, data: unknown, id?: string) {
  return response.write(
    `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

export type JobExecutionUpdateStreamDependencies = {
  getLatestCursor?: typeof getLatestJobExecutionUpdateCursor;
  getUpdateWindow?: typeof getJobExecutionUpdateWindow;
  maxConnections?: number;
};

export function registerJobExecutionUpdateStream(
  app: Express,
  dependencies: JobExecutionUpdateStreamDependencies = {}
) {
  const getLatestCursor = dependencies.getLatestCursor ?? getLatestJobExecutionUpdateCursor;
  const getUpdateWindow = dependencies.getUpdateWindow ?? getJobExecutionUpdateWindow;
  const maxConnections = dependencies.maxConnections ?? environmentInteger(
    "HONEYCOMB_JOB_UPDATE_STREAM_MAX_CONNECTIONS",
    8,
    1,
    100
  );
  let activeConnections = 0;

  app.get("/jobs/execution-updates/stream", async (request: Request, response: Response, next) => {
    let connectionReserved = false;
    let closed = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (connectionReserved) {
        activeConnections -= 1;
        connectionReserved = false;
      }
    };

    try {
      if (activeConnections >= maxConnections) {
        response.setHeader("retry-after", "5");
        response.status(503).json({ error: "job_execution_update_stream_capacity" });
        return;
      }
      activeConnections += 1;
      connectionReserved = true;

      const query = streamQuerySchema.parse(request.query);
      const headerCursor = request.header("last-event-id")?.trim() || null;
      const requestedCursor = eventCursorSchema.nullable().parse(headerCursor ?? query.afterEventId ?? null);
      const latestCursor = await getLatestCursor();
      const initial = resolveJobExecutionUpdateStreamCursor(latestCursor, requestedCursor);
      const pollMs = query.pollMs ?? 1000;
      const heartbeatMs = query.heartbeatMs ?? 15000;
      const limit = query.limit ?? 100;
      let cursor = initial.cursor;
      let inFlight = false;
      let pollFailureVisible = false;

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      response.on("close", cleanup);
      request.on("aborted", cleanup);
      const ready: JobExecutionUpdateReady = {
        version: JOB_EXECUTION_UPDATE_STREAM_VERSION,
        cursor,
        resyncRequired: initial.resyncRequired,
        reason: initial.reason,
        pollMs,
        heartbeatMs,
        batchLimit: limit
      };
      if (
        !response.write(`retry: ${Math.max(pollMs, 1000)}\n\n`) ||
        !writeSseEvent(response, "ready", ready, cursor)
      ) {
        cleanup();
        response.end();
        return;
      }

      const pump = async () => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          for (let batchIndex = 0; batchIndex < 4 && !closed; batchIndex += 1) {
            const window = await getUpdateWindow({ afterEventId: cursor, limit });
            const notice = projectJobExecutionUpdateNotice(window);
            if (!notice) break;
            cursor = notice.cursor;
            if (!writeSseEvent(response, "jobs_changed", notice, cursor)) {
              cleanup();
              response.end();
              break;
            }
            if (!notice.hasMore) break;
          }
          pollFailureVisible = false;
        } catch {
          if (!pollFailureVisible && !closed) {
            const streamError: JobExecutionUpdateStreamError = {
              version: JOB_EXECUTION_UPDATE_STREAM_VERSION,
              cursor,
              code: "job_execution_update_poll_failed",
              retryable: true
            };
            if (!writeSseEvent(response, "stream_error", streamError, cursor)) {
              cleanup();
              response.end();
            }
            pollFailureVisible = true;
          }
        } finally {
          inFlight = false;
        }
      };

      await pump();
      if (closed) return;
      pollTimer = setInterval(() => void pump(), pollMs);
      heartbeatTimer = setInterval(() => {
        if (!closed && !response.write(`: heartbeat ${new Date().toISOString()} cursor=${cursor}\n\n`)) {
          cleanup();
          response.end();
        }
      }, heartbeatMs);
    } catch (error) {
      cleanup();
      if (response.headersSent) {
        response.end();
        return;
      }
      next(error);
    }
  });
}
