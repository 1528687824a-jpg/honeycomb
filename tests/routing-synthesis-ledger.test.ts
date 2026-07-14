import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEventRecord } from "../packages/shared/src/types";
import {
  completedDiscussionRoundNumbers,
  selectRoutingOutputEvents
} from "../apps/dbos-worker/src/routing-synthesis-ledger";

function event(input: {
  seq: number;
  eventType: string;
  stageId?: string | null;
  routingMode?: string;
  attemptNo?: number;
  artifactId?: string;
  roundNo?: number;
}): AgentEventRecord {
  return {
    id: `event-${input.seq}`,
    sessionId: "session-routing",
    jobId: "job-routing",
    stageId: input.stageId ?? null,
    seq: input.seq,
    actor: input.stageId ? `${input.stageId}-agent` : "main-agent",
    eventType: input.eventType,
    payload: {
      routingMode: input.routingMode,
      attemptNo: input.attemptNo,
      outputArtifactId: input.artifactId,
      roundNo: input.roundNo
    },
    artifactId: input.artifactId ?? null,
    groupMessageId: null,
    feishuMessageId: null,
    createdAt: "2026-07-14T00:00:00.000Z"
  };
}

test("routing synthesis ignores replayed completion and discussion-round events", () => {
  const events = [
    event({
      seq: 4,
      eventType: "stage.agent_completed",
      stageId: "stage-1",
      routingMode: "master_slave_discussion",
      attemptNo: 1,
      artifactId: "artifact-1"
    }),
    event({
      seq: 2,
      eventType: "stage.agent_completed",
      stageId: "stage-1",
      routingMode: "master_slave_discussion",
      attemptNo: 1,
      artifactId: "artifact-1"
    }),
    event({
      seq: 3,
      eventType: "stage.agent_completed",
      stageId: "stage-2",
      routingMode: "classic_master_slave",
      attemptNo: 1,
      artifactId: "artifact-classic"
    }),
    event({ seq: 5, eventType: "discussion.round_completed", roundNo: 2 }),
    event({ seq: 6, eventType: "discussion.round_completed", roundNo: 1 }),
    event({ seq: 7, eventType: "discussion.round_completed", roundNo: 2 })
  ];

  assert.deepEqual(
    selectRoutingOutputEvents(events, "master_slave_discussion").map((entry) => entry.seq),
    [2]
  );
  assert.deepEqual(completedDiscussionRoundNumbers(events), [1, 2]);
});
