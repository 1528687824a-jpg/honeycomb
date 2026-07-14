import { z } from "zod";
import { inferJobDisplayTitle, userTaskPrompt } from "./job-title";
import { normalizeJobModelCallBudget } from "./routing-budget";
import {
  DEFAULT_MAX_MODEL_CALLS,
  DEFAULT_ROUTING_MODE,
  ORCHESTRATION_PLAN_SOURCES,
  PANEL_MESSAGE_INTENTS,
  ROUTING_MODES,
  TASK_DELIVERABLE_KINDS,
  TASK_DELIVERY_TARGETS,
  type OrchestrationPlanSource,
  type PanelOrchestrationResult,
  type RoutingMode,
  type StageDefinition,
  type TaskDeliverable,
  type TaskOrchestrationPlan,
  type TaskOrchestrationStage
} from "./types";

const agentIdSchema = z.string().trim().min(2).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i);
const shortTextSchema = z.string().trim().min(1).max(500);
const acceptanceCriteriaSchema = z.array(shortTextSchema).min(1).max(12);

export const orchestrationStageDraftSchema = z.object({
  stageType: z.string().trim().min(1).max(80),
  agentId: agentIdSchema,
  name: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(1000),
  acceptanceCriteria: acceptanceCriteriaSchema,
  maxRetries: z.number().int().min(1).max(5).default(3)
});

export const taskDeliverableDraftSchema = z.object({
  kind: z.enum(TASK_DELIVERABLE_KINDS),
  description: z.string().trim().min(1).max(1000),
  required: z.boolean().default(true),
  format: z.string().trim().min(1).max(40).nullable().default(null),
  width: z.number().int().min(1).max(100_000).nullable().default(null),
  height: z.number().int().min(1).max(100_000).nullable().default(null),
  target: z.enum(TASK_DELIVERY_TARGETS).default("conversation"),
  targetPath: z.string().trim().min(1).max(2000).nullable().default(null)
});

export const taskOrchestrationPlanDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(2000),
  routingMode: z.enum(ROUTING_MODES),
  selectedAgents: z.array(agentIdSchema).min(1).max(24),
  skippedAgents: z.array(z.object({
    agentId: agentIdSchema,
    reason: z.string().trim().min(1).max(500)
  })).max(24).default([]),
  stages: z.array(orchestrationStageDraftSchema).min(1).max(24),
  qualityGate: z.object({
    enabled: z.boolean(),
    agentId: agentIdSchema.nullable().default(null),
    acceptanceCriteria: z.array(shortTextSchema).max(12).default([])
  }),
  deliverables: z.array(taskDeliverableDraftSchema).min(1).max(12),
  maxModelCalls: z.number().int().min(1).max(100).default(DEFAULT_MAX_MODEL_CALLS),
  blockingQuestions: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  rationale: z.string().trim().min(1).max(2000)
});

export const storedTaskOrchestrationPlanSchema = taskOrchestrationPlanDraftSchema.extend({
  version: z.literal("honeycomb.task-orchestration.v1"),
  source: z.enum(ORCHESTRATION_PLAN_SOURCES),
  generatedAt: z.string().datetime({ offset: true })
});

export const panelOrchestrationDraftSchema = z.object({
  intent: z.enum(PANEL_MESSAGE_INTENTS),
  reply: z.string().trim().min(1).max(10_000),
  plan: taskOrchestrationPlanDraftSchema.nullable()
}).superRefine((value, context) => {
  if (value.intent === "task" && !value.plan) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["plan"],
      message: "Task messages require an orchestration plan."
    });
  }
  if (value.intent === "chat" && value.plan) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["plan"],
      message: "Chat messages must not include a task plan."
    });
  }
});

type TaskPlanDraft = z.infer<typeof taskOrchestrationPlanDraftSchema>;

const DEFAULT_AGENT_IDS = [
  "research-agent",
  "writer-agent",
  "image-agent",
  "video-agent"
] as const;

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function normalizedFormat(value: string | null) {
  return value ? value.trim().replace(/^\./, "").toLowerCase() : null;
}

function normalizePlan(input: {
  draft: TaskPlanDraft;
  source: OrchestrationPlanSource;
  rawPrompt: string;
  generatedAt?: string;
  requestedMaxModelCalls?: number | null;
}): TaskOrchestrationPlan {
  const stages = input.draft.stages.map((stage): TaskOrchestrationStage => ({
    ...stage,
    maxRetries: Math.max(1, Math.min(5, stage.maxRetries ?? 3))
  }));
  const selectedAgents = unique(
    stages
      .map((stage) => stage.agentId)
      .filter((agentId) => agentId !== "test-agent")
  );
  const skippedAgents = input.draft.skippedAgents.filter(
    (entry, index, entries) =>
      !selectedAgents.includes(entry.agentId) &&
      entry.agentId !== input.draft.qualityGate.agentId &&
      entries.findIndex((candidate) => candidate.agentId === entry.agentId) === index
  );
  const qualityGate = {
    enabled: true,
    agentId: "test-agent",
    acceptanceCriteria: input.draft.qualityGate.acceptanceCriteria.length
      ? input.draft.qualityGate.acceptanceCriteria
      : ["Check every required deliverable against the user's explicit constraints"]
  };
  const maxModelCalls = normalizeJobModelCallBudget({
    requestedMaxModelCalls: input.requestedMaxModelCalls ?? input.draft.maxModelCalls,
    routingMode: input.draft.routingMode,
    executableStageCount: stages.length,
    classicFinalGateEnabled: qualityGate.enabled,
    discussionRounds: 2
  });

  return {
    version: "honeycomb.task-orchestration.v1",
    title: input.draft.title.trim() || inferJobDisplayTitle(input.rawPrompt),
    summary: input.draft.summary.trim(),
    routingMode: input.draft.routingMode,
    selectedAgents,
    skippedAgents,
    stages,
    qualityGate,
    deliverables: input.draft.deliverables.map((deliverable) => ({
      ...deliverable,
      format: normalizedFormat(deliverable.format),
      targetPath: deliverable.targetPath?.trim() || null
    })),
    maxModelCalls,
    blockingQuestions: unique(input.draft.blockingQuestions.map((value) => value.trim()).filter(Boolean)),
    rationale: input.draft.rationale.trim(),
    source: input.source,
    generatedAt: input.generatedAt ?? new Date().toISOString()
  };
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractJsonObject(value: string) {
  const stripped = stripJsonFence(value);
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(stripped.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

export function parsePanelOrchestrationOutput(input: {
  rawOutput: string;
  rawPrompt: string;
  requestedMaxModelCalls?: number | null;
  allowedAgentIds?: string[];
}): PanelOrchestrationResult | null {
  const json = extractJsonObject(input.rawOutput);
  const parsed = panelOrchestrationDraftSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  if (parsed.data.plan && input.allowedAgentIds?.length) {
    const allowedAgentIds = new Set(input.allowedAgentIds);
    const selectedAgentIds = parsed.data.plan.stages.map((stage) => stage.agentId);
    const qualityAgentId = parsed.data.plan.qualityGate.agentId ?? "test-agent";
    if (
      selectedAgentIds.some((agentId) => !allowedAgentIds.has(agentId)) ||
      !allowedAgentIds.has(qualityAgentId)
    ) {
      return null;
    }
  }

  return {
    intent: parsed.data.intent,
    reply: parsed.data.reply,
    plan: parsed.data.plan
      ? normalizePlan({
          draft: parsed.data.plan,
          source: "panel-agent",
          rawPrompt: input.rawPrompt,
          requestedMaxModelCalls: input.requestedMaxModelCalls
        })
      : null,
    source: "panel-agent",
    degraded: false,
    warnings: []
  };
}

export function parseStoredTaskOrchestrationPlan(value: unknown): TaskOrchestrationPlan | null {
  const parsed = storedTaskOrchestrationPlanSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return normalizePlan({
    draft: parsed.data,
    source: parsed.data.source,
    rawPrompt: parsed.data.summary,
    generatedAt: parsed.data.generatedAt
  });
}

function isTaskRequest(value: string) {
  const prompt = userTaskPrompt(value).trim();
  if (!prompt) return false;
  const englishTaskPattern = /\b(build|create|fix|repair|implement|generate|write|run|test|deploy|debug|analy[sz]e|summari[sz]e|refactor|update|delete|configure|connect|design|make|research|compare|produce)\b/i;
  const chineseTaskPattern = /(帮我|给我|为我|需要你|创建|新建|生成|设计|写(?:一个|一份|一下|个|篇|段|脚本|代码|文案)|实现|修改|修复|排查|检查|运行|测试|部署|整理|分析|总结|提取|转换|优化|接入|配置|删除|更新|做(?:一个|一下|个)|调研|比较|讨论|任务)/;
  return englishTaskPattern.test(prompt) || chineseTaskPattern.test(prompt);
}

function fallbackRoutingMode(prompt: string): RoutingMode {
  const value = prompt.toLowerCase();
  if (/compare|debate|strategy|option|tradeoff|ambiguous|brainstorm|讨论|比较|取舍|策略|方案选择|头脑风暴|多方意见|不确定|模糊/.test(value)) {
    return "master_slave_discussion";
  }
  if (/delegate|parallel|independent|multiple|many|分工|并行|多个独立|多项独立/.test(value)) {
    return "classic_master_slave";
  }
  if (/step|pipeline|workflow|first.+then|script|storyboard|先.+再|流程|步骤|分阶段|依次|先.+后|脚本|分镜/.test(value)) {
    return "pipeline";
  }
  return DEFAULT_ROUTING_MODE;
}

function taskSignals(rawPrompt: string) {
  const prompt = userTaskPrompt(rawPrompt);
  const research = /研究|调研|资料|网上|搜索|查询|查一下|最新|现状|竞品|事实|数据|来源|research|search|latest|current/i.test(prompt);
  const writing = /文案|文章|脚本|故事|标题|邮件|公告|推文|方案|报告|总结|润色|字幕|旁白|copy|story|script|write|writing|content|report|caption|voiceover/i.test(prompt);
  const image = /图片|图像|插画|海报|封面|配图|视觉|生成图|关键帧|缩略图|image|picture|illustration|poster|cover|keyframe|thumbnail|visual/i.test(prompt);
  const video = /视频|短片|动画|镜头|运镜|动态画面|生成视频|video|movie|clip|animation|animate/i.test(prompt);
  const discussion = /讨论|比较|取舍|策略|方案选择|头脑风暴|多方意见|debate|tradeoff|brainstorm|compare options/i.test(prompt);
  return { prompt, research, writing, image, video, discussion };
}

function fallbackStageDefinitions(rawPrompt: string): StageDefinition[] {
  const signals = taskSignals(rawPrompt);
  const stages: StageDefinition[] = [];

  if (signals.research || signals.discussion) {
    stages.push({
      stageType: "research",
      agentId: "research-agent",
      name: "Collect and assess task context",
      acceptanceCriteria: [
        "Collect only the context, evidence, constraints, or alternative viewpoints needed by this task",
        "Separate verified facts from assumptions and hand off usable findings"
      ],
      maxRetries: 3
    });
  }

  if (signals.writing || signals.discussion || (!signals.research && !signals.image && !signals.video)) {
    stages.push({
      stageType: "write",
      agentId: "writer-agent",
      name: "Produce the required written material",
      acceptanceCriteria: [
        "Follow the current user request and upstream task context",
        "Produce only the copy, script, report, summary, or decision material required by downstream work"
      ],
      maxRetries: 3
    });
  }

  if (signals.image) {
    stages.push({
      stageType: "image",
      agentId: "image-agent",
      name: "Generate the required image output",
      acceptanceCriteria: [
        "Preserve the requested subject, style, dimensions, text policy, format, and destination",
        "Return a real image artifact rather than only describing an image prompt"
      ],
      maxRetries: 3
    });
  }

  if (signals.video) {
    stages.push({
      stageType: "video",
      agentId: "video-agent",
      name: "Generate the required video output",
      acceptanceCriteria: [
        "Preserve the requested script, visual assets, motion, duration, format, and destination",
        "Return a completed or trackable video artifact rather than only describing a video prompt"
      ],
      maxRetries: 3
    });
  }

  return stages;
}

function parseDimensions(prompt: string) {
  const match = prompt.match(/(\d{2,5})\s*[x×X*]\s*(\d{2,5})/);
  return {
    width: match ? Number(match[1]) : null,
    height: match ? Number(match[2]) : null
  };
}

function requestedFormat(prompt: string, kind: TaskDeliverable["kind"]) {
  const formats = kind === "video"
    ? ["mp4", "mov", "webm"]
    : kind === "image"
      ? ["png", "jpeg", "jpg", "webp", "gif"]
      : ["docx", "pdf", "md", "txt", "pptx", "xlsx", "json", "csv"];
  return formats.find((format) => new RegExp(`(?:^|[^a-z0-9])${format}(?:$|[^a-z0-9])`, "i").test(prompt))
    ?.replace("jpg", "jpeg") ?? null;
}

function deliveryTarget(prompt: string): TaskDeliverable["target"] {
  if (/桌面|desktop/i.test(prompt)) return "desktop";
  if (/项目(?:目录|文件夹)|工作区|workspace|project folder/i.test(prompt)) return "workspace";
  if (/[A-Za-z]:\\|\/[A-Za-z0-9._-]+\//.test(prompt)) return "custom";
  return "conversation";
}

function fallbackDeliverables(rawPrompt: string): TaskDeliverable[] {
  const signals = taskSignals(rawPrompt);
  const dimensions = parseDimensions(signals.prompt);
  const target = deliveryTarget(signals.prompt);
  const deliverables: TaskDeliverable[] = [];
  if (signals.image) {
    deliverables.push({
      kind: "image",
      description: "Requested image or poster artifact",
      required: true,
      format: requestedFormat(signals.prompt, "image"),
      width: dimensions.width,
      height: dimensions.height,
      target,
      targetPath: null
    });
  }
  if (signals.video) {
    deliverables.push({
      kind: "video",
      description: "Requested completed video artifact",
      required: true,
      format: requestedFormat(signals.prompt, "video"),
      width: dimensions.width,
      height: dimensions.height,
      target,
      targetPath: null
    });
  }
  if (!signals.image && !signals.video) {
    deliverables.push({
      kind: signals.writing || signals.research || signals.discussion ? "text" : "other",
      description: "Requested task result",
      required: true,
      format: requestedFormat(signals.prompt, "text"),
      width: null,
      height: null,
      target,
      targetPath: null
    });
  }
  return deliverables;
}

function skippedAgents(selectedAgents: string[]) {
  return DEFAULT_AGENT_IDS
    .filter((agentId) => !selectedAgents.includes(agentId))
    .map((agentId) => ({
      agentId,
      reason: `Skipped because the current task does not require ${agentId.replace("-agent", "")} production work.`
    }));
}

export function inferFallbackStages(rawPrompt: string): StageDefinition[] {
  return fallbackStageDefinitions(rawPrompt);
}

export function buildDeterministicTaskPlan(input: {
  rawPrompt: string;
  requestedRoutingMode?: RoutingMode | null;
  requestedMaxModelCalls?: number | null;
  source?: OrchestrationPlanSource;
  generatedAt?: string;
}): TaskOrchestrationPlan {
  const stages = fallbackStageDefinitions(input.rawPrompt);
  const selectedAgents = unique(stages.map((stage) => stage.agentId));
  const routingMode = input.requestedRoutingMode ?? fallbackRoutingMode(userTaskPrompt(input.rawPrompt));
  const title = inferJobDisplayTitle(input.rawPrompt);
  const draft: TaskPlanDraft = {
    title,
    summary: `Execute ${title} with the smallest specialist team that satisfies the requested deliverables.`,
    routingMode,
    selectedAgents,
    skippedAgents: skippedAgents(selectedAgents),
    stages: stages.map((stage) => ({
      ...stage,
      objective: stage.name,
      maxRetries: stage.maxRetries ?? 3
    })),
    qualityGate: {
      enabled: true,
      agentId: "test-agent",
      acceptanceCriteria: [
        "Check every required deliverable against the user's explicit constraints",
        "Do not mark the task complete when a required file or output is missing"
      ]
    },
    deliverables: fallbackDeliverables(input.rawPrompt),
    maxModelCalls: input.requestedMaxModelCalls ?? DEFAULT_MAX_MODEL_CALLS,
    blockingQuestions: [],
    rationale: "Deterministic fallback selected the minimum matching specialist set from the current user request."
  };
  return normalizePlan({
    draft,
    source: input.source ?? "deterministic-fallback",
    rawPrompt: input.rawPrompt,
    generatedAt: input.generatedAt
  });
}

export function buildDeterministicPanelResult(input: {
  rawPrompt: string;
  language?: "zh" | "en";
  requestedMaxModelCalls?: number | null;
  warning?: string;
}): PanelOrchestrationResult {
  const task = isTaskRequest(input.rawPrompt);
  const language = input.language ?? "zh";
  if (!task) {
    return {
      intent: "chat",
      reply: language === "zh"
        ? "面板 Agent 当前无法生成在线回复，请检查面板模型连接后重试。"
        : "The panel agent cannot generate an online reply right now. Check its model connection and retry.",
      plan: null,
      source: "deterministic-fallback",
      degraded: true,
      warnings: input.warning ? [input.warning] : []
    };
  }

  const plan = buildDeterministicTaskPlan({
    rawPrompt: input.rawPrompt,
    requestedMaxModelCalls: input.requestedMaxModelCalls,
    source: "deterministic-fallback"
  });
  return {
    intent: "task",
    reply: language === "zh"
      ? `已为“${plan.title}”生成降级编排计划，将按最小必要 Agent 组合执行。`
      : `A fallback orchestration plan is ready for “${plan.title}” using the minimum necessary agent set.`,
    plan,
    source: "deterministic-fallback",
    degraded: true,
    warnings: input.warning ? [input.warning] : []
  };
}

export function panelOrchestrationJsonInstruction() {
  return [
    "Return exactly one valid JSON object and no Markdown fences.",
    "Schema:",
    '{"intent":"chat|task","reply":"natural user-facing reply","plan":null_or_plan}',
    "For chat, plan must be null.",
    "For task, plan must contain:",
    '{"title":"short task title","summary":"task summary","routingMode":"pipeline|supervisor_pipeline|classic_master_slave|master_slave_discussion","selectedAgents":["production-agent-id"],"skippedAgents":[{"agentId":"agent-id","reason":"why skipped"}],"stages":[{"stageType":"type","agentId":"agent-id","name":"stage name","objective":"stage objective","acceptanceCriteria":["criterion"],"maxRetries":3}],"qualityGate":{"enabled":true,"agentId":"test-agent","acceptanceCriteria":["criterion"]},"deliverables":[{"kind":"text|image|video|code|file|other","description":"required output","required":true,"format":null,"width":null,"height":null,"target":"conversation|desktop|workspace|custom","targetPath":null}],"maxModelCalls":20,"blockingQuestions":[],"rationale":"why this mode and team"}',
    "Routing mode rules: supervisor_pipeline is for quality-sensitive dependent work with test-and-repair after every stage; pipeline is for a clear strict sequence with one final quality gate; classic_master_slave is for independent work that should run in parallel and then be synthesized by main-agent; master_slave_discussion is for ambiguity, comparison, debate, or multiple viewpoints that must react to earlier contributions before main-agent synthesis.",
    "Choose the mode from the current task structure. Do not reuse a previous mode mechanically.",
    "Choose the minimum production-agent set. test-agent belongs in qualityGate, not selectedAgents.",
    "A still poster with no text normally selects image-agent only. Never select video-agent for a still-image task.",
    "A video may select writer-agent for script/captions and image-agent for cover/storyboard/keyframes only when needed.",
    "An explicit MD/TXT/JSON/CSV/PDF/DOCX/PPTX/XLSX deliverable must select a production agent that can return the complete content or write the real file. Never treat prose, a future promise, or a renamed extension as the document.",
    "Use research-agent only for fresh facts or sources. Use discussion mode only when multiple viewpoints materially help.",
    "Delivery path rules: conversation and desktop use targetPath=null; workspace uses only a relative destination directory inside the selected project; custom uses only an absolute destination directory explicitly supplied by the user.",
    "Never invent a targetPath and never treat a path in your plan as user authorization. Honeycomb independently verifies registered workspaces and custom destination grants before writing."
  ].join("\n");
}
