import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIN_JOB_MODEL_CALLS,
  minimumModelCallsForRoutingMode,
  normalizeJobModelCallBudget
} from "../packages/shared/src/routing-budget";
import type { RoutingMode } from "../packages/shared/src/types";

test("minimumModelCallsForRoutingMode covers all routing modes", () => {
  const expected: Record<RoutingMode, number> = {
    pipeline: 5,
    supervisor_pipeline: 8,
    classic_master_slave: 4,
    master_slave_discussion: 10
  };

  for (const [routingMode, minimum] of Object.entries(expected) as [RoutingMode, number][]) {
    assert.equal(
      minimumModelCallsForRoutingMode({
        routingMode,
        executableStageCount: 4,
        discussionRounds: 2
      }),
      minimum
    );
  }

  assert.equal(
    minimumModelCallsForRoutingMode({
      routingMode: "classic_master_slave",
      executableStageCount: 4,
      classicFinalGateEnabled: true
    }),
    5
  );
});

test("normalizeJobModelCallBudget raises too-low task budgets", () => {
  for (const routingMode of [
    "pipeline",
    "supervisor_pipeline",
    "classic_master_slave",
    "master_slave_discussion"
  ] as RoutingMode[]) {
    assert.equal(
      normalizeJobModelCallBudget({
        requestedMaxModelCalls: 2,
        routingMode,
        executableStageCount: 4,
        discussionRounds: 2
      }),
      MIN_JOB_MODEL_CALLS
    );
  }
});

test("normalizeJobModelCallBudget preserves explicit larger budgets", () => {
  assert.equal(
    normalizeJobModelCallBudget({
      requestedMaxModelCalls: 42,
      routingMode: "master_slave_discussion",
      executableStageCount: 4,
      discussionRounds: 2
    }),
    42
  );
});
