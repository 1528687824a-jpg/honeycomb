import type { AgentEventRecord } from "../../../packages/shared/src/types";

export type SynthesisRoutingMode = "classic_master_slave" | "master_slave_discussion";

function eventString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function eventNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function selectRoutingOutputEvents(
  events: AgentEventRecord[],
  routingMode: SynthesisRoutingMode
) {
  const selected: AgentEventRecord[] = [];
  const seen = new Set<string>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (
      event.eventType !== "stage.agent_completed" ||
      event.payload?.routingMode !== routingMode
    ) {
      continue;
    }
    const artifactId = eventString(event.payload?.outputArtifactId);
    const attemptNo = eventNumber(event.payload?.attemptNo);
    const key = artifactId ?? [event.stageId ?? "job", attemptNo ?? "unknown", event.actor].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(event);
  }
  return selected;
}

export function completedDiscussionRoundNumbers(events: AgentEventRecord[]) {
  return [...new Set(
    events
      .filter((event) => event.eventType === "discussion.round_completed")
      .map((event) => eventNumber(event.payload?.roundNo))
      .filter((roundNo): roundNo is number => roundNo !== null)
  )].sort((left, right) => left - right);
}
