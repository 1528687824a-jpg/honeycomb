import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  bearerToken,
  isPublicRequest,
  requestToken,
  timingSafeEqualString
} from "../apps/orchestrator-api/src/api-auth";
import {
  normalizeWorkspaceRegistrationTarget,
  workspaceApprovalTarget,
  workspaceRootKey
} from "../apps/orchestrator-api/src/workspace-security";
import {
  approvalTtlMsFromEnv,
  defaultApprovalExpiresAt,
  isApprovalExpired
} from "../packages/db/src/approval-policy";
import { isAgentMcpPolicyAllowed } from "../packages/db/src/tool-registry";
import {
  clearProviderApiKeyCache,
  readProviderApiKey,
  saveProviderApiKey
} from "../packages/runtime/src/local-secrets";
import type { AgentMcpPolicyRecord } from "../packages/shared/src/types";

function mockRequest(input: {
  method?: string;
  path?: string;
  headers?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
}) {
  const headers = input.headers ?? {};
  return {
    method: input.method ?? "GET",
    path: input.path ?? "/jobs",
    query: input.query ?? {},
    header(name: string) {
      return headers[name.toLowerCase()];
    }
  } as any;
}

function policy(overrides: Partial<AgentMcpPolicyRecord>): AgentMcpPolicyRecord {
  return {
    id: "policy-1",
    agentId: "research-agent",
    serverId: "filesystem",
    enabled: true,
    allowToolsList: true,
    allowResourcesList: false,
    allowAllTools: false,
    allowedTools: [],
    metadata: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

test("approval policy computes default TTL and expiry boundaries", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");

  assert.equal(approvalTtlMsFromEnv("1000"), 1000);
  assert.equal(approvalTtlMsFromEnv("-1"), 15 * 60 * 1000);
  assert.equal(defaultApprovalExpiresAt(now, 1000), "2026-06-12T12:00:01.000Z");
  assert.equal(isApprovalExpired({ expiresAt: null }, now), false);
  assert.equal(isApprovalExpired({ expiresAt: "2026-06-12T11:59:59.999Z" }, now), true);
  assert.equal(isApprovalExpired({ expiresAt: "2026-06-12T12:00:00.000Z" }, now), true);
  assert.equal(isApprovalExpired({ expiresAt: "2026-06-12T12:00:00.001Z" }, now), false);
});

test("api auth token helpers honor public routes and token sources", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("Basic abc123"), null);
  assert.equal(timingSafeEqualString("same", "same"), true);
  assert.equal(timingSafeEqualString("same", "different"), false);

  assert.equal(isPublicRequest(mockRequest({ method: "OPTIONS", path: "/jobs" })), true);
  assert.equal(isPublicRequest(mockRequest({ method: "GET", path: "/health" })), true);
  assert.equal(isPublicRequest(mockRequest({ method: "GET", path: "/jobs" })), false);

  assert.equal(
    requestToken(mockRequest({ headers: { authorization: "Bearer header-token" } })),
    "header-token"
  );
  assert.equal(
    requestToken(mockRequest({ headers: { "x-honeycomb-token": "alt-token" } })),
    "alt-token"
  );
  assert.equal(
    requestToken(mockRequest({ query: { access_token: "query-token" } })),
    "query-token"
  );
});

test("workspace registration target normalizes all accepted target forms", () => {
  const root = path.join(process.cwd(), ".runtime", "Workspace Target Smoke");
  const key = workspaceRootKey(root);

  assert.equal(normalizeWorkspaceRegistrationTarget(workspaceApprovalTarget(key)), key);
  assert.equal(normalizeWorkspaceRegistrationTarget(`workspace:${root}`), key);
  assert.equal(normalizeWorkspaceRegistrationTarget(root), key);
  assert.equal(normalizeWorkspaceRegistrationTarget("   "), null);
});

test("mcp policy blocks disabled policies and enforces allowed tools", () => {
  assert.equal(isAgentMcpPolicyAllowed(null, { operation: "tools/list" }), false);
  assert.equal(isAgentMcpPolicyAllowed(policy({ enabled: false }), { operation: "tools/list" }), false);
  assert.equal(isAgentMcpPolicyAllowed(policy({ allowToolsList: true }), { operation: "tools/list" }), true);
  assert.equal(isAgentMcpPolicyAllowed(policy({ allowResourcesList: false }), { operation: "resources/list" }), false);
  assert.equal(
    isAgentMcpPolicyAllowed(policy({ allowedTools: ["read_file"] }), {
      operation: "tools/call",
      toolName: "read_file"
    }),
    true
  );
  assert.equal(
    isAgentMcpPolicyAllowed(policy({ allowedTools: ["read_file"] }), {
      operation: "tools/call",
      toolName: "write_file"
    }),
    false
  );
  assert.equal(isAgentMcpPolicyAllowed(policy({ allowAllTools: true }), { operation: "tools/call" }), true);
});

test("provider secrets cache read values and never migrate recognized broken envelopes as plaintext", async () => {
  const root = path.join(process.cwd(), ".runtime", `secret-policy-${randomUUID()}`);
  const previousSecretDir = process.env.HONEYCOMB_SECRET_DIR;
  const previousTtl = process.env.HONEYCOMB_SECRET_CACHE_TTL_MS;
  process.env.HONEYCOMB_SECRET_DIR = root;
  process.env.HONEYCOMB_SECRET_CACHE_TTL_MS = "60000";
  clearProviderApiKeyCache();

  try {
    await saveProviderApiKey("cache-provider", "sk-cache-value");
    const secretPath = path.join(root, "providers", "cache-provider.key");
    await fs.writeFile(secretPath, "corrupted", "utf8");

    assert.equal(await readProviderApiKey("cache-provider"), "sk-cache-value");

    clearProviderApiKeyCache();
    await fs.writeFile(
      secretPath,
      JSON.stringify({ format: "dpapi-user-v1", ciphertext: "not-valid-base64" }),
      "utf8"
    );
    assert.equal(await readProviderApiKey("cache-provider"), null);
    assert.match(await fs.readFile(secretPath, "utf8"), /dpapi-user-v1/);
  } finally {
    clearProviderApiKeyCache();
    if (previousSecretDir === undefined) {
      delete process.env.HONEYCOMB_SECRET_DIR;
    } else {
      process.env.HONEYCOMB_SECRET_DIR = previousSecretDir;
    }
    if (previousTtl === undefined) {
      delete process.env.HONEYCOMB_SECRET_CACHE_TTL_MS;
    } else {
      process.env.HONEYCOMB_SECRET_CACHE_TTL_MS = previousTtl;
    }
  }
});
