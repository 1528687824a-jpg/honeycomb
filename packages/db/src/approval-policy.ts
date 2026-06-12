const FALLBACK_APPROVAL_TTL_MS = 15 * 60 * 1000;

export function approvalTtlMsFromEnv(value = process.env.HONEYCOMB_APPROVAL_TTL_MS) {
  const ttlMs = Number(value ?? FALLBACK_APPROVAL_TTL_MS);
  return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : FALLBACK_APPROVAL_TTL_MS;
}

export function defaultApprovalExpiresAt(now = new Date(), ttlMs = approvalTtlMsFromEnv()) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

export function isApprovalExpired(
  approval: {
    expiresAt: string | null;
  },
  now = new Date()
) {
  return approval.expiresAt ? Date.parse(approval.expiresAt) <= now.getTime() : false;
}
