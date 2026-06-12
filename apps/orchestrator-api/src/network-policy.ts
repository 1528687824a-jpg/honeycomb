import type { AgentConfigRecord } from "../../../packages/shared/src/types";

export type AgentNetworkOperation = "web.fetch" | "web.search" | "browser.snapshot";

export type AgentNetworkPolicyDecision = {
  allowed: boolean;
  reason: string | null;
  agentId: string;
  operation: AgentNetworkOperation;
  url: string;
  policySource: "default" | "agent_metadata" | "missing_agent" | "disabled_agent";
  policy: {
    enabled: boolean;
    allowedHosts: string[];
    blockedHosts: string[];
    allowedProtocols: string[];
    allowPrivateNetwork: boolean;
  };
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
      .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
      .filter(Boolean)
    : [];
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function networkPolicyFromMetadata(metadata: Record<string, unknown>) {
  return recordValue(metadata.networkPolicy) ?? recordValue(metadata.network) ?? null;
}

function operationAllowed(policy: Record<string, unknown>, operation: AgentNetworkOperation) {
  const general = [
    booleanValue(policy.allowNetwork),
    booleanValue(policy.allowWeb),
    booleanValue(policy.allowExternalNetwork)
  ];
  if (general.some((value) => value === false)) {
    return false;
  }

  const operationFlags: Record<AgentNetworkOperation, string[]> = {
    "web.fetch": ["allowWebFetch", "allowFetch"],
    "web.search": ["allowWebSearch", "allowSearch"],
    "browser.snapshot": ["allowBrowserSnapshot", "allowBrowser"]
  };
  return !operationFlags[operation].some((key) => booleanValue(policy[key]) === false);
}

function hostMatchesPattern(hostname: string, pattern: string) {
  const normalizedHost = hostname.toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern || normalizedPattern === "*") {
    return true;
  }
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  if (normalizedPattern.startsWith(".")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
  }
  return normalizedHost === normalizedPattern;
}

function hostMatchesAny(hostname: string, patterns: string[]) {
  return patterns.some((pattern) => hostMatchesPattern(hostname, pattern));
}

function decision(input: {
  allowed: boolean;
  reason: string | null;
  agentId: string;
  operation: AgentNetworkOperation;
  url: string;
  policySource: AgentNetworkPolicyDecision["policySource"];
  policy: AgentNetworkPolicyDecision["policy"];
}): AgentNetworkPolicyDecision {
  return input;
}

export function evaluateAgentNetworkPolicy(input: {
  agent: AgentConfigRecord | null;
  operation: AgentNetworkOperation;
  url: string;
  allowPrivateNetwork: boolean;
}): AgentNetworkPolicyDecision {
  const agentId = input.agent?.id ?? "unknown";
  const defaultPolicy = {
    enabled: true,
    allowedHosts: [] as string[],
    blockedHosts: [] as string[],
    allowedProtocols: ["http", "https"],
    allowPrivateNetwork: false
  };

  if (!input.agent) {
    return decision({
      allowed: true,
      reason: null,
      agentId,
      operation: input.operation,
      url: input.url,
      policySource: "missing_agent",
      policy: defaultPolicy
    });
  }

  if (!input.agent.enabled) {
    return decision({
      allowed: false,
      reason: "agent_disabled",
      agentId,
      operation: input.operation,
      url: input.url,
      policySource: "disabled_agent",
      policy: defaultPolicy
    });
  }

  const rawPolicy = networkPolicyFromMetadata(input.agent.metadata);
  if (!rawPolicy || rawPolicy.enabled === false) {
    return decision({
      allowed: true,
      reason: null,
      agentId,
      operation: input.operation,
      url: input.url,
      policySource: rawPolicy ? "agent_metadata" : "default",
      policy: defaultPolicy
    });
  }

  const allowedHosts = [
    ...stringList(rawPolicy.allowedHosts),
    ...stringList(rawPolicy.allowHosts),
    ...stringList(rawPolicy.allowedDomains)
  ];
  const blockedHosts = [
    ...stringList(rawPolicy.blockedHosts),
    ...stringList(rawPolicy.blockHosts),
    ...stringList(rawPolicy.blockedDomains)
  ];
  const allowedProtocols = stringList(rawPolicy.allowedProtocols).map((protocol) => protocol.replace(/:$/, ""));
  const policy = {
    enabled: true,
    allowedHosts,
    blockedHosts,
    allowedProtocols: allowedProtocols.length > 0 ? allowedProtocols : defaultPolicy.allowedProtocols,
    allowPrivateNetwork: rawPolicy.allowPrivateNetwork === true
  };

  if (!operationAllowed(rawPolicy, input.operation)) {
    return decision({
      allowed: false,
      reason: "operation_not_allowed",
      agentId,
      operation: input.operation,
      url: input.url,
      policySource: "agent_metadata",
      policy
    });
  }

  if (input.allowPrivateNetwork && !policy.allowPrivateNetwork) {
    return decision({
      allowed: false,
      reason: "private_network_not_allowed_by_agent_policy",
      agentId,
      operation: input.operation,
      url: input.url,
      policySource: "agent_metadata",
      policy
    });
  }

  const parsed = new URL(input.url);
  const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
  const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");

  if (!policy.allowedProtocols.includes(protocol)) {
    return decision({
      allowed: false,
      reason: "protocol_not_allowed",
      agentId,
      operation: input.operation,
      url: input.url,
      policySource: "agent_metadata",
      policy
    });
  }

  if (blockedHosts.length > 0 && hostMatchesAny(hostname, blockedHosts)) {
    return decision({
      allowed: false,
      reason: "host_blocked",
      agentId,
      operation: input.operation,
      url: input.url,
      policySource: "agent_metadata",
      policy
    });
  }

  if (allowedHosts.length > 0 && !hostMatchesAny(hostname, allowedHosts)) {
    return decision({
      allowed: false,
      reason: "host_not_allowed",
      agentId,
      operation: input.operation,
      url: input.url,
      policySource: "agent_metadata",
      policy
    });
  }

  return decision({
    allowed: true,
    reason: null,
    agentId,
    operation: input.operation,
    url: input.url,
    policySource: "agent_metadata",
    policy
  });
}
