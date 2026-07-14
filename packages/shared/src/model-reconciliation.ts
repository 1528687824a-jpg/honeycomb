import { z } from "zod";

export const MODEL_CALL_REQUEST_KINDS = ["chat", "image", "video", "openclaw"] as const;
export type ModelCallRequestKind = (typeof MODEL_CALL_REQUEST_KINDS)[number];

export const MODEL_CALL_RECONCILIATION_STATUSES = [
  "pending",
  "provider_pending",
  "query_failed",
  "manual_review",
  "confirmed_not_accepted",
  "confirmed_failed",
  "confirmed_succeeded"
] as const;
export type ModelCallReconciliationStatus =
  (typeof MODEL_CALL_RECONCILIATION_STATUSES)[number];

export type ModelCallRequestReference = {
  version: "honeycomb.model-request-reference.v1";
  requestId: string;
  providerRequestId: string | null;
  providerId: string;
  model: string | null;
  kind: ModelCallRequestKind;
  runner: "provider-direct" | "native" | "wsl";
  routeIndex: number;
  routeAttemptNo: number;
  preparedAt: string;
};

export type ModelCallReconciliationState = {
  version: "honeycomb.model-reconciliation.v1";
  status: ModelCallReconciliationStatus;
  source: "provider_query" | "manual" | "system";
  providerStatus: string | null;
  providerHttpStatus: number | null;
  reason: string | null;
  canResume: boolean;
  checkedAt: string;
  resolvedAt: string | null;
};

export type ProviderUnknownOutcomePolicy = {
  version: "honeycomb.provider-reconciliation.v1";
  pathTemplate: string;
  requestIdSource: "requestId" | "providerRequestId";
  statusPath: string;
  resultTextPath: string | null;
  pendingValues: string[];
  notAcceptedValues: string[];
  failedValues: string[];
  succeededValues: string[];
  timeoutSeconds: number;
};

export const modelCallRequestReferenceSchema = z.object({
  version: z.literal("honeycomb.model-request-reference.v1"),
  requestId: z.string().trim().min(1).max(200),
  providerRequestId: z.string().trim().min(1).max(500).nullable(),
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500).nullable(),
  kind: z.enum(MODEL_CALL_REQUEST_KINDS),
  runner: z.enum(["provider-direct", "native", "wsl"]),
  routeIndex: z.number().int().min(0).max(1000),
  routeAttemptNo: z.number().int().min(1).max(1000),
  preparedAt: z.string().datetime({ offset: true })
});

export const modelCallReconciliationStateSchema = z.object({
  version: z.literal("honeycomb.model-reconciliation.v1"),
  status: z.enum(MODEL_CALL_RECONCILIATION_STATUSES),
  source: z.enum(["provider_query", "manual", "system"]),
  providerStatus: z.string().trim().min(1).max(200).nullable(),
  providerHttpStatus: z.number().int().min(100).max(599).nullable(),
  reason: z.string().trim().min(1).max(500).nullable(),
  canResume: z.boolean(),
  checkedAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).nullable()
});

const statusValuesSchema = z.array(z.string().trim().min(1).max(100)).max(50);
const requiredStatusValuesSchema = statusValuesSchema.refine(
  (values) => values.length > 0,
  "at least one provider status value is required"
);

export const providerUnknownOutcomePolicySchema = z.object({
  version: z.literal("honeycomb.provider-reconciliation.v1").default(
    "honeycomb.provider-reconciliation.v1"
  ),
  pathTemplate: z.string().trim().min(1).max(1000).refine(
    (value) => value.startsWith("/") && !value.startsWith("//") && value.includes("{requestId}"),
    "pathTemplate must be a relative provider path containing {requestId}"
  ),
  requestIdSource: z.enum(["requestId", "providerRequestId"]).default("providerRequestId"),
  statusPath: z.string().trim().min(1).max(500).default("status"),
  resultTextPath: z.string().trim().min(1).max(500).nullable().optional().default(null),
  pendingValues: requiredStatusValuesSchema.default(["pending", "queued", "running", "processing"]),
  notAcceptedValues: statusValuesSchema.default(["not_found", "not_accepted"]),
  failedValues: requiredStatusValuesSchema.default(["failed", "error", "cancelled"]),
  succeededValues: requiredStatusValuesSchema.default(["succeeded", "completed", "done"]),
  timeoutSeconds: z.coerce.number().int().min(1).max(30).default(10)
}).superRefine((value, context) => {
  const owners = new Map<string, string>();
  for (const [field, values] of Object.entries({
    pendingValues: value.pendingValues,
    notAcceptedValues: value.notAcceptedValues,
    failedValues: value.failedValues,
    succeededValues: value.succeededValues
  })) {
    for (const rawValue of values) {
      const normalized = normalizedProviderState(rawValue);
      const owner = owners.get(normalized);
      if (owner && owner !== field) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `provider status ${normalized} is also configured in ${owner}`
        });
      } else {
        owners.set(normalized, field);
      }
    }
  }
}).transform((value): ProviderUnknownOutcomePolicy => ({
  ...value,
  pendingValues: value.pendingValues.map(normalizedProviderState),
  notAcceptedValues: value.notAcceptedValues.map(normalizedProviderState),
  failedValues: value.failedValues.map(normalizedProviderState),
  succeededValues: value.succeededValues.map(normalizedProviderState)
}));

export function normalizedProviderState(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function parseModelCallRequestReference(value: unknown): ModelCallRequestReference | null {
  const parsed = modelCallRequestReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseModelCallReconciliationState(
  value: unknown
): ModelCallReconciliationState | null {
  const parsed = modelCallReconciliationStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseProviderUnknownOutcomePolicy(
  metadata: Record<string, unknown> | null | undefined
): ProviderUnknownOutcomePolicy | null {
  const parsed = providerUnknownOutcomePolicySchema.safeParse(
    metadata?.unknownOutcomeReconciliation
  );
  return parsed.success ? parsed.data : null;
}
