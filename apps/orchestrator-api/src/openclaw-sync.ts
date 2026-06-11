import { promises as fs } from "node:fs";
import path from "node:path";
import {
  listAgentConfigs,
  listModelProviders
} from "../../../packages/db/src/config-registry";
import {
  DEFAULT_ROUTING_MODE,
  type AgentConfigRecord,
  type ModelProviderRecord
} from "../../../packages/shared/src/types";
import { discoverOpenClawRuntime } from "./openclaw-runtime";

export type OpenClawAgentSyncItem = {
  honeycombAgentId: string;
  openclawAgentId: string;
  displayName: string;
  role: string;
  enabled: boolean;
  tools: string[];
  model: string | null;
  providerId: string | null;
  apiKeyConfigured: boolean;
  apiKeyFingerprint: string | null;
  sourceTemplatePath: string;
  sourceTemplateExists: boolean;
  targetAgentPromptPath: string;
  targetWorkspacePromptPath: string;
  status: "ready" | "missing_template";
};

export type OpenClawNativeConfigPaths = {
  clusterConfigPath: string;
  agentModelConfigPath: string;
  envPath: string;
  manifestPath: string;
};

export type OpenClawSyncPlan = {
  generatedAt: string;
  rootPath: string;
  configPath: string;
  nativeConfigPaths: OpenClawNativeConfigPaths;
  agents: OpenClawAgentSyncItem[];
  providers: Array<{
    id: string;
    displayName: string;
    baseUrl: string;
    defaultModel: string | null;
    apiKeyConfigured: boolean;
    apiKeyFingerprint: string | null;
    verificationStatus: string;
    lastVerifiedAt: string | null;
    lastError: string | null;
  }>;
  warnings: string[];
};

export type OpenClawSyncApplyResult = {
  appliedAt: string;
  plan: OpenClawSyncPlan;
  writtenFiles: string[];
  skippedFiles: string[];
};

export type OpenClawValidationResult = {
  checkedAt: string;
  rootPath: string;
  requiredAgents: Array<{
    honeycombAgentId: string;
    openclawAgentId: string;
    present: boolean;
    agentPromptPath: string;
    workspacePromptPath: string;
  }>;
  missingAgentIds: string[];
  nativeConfig: {
    clusterConfigPath: string;
    clusterConfigExists: boolean;
    agentModelConfigPath: string;
    agentModelConfigExists: boolean;
    envPath: string;
    envExists: boolean;
    manifestPath: string;
    manifestExists: boolean;
  };
  ok: boolean;
};

function templateRoot() {
  return path.resolve("platform-assets", "openclaw-agent-templates", "agents");
}

function openClawAgentId(agent: AgentConfigRecord) {
  const value = agent.metadata.openclawAgentId;
  return typeof value === "string" && value.trim() ? value.trim() : agent.id;
}

async function exists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRootPath(rootPath?: string) {
  if (rootPath) {
    return path.resolve(rootPath);
  }
  const discovery = await discoverOpenClawRuntime();
  return discovery.selected?.rootPath ? path.resolve(discovery.selected.rootPath) : null;
}

function redactedProvider(provider: ModelProviderRecord): OpenClawSyncPlan["providers"][number] {
  return {
    id: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    apiKeyConfigured: provider.apiKeyConfigured,
    apiKeyFingerprint: provider.apiKeyFingerprint,
    verificationStatus: provider.verificationStatus,
    lastVerifiedAt: provider.lastVerifiedAt,
    lastError: provider.lastError
  };
}

function nativeConfigPaths(rootPath: string): OpenClawNativeConfigPaths {
  return {
    clusterConfigPath: path.join(rootPath, "cluster.config.json"),
    agentModelConfigPath: path.join(rootPath, "agent-model-configs.json"),
    envPath: path.join(rootPath, "openclaw.env"),
    manifestPath: path.join(rootPath, "runtime-manifest.json")
  };
}

function providerById<T extends { id: string }>(providers: T[]) {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

function providerForAgent<T extends { id: string }>(
  agent: Pick<OpenClawAgentSyncItem, "providerId">,
  providersById: Map<string, T>
) {
  return agent.providerId ? providersById.get(agent.providerId) ?? null : null;
}

function modelForAgent(
  agent: Pick<OpenClawAgentSyncItem, "model" | "providerId">,
  providersById: Map<string, Pick<ModelProviderRecord, "id" | "defaultModel">>
) {
  return agent.model || providerForAgent(agent, providersById)?.defaultModel || null;
}

function buildStageDefinitions(agents: OpenClawAgentSyncItem[]) {
  return agents
    .filter((agent) => agent.openclawAgentId !== "main-agent")
    .map((agent, index) => ({
      stageType: agent.role,
      agentId: agent.openclawAgentId,
      name: agent.displayName,
      acceptanceCriteria: [
        "The agent output is specific to the user task.",
        "The handoff is clear enough for the next agent or final reviewer."
      ],
      maxRetries: agent.role === "review" ? 0 : 1,
      position: index + 1
    }));
}

function buildClusterConfig(plan: OpenClawSyncPlan, providers: ModelProviderRecord[]) {
  const providersById = providerById(providers);
  return {
    schemaVersion: "agent-openclaw.cluster.v1",
    clusterId: "honeycomb-openclaw",
    name: "Honeycomb OpenClaw Agent Team",
    description: "Generated by Honeycomb from the local provider and agent registry.",
    defaultRoutingMode: DEFAULT_ROUTING_MODE,
    agents: plan.agents.map((agent) => ({
      id: agent.openclawAgentId,
      honeycombAgentId: agent.honeycombAgentId,
      role: agent.role,
      displayName: agent.displayName,
      promptPath: path.relative(plan.rootPath, agent.targetAgentPromptPath).replace(/\\/g, "/"),
      workspacePromptPath: path
        .relative(plan.rootPath, agent.targetWorkspacePromptPath)
        .replace(/\\/g, "/"),
      capabilities: agent.tools,
      model: modelForAgent(agent, providersById)
    })),
    stages: buildStageDefinitions(plan.agents),
    generatedAt: new Date().toISOString(),
    source: {
      planner: "openai-compatible",
      model: providers.find((provider) => provider.defaultModel)?.defaultModel ?? null
    }
  };
}

function addAgentModelConfigEntry(
  target: Record<string, unknown>,
  agentId: string,
  agent: OpenClawAgentSyncItem,
  provider: ModelProviderRecord | null,
  model: string | null,
  appliedAt: string
) {
  target[agentId] = {
    providerId: provider?.id ?? agent.providerId,
    providerName: provider?.displayName ?? "Unconfigured",
    baseUrl: provider?.baseUrl ?? "",
    model: model ?? "",
    apiKeyConfigured: provider?.apiKeyConfigured ?? agent.apiKeyConfigured,
    apiKeyFingerprint: provider?.apiKeyFingerprint ?? agent.apiKeyFingerprint,
    verificationStatus: provider?.verificationStatus ?? "unknown",
    verifiedAt: provider?.lastVerifiedAt ?? null,
    appliedAt
  };
}

function buildAgentModelConfig(plan: OpenClawSyncPlan, providers: ModelProviderRecord[]) {
  const providersById = providerById(providers);
  const configs: Record<string, unknown> = {
    schemaVersion: "honeycomb.agent-model-configs.v1",
    generatedBy: "honeycomb-backend",
    generatedAt: new Date().toISOString()
  };

  for (const agent of plan.agents) {
    const provider = providerForAgent(agent, providersById);
    const model = modelForAgent(agent, providersById);
    addAgentModelConfigEntry(configs, agent.honeycombAgentId, agent, provider, model, plan.generatedAt);
    if (agent.openclawAgentId !== agent.honeycombAgentId) {
      addAgentModelConfigEntry(configs, agent.openclawAgentId, agent, provider, model, plan.generatedAt);
    }
    if (agent.openclawAgentId === "main-agent") {
      addAgentModelConfigEntry(
        configs,
        "panel-supervisor-agent",
        agent,
        provider,
        model,
        plan.generatedAt
      );
    }
  }

  return configs;
}

function buildRuntimeEnv(plan: OpenClawSyncPlan) {
  return [
    `AGENT_CLUSTER_CONFIG_PATH=${plan.nativeConfigPaths.clusterConfigPath}`,
    `HONEYCOMB_AGENT_MODEL_CONFIG_PATH=${plan.nativeConfigPaths.agentModelConfigPath}`,
    `HONEYCOMB_FIRST_RUN_AGENTS_DIR=${path.join(plan.rootPath, "agents")}`,
    `HONEYCOMB_OPENCLAW_RUNTIME_DIR=${plan.rootPath}`,
    ""
  ].join("\n");
}

function buildRuntimeManifest(plan: OpenClawSyncPlan) {
  return {
    schemaVersion: "honeycomb.openclaw.runtime.v1",
    generatedBy: "honeycomb-backend",
    generatedAt: new Date().toISOString(),
    rootPath: plan.rootPath,
    honeycombConfigPath: plan.configPath,
    ...plan.nativeConfigPaths,
    agentsDir: path.join(plan.rootPath, "agents"),
    workspaceDir: path.join(plan.rootPath, "workspace")
  };
}

export async function buildOpenClawSyncPlan(input: {
  rootPath?: string;
} = {}): Promise<OpenClawSyncPlan | null> {
  const rootPath = await resolveRootPath(input.rootPath);
  if (!rootPath) {
    return null;
  }

  const [agents, providers] = await Promise.all([listAgentConfigs(), listModelProviders()]);
  const enabledAgents = agents.filter((agent) => agent.enabled);
  const providersById = providerById(providers);
  const warnings: string[] = [];
  if (enabledAgents.length === 0) {
    warnings.push("no_enabled_agents");
  }

  const agentItems = await Promise.all(
    enabledAgents.map(async (agent): Promise<OpenClawAgentSyncItem> => {
      const externalId = openClawAgentId(agent);
      const sourceTemplatePath =
        agent.promptTemplatePath || path.join(templateRoot(), `${externalId}.md`);
      const sourceTemplateExists = await exists(sourceTemplatePath);
      if (!sourceTemplateExists) {
        warnings.push(`missing_template:${externalId}`);
      }

      return {
        honeycombAgentId: agent.id,
        openclawAgentId: externalId,
        displayName: agent.displayName,
        role: agent.agentRole,
        enabled: agent.enabled,
        tools: agent.tools,
        model: agent.model ?? providerForAgent({ providerId: agent.providerId }, providersById)?.defaultModel ?? null,
        providerId: agent.providerId,
        apiKeyConfigured: agent.apiKeyConfigured,
        apiKeyFingerprint: agent.apiKeyFingerprint,
        sourceTemplatePath,
        sourceTemplateExists,
        targetAgentPromptPath: path.join(rootPath, "agents", externalId, "agent", "AGENTS.md"),
        targetWorkspacePromptPath: path.join(rootPath, "workspace", externalId, "AGENTS.md"),
        status: sourceTemplateExists ? "ready" : "missing_template"
      };
    })
  );

  return {
    generatedAt: new Date().toISOString(),
    rootPath,
    configPath: path.join(rootPath, "config", "honeycomb.generated.json"),
    nativeConfigPaths: nativeConfigPaths(rootPath),
    agents: agentItems,
    providers: providers.map(redactedProvider),
    warnings
  };
}

function fallbackPrompt(agent: OpenClawAgentSyncItem) {
  return [
    `# ${agent.displayName}`,
    "",
    `Honeycomb role: ${agent.role}`,
    `OpenClaw agent id: ${agent.openclawAgentId}`,
    "",
    "This prompt was generated because the expected Honeycomb template was missing.",
    "Review and replace it before production use.",
    ""
  ].join("\n");
}

async function readPromptTemplate(agent: OpenClawAgentSyncItem) {
  if (!agent.sourceTemplateExists) {
    return fallbackPrompt(agent);
  }
  return fs.readFile(agent.sourceTemplatePath, "utf8");
}

export async function applyOpenClawSyncPlan(input: {
  rootPath?: string;
} = {}): Promise<OpenClawSyncApplyResult | null> {
  const plan = await buildOpenClawSyncPlan(input);
  if (!plan) {
    return null;
  }
  const providers = await listModelProviders();

  const writtenFiles: string[] = [];
  const skippedFiles: string[] = [];
  await fs.mkdir(plan.rootPath, { recursive: true });

  for (const agent of plan.agents) {
    const prompt = await readPromptTemplate(agent);
    for (const targetPath of [agent.targetAgentPromptPath, agent.targetWorkspacePromptPath]) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, prompt, "utf8");
      writtenFiles.push(targetPath);
    }
  }

  await fs.mkdir(path.dirname(plan.configPath), { recursive: true });
  await fs.writeFile(
    plan.configPath,
    `${JSON.stringify(
      {
        generatedBy: "honeycomb",
        generatedAt: new Date().toISOString(),
        agents: plan.agents.map((agent) => ({
          honeycombAgentId: agent.honeycombAgentId,
          openclawAgentId: agent.openclawAgentId,
          displayName: agent.displayName,
          role: agent.role,
          model: agent.model,
          providerId: agent.providerId,
          apiKeyConfigured: agent.apiKeyConfigured,
          apiKeyFingerprint: agent.apiKeyFingerprint,
          enabled: agent.enabled,
          tools: agent.tools
        })),
        providers: plan.providers
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writtenFiles.push(plan.configPath);

  await fs.writeFile(
    plan.nativeConfigPaths.clusterConfigPath,
    `${JSON.stringify(buildClusterConfig(plan, providers), null, 2)}\n`,
    "utf8"
  );
  writtenFiles.push(plan.nativeConfigPaths.clusterConfigPath);

  await fs.writeFile(
    plan.nativeConfigPaths.agentModelConfigPath,
    `${JSON.stringify(buildAgentModelConfig(plan, providers), null, 2)}\n`,
    "utf8"
  );
  writtenFiles.push(plan.nativeConfigPaths.agentModelConfigPath);

  await fs.writeFile(plan.nativeConfigPaths.envPath, buildRuntimeEnv(plan), "utf8");
  writtenFiles.push(plan.nativeConfigPaths.envPath);

  await fs.writeFile(
    plan.nativeConfigPaths.manifestPath,
    `${JSON.stringify(buildRuntimeManifest(plan), null, 2)}\n`,
    "utf8"
  );
  writtenFiles.push(plan.nativeConfigPaths.manifestPath);

  return {
    appliedAt: new Date().toISOString(),
    plan,
    writtenFiles,
    skippedFiles
  };
}

export async function validateOpenClawSync(input: {
  rootPath?: string;
} = {}): Promise<OpenClawValidationResult | null> {
  const plan = await buildOpenClawSyncPlan(input);
  if (!plan) {
    return null;
  }

  const requiredAgents = await Promise.all(
    plan.agents.map(async (agent) => {
      const agentPromptExists = await exists(agent.targetAgentPromptPath);
      const workspacePromptExists = await exists(agent.targetWorkspacePromptPath);
      return {
        honeycombAgentId: agent.honeycombAgentId,
        openclawAgentId: agent.openclawAgentId,
        present: agentPromptExists || workspacePromptExists,
        agentPromptPath: agent.targetAgentPromptPath,
        workspacePromptPath: agent.targetWorkspacePromptPath
      };
    })
  );
  const missingAgentIds = requiredAgents
    .filter((agent) => !agent.present)
    .map((agent) => agent.openclawAgentId);
  const [
    clusterConfigExists,
    agentModelConfigExists,
    envExists,
    manifestExists
  ] = await Promise.all([
    exists(plan.nativeConfigPaths.clusterConfigPath),
    exists(plan.nativeConfigPaths.agentModelConfigPath),
    exists(plan.nativeConfigPaths.envPath),
    exists(plan.nativeConfigPaths.manifestPath)
  ]);

  return {
    checkedAt: new Date().toISOString(),
    rootPath: plan.rootPath,
    requiredAgents,
    missingAgentIds,
    nativeConfig: {
      clusterConfigPath: plan.nativeConfigPaths.clusterConfigPath,
      clusterConfigExists,
      agentModelConfigPath: plan.nativeConfigPaths.agentModelConfigPath,
      agentModelConfigExists,
      envPath: plan.nativeConfigPaths.envPath,
      envExists,
      manifestPath: plan.nativeConfigPaths.manifestPath,
      manifestExists
    },
    ok:
      missingAgentIds.length === 0 &&
      clusterConfigExists &&
      agentModelConfigExists &&
      envExists &&
      manifestExists
  };
}
