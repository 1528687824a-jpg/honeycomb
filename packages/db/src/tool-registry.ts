import { randomUUID } from "node:crypto";
import {
  MCP_SERVER_STATUSES,
  type AgentMcpPolicyRecord,
  type McpServerRecord,
  type McpServerStatus,
  type SkillRegistryRecord
} from "../../shared/src/types";
import { pool } from "./pool";

function fallbackId(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeMcpStatus(value: unknown): McpServerStatus {
  return typeof value === "string" && (MCP_SERVER_STATUSES as readonly string[]).includes(value)
    ? (value as McpServerStatus)
    : "unknown";
}

function toSkillRecord(row: any): SkillRegistryRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled ?? true,
    source: row.source,
    config: row.config ?? {},
    diagnostics: row.diagnostics ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function toMcpServerRecord(row: any): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: normalizeStringArray(row.args),
    envKeys: normalizeStringArray(row.env_keys),
    enabled: row.enabled ?? true,
    status: normalizeMcpStatus(row.status),
    lastCheckedAt: row.last_checked_at ? row.last_checked_at.toISOString() : null,
    lastError: row.last_error,
    config: row.config ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function toAgentMcpPolicyRecord(row: any): AgentMcpPolicyRecord {
  return {
    id: row.id,
    agentId: row.agent_config_id,
    serverId: row.mcp_server_id,
    enabled: row.enabled ?? true,
    allowToolsList: row.allow_tools_list ?? true,
    allowResourcesList: row.allow_resources_list ?? false,
    allowAllTools: row.allow_all_tools ?? false,
    allowedTools: normalizeStringArray(row.allowed_tools),
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export async function listSkills(): Promise<SkillRegistryRecord[]> {
  const result = await pool.query(
    `select * from agent.skill_registry order by enabled desc, updated_at desc, id asc`
  );
  return result.rows.map(toSkillRecord);
}

export async function getSkill(skillId: string): Promise<SkillRegistryRecord | null> {
  const result = await pool.query(`select * from agent.skill_registry where id = $1`, [skillId]);
  return result.rows[0] ? toSkillRecord(result.rows[0]) : null;
}

export async function upsertSkill(input: {
  id?: string;
  name: string;
  description?: string | null;
  enabled?: boolean;
  source?: string;
  config?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}): Promise<SkillRegistryRecord> {
  const id = input.id?.trim() || fallbackId("skill");
  const result = await pool.query(
    `insert into agent.skill_registry (
      id, name, description, enabled, source, config, diagnostics
    ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
    on conflict (id) do update set
      name = excluded.name,
      description = excluded.description,
      enabled = excluded.enabled,
      source = excluded.source,
      config = excluded.config,
      diagnostics = excluded.diagnostics,
      updated_at = now()
    returning *`,
    [
      id,
      input.name,
      input.description ?? null,
      input.enabled ?? true,
      input.source ?? "user",
      JSON.stringify(input.config ?? {}),
      JSON.stringify(input.diagnostics ?? {})
    ]
  );
  return toSkillRecord(result.rows[0]);
}

export async function patchSkill(
  skillId: string,
  input: Partial<{
    name: string;
    description: string | null;
    enabled: boolean;
    source: string;
    config: Record<string, unknown>;
    diagnostics: Record<string, unknown>;
  }>
): Promise<SkillRegistryRecord | null> {
  const current = await getSkill(skillId);
  if (!current) {
    return null;
  }
  return upsertSkill({
    id: skillId,
    name: input.name ?? current.name,
    description: input.description !== undefined ? input.description : current.description,
    enabled: input.enabled ?? current.enabled,
    source: input.source ?? current.source,
    config: input.config ?? current.config,
    diagnostics: input.diagnostics ?? current.diagnostics
  });
}

export async function listMcpServers(): Promise<McpServerRecord[]> {
  const result = await pool.query(
    `select * from agent.mcp_servers order by enabled desc, updated_at desc, id asc`
  );
  return result.rows.map(toMcpServerRecord);
}

export async function getMcpServer(serverId: string): Promise<McpServerRecord | null> {
  const result = await pool.query(`select * from agent.mcp_servers where id = $1`, [serverId]);
  return result.rows[0] ? toMcpServerRecord(result.rows[0]) : null;
}

export async function upsertMcpServer(input: {
  id?: string;
  name: string;
  command: string;
  args?: string[];
  envKeys?: string[];
  enabled?: boolean;
  status?: McpServerStatus;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  config?: Record<string, unknown>;
}): Promise<McpServerRecord> {
  const id = input.id?.trim() || fallbackId("mcp");
  const result = await pool.query(
    `insert into agent.mcp_servers (
      id, name, command, args, env_keys, enabled, status, last_checked_at, last_error, config
    ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::timestamptz, $9, $10::jsonb)
    on conflict (id) do update set
      name = excluded.name,
      command = excluded.command,
      args = excluded.args,
      env_keys = excluded.env_keys,
      enabled = excluded.enabled,
      status = excluded.status,
      last_checked_at = excluded.last_checked_at,
      last_error = excluded.last_error,
      config = excluded.config,
      updated_at = now()
    returning *`,
    [
      id,
      input.name,
      input.command,
      JSON.stringify(input.args ?? []),
      JSON.stringify(input.envKeys ?? []),
      input.enabled ?? true,
      input.status ?? "unknown",
      input.lastCheckedAt ?? null,
      input.lastError ?? null,
      JSON.stringify(input.config ?? {})
    ]
  );
  return toMcpServerRecord(result.rows[0]);
}

export async function patchMcpServer(
  serverId: string,
  input: Partial<{
    name: string;
    command: string;
    args: string[];
    envKeys: string[];
    enabled: boolean;
    status: McpServerStatus;
    lastCheckedAt: string | null;
    lastError: string | null;
    config: Record<string, unknown>;
  }>
): Promise<McpServerRecord | null> {
  const current = await getMcpServer(serverId);
  if (!current) {
    return null;
  }
  return upsertMcpServer({
    id: serverId,
    name: input.name ?? current.name,
    command: input.command ?? current.command,
    args: input.args ?? current.args,
    envKeys: input.envKeys ?? current.envKeys,
    enabled: input.enabled ?? current.enabled,
    status: input.status ?? current.status,
    lastCheckedAt: input.lastCheckedAt !== undefined ? input.lastCheckedAt : current.lastCheckedAt,
    lastError: input.lastError !== undefined ? input.lastError : current.lastError,
    config: input.config ?? current.config
  });
}

export async function listAgentMcpPolicies(input: {
  agentId?: string;
  serverId?: string;
} = {}): Promise<AgentMcpPolicyRecord[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (input.agentId) {
    values.push(input.agentId);
    where.push(`agent_config_id = $${values.length}`);
  }
  if (input.serverId) {
    values.push(input.serverId);
    where.push(`mcp_server_id = $${values.length}`);
  }

  const result = await pool.query(
    `select *
     from agent.agent_mcp_policies
     ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
     order by enabled desc, updated_at desc, agent_config_id asc, mcp_server_id asc`,
    values
  );
  return result.rows.map(toAgentMcpPolicyRecord);
}

export async function getAgentMcpPolicy(policyId: string): Promise<AgentMcpPolicyRecord | null> {
  const result = await pool.query(`select * from agent.agent_mcp_policies where id = $1`, [
    policyId
  ]);
  return result.rows[0] ? toAgentMcpPolicyRecord(result.rows[0]) : null;
}

export async function getAgentMcpPolicyFor(input: {
  agentId: string;
  serverId: string;
}): Promise<AgentMcpPolicyRecord | null> {
  const result = await pool.query(
    `select *
     from agent.agent_mcp_policies
     where agent_config_id = $1 and mcp_server_id = $2`,
    [input.agentId, input.serverId]
  );
  return result.rows[0] ? toAgentMcpPolicyRecord(result.rows[0]) : null;
}

export async function upsertAgentMcpPolicy(input: {
  id?: string;
  agentId: string;
  serverId: string;
  enabled?: boolean;
  allowToolsList?: boolean;
  allowResourcesList?: boolean;
  allowAllTools?: boolean;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
}): Promise<AgentMcpPolicyRecord> {
  const id = input.id?.trim() || fallbackId("mcp-policy");
  const result = await pool.query(
    `insert into agent.agent_mcp_policies (
      id,
      agent_config_id,
      mcp_server_id,
      enabled,
      allow_tools_list,
      allow_resources_list,
      allow_all_tools,
      allowed_tools,
      metadata
    ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
    on conflict (agent_config_id, mcp_server_id) do update set
      enabled = excluded.enabled,
      allow_tools_list = excluded.allow_tools_list,
      allow_resources_list = excluded.allow_resources_list,
      allow_all_tools = excluded.allow_all_tools,
      allowed_tools = excluded.allowed_tools,
      metadata = excluded.metadata,
      updated_at = now()
    returning *`,
    [
      id,
      input.agentId,
      input.serverId,
      input.enabled ?? true,
      input.allowToolsList ?? true,
      input.allowResourcesList ?? false,
      input.allowAllTools ?? false,
      JSON.stringify(input.allowedTools ?? []),
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return toAgentMcpPolicyRecord(result.rows[0]);
}

export async function patchAgentMcpPolicy(
  policyId: string,
  input: Partial<{
    enabled: boolean;
    allowToolsList: boolean;
    allowResourcesList: boolean;
    allowAllTools: boolean;
    allowedTools: string[];
    metadata: Record<string, unknown>;
  }>
): Promise<AgentMcpPolicyRecord | null> {
  const current = await getAgentMcpPolicy(policyId);
  if (!current) {
    return null;
  }
  return upsertAgentMcpPolicy({
    id: current.id,
    agentId: current.agentId,
    serverId: current.serverId,
    enabled: input.enabled ?? current.enabled,
    allowToolsList: input.allowToolsList ?? current.allowToolsList,
    allowResourcesList: input.allowResourcesList ?? current.allowResourcesList,
    allowAllTools: input.allowAllTools ?? current.allowAllTools,
    allowedTools: input.allowedTools ?? current.allowedTools,
    metadata: input.metadata ?? current.metadata
  });
}

export function isAgentMcpPolicyAllowed(
  policy: AgentMcpPolicyRecord | null,
  input: {
    operation: "tools/list" | "resources/list" | "tools/call";
    toolName?: string;
  }
) {
  if (!policy?.enabled) {
    return false;
  }

  if (input.operation === "tools/list") {
    return policy.allowToolsList;
  }
  if (input.operation === "resources/list") {
    return policy.allowResourcesList;
  }

  if (policy.allowAllTools) {
    return true;
  }
  return Boolean(input.toolName && policy.allowedTools.includes(input.toolName));
}
