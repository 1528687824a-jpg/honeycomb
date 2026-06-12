import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAgentNetworkPolicy } from "../apps/orchestrator-api/src/network-policy";
import type { AgentConfigRecord } from "../packages/shared/src/types";

function agent(metadata: Record<string, unknown>, enabled = true): AgentConfigRecord {
  return {
    id: "research-agent",
    displayName: "Research Agent",
    agentRole: "research",
    required: true,
    enabled,
    providerId: null,
    model: null,
    apiKeyConfigured: false,
    apiKeyFingerprint: null,
    workspacePath: null,
    promptTemplatePath: null,
    tools: [],
    openclawSyncStatus: "pending",
    openclawAgentPath: null,
    lastSyncedAt: null,
    lastError: null,
    metadata,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

test("network policy allows missing or unconfigured agents through the default approval gateway", () => {
  const missing = evaluateAgentNetworkPolicy({
    agent: null,
    operation: "web.fetch",
    url: "https://example.com/page",
    allowPrivateNetwork: false
  });
  assert.equal(missing.allowed, true);
  assert.equal(missing.policySource, "missing_agent");

  const unconfigured = evaluateAgentNetworkPolicy({
    agent: agent({}),
    operation: "web.search",
    url: "https://example.com/search?q=honeycomb",
    allowPrivateNetwork: false
  });
  assert.equal(unconfigured.allowed, true);
  assert.equal(unconfigured.policySource, "default");
});

test("network policy can disable specific network operations", () => {
  const decision = evaluateAgentNetworkPolicy({
    agent: agent({
      networkPolicy: {
        allowWebSearch: false
      }
    }),
    operation: "web.search",
    url: "https://example.com/search?q=honeycomb",
    allowPrivateNetwork: false
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "operation_not_allowed");
});

test("network policy enforces private-network and host allow lists", () => {
  const privateDenied = evaluateAgentNetworkPolicy({
    agent: agent({
      networkPolicy: {
        allowedHosts: ["127.0.0.1"]
      }
    }),
    operation: "browser.snapshot",
    url: "http://127.0.0.1:3000/page",
    allowPrivateNetwork: true
  });
  assert.equal(privateDenied.allowed, false);
  assert.equal(privateDenied.reason, "private_network_not_allowed_by_agent_policy");

  const publicHostDenied = evaluateAgentNetworkPolicy({
    agent: agent({
      networkPolicy: {
        allowPrivateNetwork: true,
        allowedHosts: ["*.example.com"]
      }
    }),
    operation: "web.fetch",
    url: "https://not-example.test/page",
    allowPrivateNetwork: false
  });
  assert.equal(publicHostDenied.allowed, false);
  assert.equal(publicHostDenied.reason, "host_not_allowed");

  const allowed = evaluateAgentNetworkPolicy({
    agent: agent({
      networkPolicy: {
        allowedHosts: ["*.example.com"],
        blockedHosts: ["blocked.example.com"]
      }
    }),
    operation: "web.fetch",
    url: "https://docs.example.com/page",
    allowPrivateNetwork: false
  });
  assert.equal(allowed.allowed, true);

  const blocked = evaluateAgentNetworkPolicy({
    agent: agent({
      networkPolicy: {
        allowedHosts: ["*.example.com"],
        blockedHosts: ["blocked.example.com"]
      }
    }),
    operation: "web.fetch",
    url: "https://blocked.example.com/page",
    allowPrivateNetwork: false
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "host_blocked");
});

test("disabled agents cannot use network tools", () => {
  const decision = evaluateAgentNetworkPolicy({
    agent: agent({}, false),
    operation: "web.fetch",
    url: "https://example.com/page",
    allowPrivateNetwork: false
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "agent_disabled");
});
