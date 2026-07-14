import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateSpendReservation,
  parseJobSpendBudget,
  resolveSpendLimitPolicy
} from "../packages/shared/src/spend-policy";

test("spend limits are opt-in and provider metadata overrides the global provider limit", () => {
  assert.deepEqual(resolveSpendLimitPolicy({ env: {} }), {
    enabled: false,
    jobLimitUsd: null,
    userDailyLimitUsd: null,
    providerDailyLimitUsd: null
  });
  assert.deepEqual(resolveSpendLimitPolicy({
    jobLimitUsd: 2,
    providerMetadata: { spendLimits: { dailyUsd: 5 } },
    env: {
      HONEYCOMB_USER_DAILY_MAX_COST_USD: "3",
      HONEYCOMB_PROVIDER_DAILY_MAX_COST_USD: "9"
    }
  }), {
    enabled: true,
    jobLimitUsd: 2,
    userDailyLimitUsd: 3,
    providerDailyLimitUsd: 5
  });
  assert.deepEqual(resolveSpendLimitPolicy({
    includeDefaultJobLimit: false,
    env: { HONEYCOMB_DEFAULT_JOB_MAX_COST_USD: "2" }
  }), {
    enabled: false,
    jobLimitUsd: null,
    userDailyLimitUsd: null,
    providerDailyLimitUsd: null
  });
});

test("spend reservation checks job, user, and provider limits in deterministic order", () => {
  const policy = {
    enabled: true,
    jobLimitUsd: 2,
    userDailyLimitUsd: 3,
    providerDailyLimitUsd: 4
  };
  assert.deepEqual(evaluateSpendReservation({
    policy,
    commitments: { jobUsd: 1.9, userDailyUsd: 1, providerDailyUsd: 1 },
    reservationUsd: 0.2
  }), {
    allowed: false,
    blockingScope: "job",
    reason: "job_spend_limit_exceeded",
    projected: { jobUsd: 2.1, userDailyUsd: 1.2, providerDailyUsd: 1.2 }
  });
  assert.equal(evaluateSpendReservation({
    policy,
    commitments: { jobUsd: 1, userDailyUsd: 2.9, providerDailyUsd: 1 },
    reservationUsd: 0.2
  }).blockingScope, "user_daily");
  assert.equal(evaluateSpendReservation({
    policy,
    commitments: { jobUsd: 1, userDailyUsd: 1, providerDailyUsd: 3.9 },
    reservationUsd: 0.2
  }).blockingScope, "provider_daily");
});

test("an enabled hard limit blocks calls with missing pricing", () => {
  const result = evaluateSpendReservation({
    policy: {
      enabled: true,
      jobLimitUsd: 1,
      userDailyLimitUsd: null,
      providerDailyLimitUsd: null
    },
    commitments: { jobUsd: 0, userDailyUsd: 0, providerDailyUsd: 0 },
    reservationUsd: null
  });
  assert.equal(result.allowed, false);
  assert.equal(result.blockingScope, "pricing");
});

test("stored spend snapshots are bounded and tolerate old empty rows", () => {
  assert.equal(parseJobSpendBudget({}, 1).remainingUsd, 1);
  const parsed = parseJobSpendBudget({
    version: "honeycomb.job-spend-budget.v1",
    enabled: true,
    currency: "EUR",
    maxCostUsd: 2,
    settledUsd: 0.25,
    reservedUsd: 0.5,
    committedUsd: 0.75,
    remainingUsd: 1.25,
    blocked: true,
    blockingScope: "job",
    blockingReason: "job_spend_limit_exceeded",
    updatedAt: "2026-07-14T12:00:00.000Z"
  }, 2);
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.blockingScope, "job");
  assert.equal(parsed.committedUsd, 0.75);
});
