# Real-time task execution updates

Honeycomb exposes a durable Server-Sent Events (SSE) invalidation stream for the task list:

```text
GET /jobs/execution-updates/stream
Accept: text/event-stream
Authorization: Bearer <machine token>
Last-Event-ID: <optional durable cursor>
```

The stream never sends model prompts, provider payloads, approval input, errors, API keys, tokens, or file paths. It sends only task IDs whose durable records changed. The client then refreshes those IDs through `POST /jobs/execution-summaries/query`.

## Events

`ready` is the first event. Its `id` and `data.cursor` identify the current durable `agent.job_events.stream_id` boundary. This dedicated sequence is assigned under a transaction-scoped database lock, so concurrent event writers cannot expose a higher cursor before an earlier event commits.

- A new connection without `Last-Event-ID` receives `resyncRequired=true`. Load the current task page and summaries after the stream is ready.
- A reconnect with a valid cursor receives `resyncRequired=false`; changes after that cursor are replayed.
- A cursor ahead of the restored database is reset to the latest cursor and requires a full resync.

`jobs_changed` contains:

```json
{
  "version": "honeycomb.job-execution-update-stream.v1",
  "cursor": "12345",
  "jobIds": ["JOB-A", "JOB-B"],
  "eventCount": 4,
  "occurredAt": "2026-07-14T12:00:00.000Z",
  "hasMore": false
}
```

Multiple database events for one task are coalesced into one task ID per batch. `stream_error` reports only a stable retryable code; raw database errors remain server-side. Heartbeats are SSE comments and carry the current cursor.

Optional bounded query settings are `limit` (1-500), `pollMs` (250-10000), and `heartbeatMs` (5000-60000). One API process accepts eight streams by default; configure `HONEYCOMB_JOB_UPDATE_STREAM_MAX_CONNECTIONS` from 1 to 100.

## Client flow

1. Open the authenticated stream and wait for `ready`.
2. If `resyncRequired`, call `GET /jobs?...&includeExecutionSummaries=true`.
3. On `jobs_changed`, intersect `jobIds` with visible tasks and call the revision-based summary query.
4. Remember the latest event ID. Send it as `Last-Event-ID` after a disconnect.
5. Keep a low-frequency full refresh as a final UI safeguard; the stream is an invalidation hint and the summary endpoint remains authoritative.

The desktop uses authenticated `fetch` streaming, so its machine token is never placed in the URL.

## EventSource tickets

Native browser `EventSource` cannot set an authorization header. Obtain a short-lived, signed, exact-path ticket first:

```text
POST /auth/stream-ticket
Authorization: Bearer <machine token>

{ "scope": "job_execution_updates" }
```

Then connect with `stream_ticket=<ticket>`. Session event streams use the same endpoint with `{ "scope": "session_events", "sessionId": "..." }`. Tickets default to 60 seconds, are capped at five minutes, work only for `GET` and the issued path, and contain no machine token. The previous long-lived `access_token` query parameter is no longer accepted.

An established stream may remain open after the ticket expires. A later reconnect must obtain a new ticket.

## Verification

Pure cursor, coalescing, parser, authentication, and URL-leak tests run in the unit suite. With PostgreSQL running:

```powershell
npm run smoke:job-execution-updates
```

The smoke verifies monotonic global cursors, bounded backlog windows, and resume behavior without calling a model provider.
