import type {
  JobSpendBudget,
  SpendBudgetBlockingScope
} from "./types";

export const SPEND_LEDGER_SCALE = 1_000_000;

export type SpendLimitPolicy = {
  enabled: boolean;
  jobLimitUsd: number | null;
  userDailyLimitUsd: number | null;
  providerDailyLimitUsd: number | null;
};

export type SpendCommitments = {
  jobUsd: number;
  userDailyUsd: number;
  providerDailyUsd: number;
};

export type SpendReservationDecision = {
  allowed: boolean;
  blockingScope: SpendBudgetBlockingScope | null;
  reason: string | null;
  projected: SpendCommitments;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function roundUsd(value: number) {
  return Math.round(value * SPEND_LEDGER_SCALE) / SPEND_LEDGER_SCALE;
}

export function optionalUsd(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? roundUsd(parsed) : null;
}

export function providerDailySpendLimitUsd(
  metadata: Record<string, unknown> | null | undefined
) {
  const limits = recordValue(metadata?.spendLimits) ?? recordValue(metadata?.spendingLimits);
  return optionalUsd(
    limits?.dailyUsd ?? limits?.providerDailyUsd ?? metadata?.dailySpendLimitUsd
  );
}

export function resolveSpendLimitPolicy(input: {
  jobLimitUsd?: unknown;
  providerMetadata?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  includeDefaultJobLimit?: boolean;
}): SpendLimitPolicy {
  const env = input.env ?? process.env;
  const jobLimitUsd = optionalUsd(input.jobLimitUsd) ??
    (input.includeDefaultJobLimit === false
      ? null
      : optionalUsd(env.HONEYCOMB_DEFAULT_JOB_MAX_COST_USD));
  const userDailyLimitUsd = optionalUsd(env.HONEYCOMB_USER_DAILY_MAX_COST_USD);
  const providerDailyLimitUsd = providerDailySpendLimitUsd(input.providerMetadata) ??
    optionalUsd(env.HONEYCOMB_PROVIDER_DAILY_MAX_COST_USD);
  return {
    enabled: jobLimitUsd !== null || userDailyLimitUsd !== null || providerDailyLimitUsd !== null,
    jobLimitUsd,
    userDailyLimitUsd,
    providerDailyLimitUsd
  };
}

export function evaluateSpendReservation(input: {
  policy: SpendLimitPolicy;
  commitments: SpendCommitments;
  reservationUsd: number | null;
}): SpendReservationDecision {
  const reservationUsd = input.reservationUsd === null
    ? null
    : roundUsd(Math.max(0, input.reservationUsd));
  const projected = {
    jobUsd: roundUsd(input.commitments.jobUsd + (reservationUsd ?? 0)),
    userDailyUsd: roundUsd(input.commitments.userDailyUsd + (reservationUsd ?? 0)),
    providerDailyUsd: roundUsd(input.commitments.providerDailyUsd + (reservationUsd ?? 0))
  };

  if (!input.policy.enabled) {
    return { allowed: true, blockingScope: null, reason: null, projected };
  }
  if (reservationUsd === null) {
    return {
      allowed: false,
      blockingScope: "pricing",
      reason: "spend_pricing_or_reservation_bound_missing",
      projected
    };
  }

  const checks: Array<{
    scope: SpendBudgetBlockingScope;
    limit: number | null;
    projected: number;
    reason: string;
  }> = [
    {
      scope: "job",
      limit: input.policy.jobLimitUsd,
      projected: projected.jobUsd,
      reason: "job_spend_limit_exceeded"
    },
    {
      scope: "user_daily",
      limit: input.policy.userDailyLimitUsd,
      projected: projected.userDailyUsd,
      reason: "user_daily_spend_limit_exceeded"
    },
    {
      scope: "provider_daily",
      limit: input.policy.providerDailyLimitUsd,
      projected: projected.providerDailyUsd,
      reason: "provider_daily_spend_limit_exceeded"
    }
  ];
  for (const check of checks) {
    if (check.limit !== null && check.projected > check.limit) {
      return {
        allowed: false,
        blockingScope: check.scope,
        reason: check.reason,
        projected
      };
    }
  }

  return { allowed: true, blockingScope: null, reason: null, projected };
}

export function emptyJobSpendBudget(maxCostUsd: number | null = null): JobSpendBudget {
  return {
    version: "honeycomb.job-spend-budget.v1",
    enabled: maxCostUsd !== null,
    currency: "USD",
    maxCostUsd,
    settledUsd: 0,
    reservedUsd: 0,
    committedUsd: 0,
    remainingUsd: maxCostUsd,
    blocked: false,
    blockingScope: null,
    blockingReason: null,
    userDailyLimitUsd: null,
    userDailyCommittedUsd: null,
    providerId: null,
    providerDailyLimitUsd: null,
    providerDailyCommittedUsd: null,
    updatedAt: null
  };
}

export function parseJobSpendBudget(
  value: unknown,
  maxCostUsd: number | null
): JobSpendBudget {
  const record = recordValue(value);
  if (record?.version !== "honeycomb.job-spend-budget.v1") {
    return emptyJobSpendBudget(maxCostUsd);
  }
  const blockingScope = record.blockingScope;
  const validScope = blockingScope === "pricing" || blockingScope === "job" ||
    blockingScope === "user_daily" || blockingScope === "provider_daily"
    ? blockingScope
    : null;
  return {
    version: "honeycomb.job-spend-budget.v1",
    enabled: record.enabled === true,
    currency: "USD",
    maxCostUsd: optionalUsd(record.maxCostUsd) ?? maxCostUsd,
    settledUsd: optionalUsd(record.settledUsd) ?? 0,
    reservedUsd: optionalUsd(record.reservedUsd) ?? 0,
    committedUsd: optionalUsd(record.committedUsd) ?? 0,
    remainingUsd: optionalUsd(record.remainingUsd),
    blocked: record.blocked === true,
    blockingScope: validScope,
    blockingReason: typeof record.blockingReason === "string" ? record.blockingReason : null,
    userDailyLimitUsd: optionalUsd(record.userDailyLimitUsd),
    userDailyCommittedUsd: optionalUsd(record.userDailyCommittedUsd),
    providerId: typeof record.providerId === "string" ? record.providerId : null,
    providerDailyLimitUsd: optionalUsd(record.providerDailyLimitUsd),
    providerDailyCommittedUsd: optionalUsd(record.providerDailyCommittedUsd),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null
  };
}
