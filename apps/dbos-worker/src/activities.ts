import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  appendJobEvent,
  archiveJobSession,
  getJob,
  recordJobHeartbeat,
  setJobFinalOutput,
  setJobStatus,
  setJobWorkdir
} from "../../../packages/db/src/jobs";
import {
  completeStageAttempt,
  createArtifact,
  createGroupMessage,
  createPipelineStages,
  getArtifact,
  getNextStage,
  getStage,
  getStagesForJob,
  markStageCompleted,
  markStageFixing,
  markStageWaitingForHuman,
  saveTestReview,
  setNextStageInput,
  startStageAttempt
} from "../../../packages/db/src/pipeline";
import {
  countModelCallsForJob,
  getModelCallByKey,
  markModelCallFailed,
  markModelCallStarted,
  markModelCallSucceeded
} from "../../../packages/db/src/model-calls";
import { getAgentEventsForJob } from "../../../packages/db/src/session";
import { createExperienceCandidate } from "../../../packages/db/src/experience";
import type {
  AgentEventRecord,
  ArtifactRecord,
  ExperienceRecord,
  FinalQualityGateResult,
  GroupMessageRecord,
  GroupMessageType,
  JobRecord,
  RoutingMode,
  StageDefinition,
  StageRecord,
  StageRunResult,
  TestReviewResult
} from "../../../packages/shared/src/types";
import {
  DEFAULT_DISCUSSION_ROUNDS,
  DEFAULT_MAX_MODEL_CALLS,
  DEFAULT_ROUTING_MODE
} from "../../../packages/shared/src/types";
import {
  redactAgentRuntime,
  resolveAgentRuntimeCandidates,
  type AgentRuntimeRoute,
  type AgentRuntimeSecrets
} from "./agent-runtime";
import {
  getOpenClawAgentRunner,
  runOpenClawAgent,
  shouldUseProviderDirectRunner,
  type OpenClawRunResult
} from "./adapters/openclaw";
import { loadClusterConfig, type LoadedClusterConfig } from "./config/cluster";
import { deliverOutboundMessage } from "./egress/dispatcher";
import { maybeCrashOnce } from "./test-crash";

type OpenClawActionType =
  | "stage-agent"
  | "test-agent"
  | "main-agent-synthesis"
  | "final-test-agent";

function nowIso() {
  return new Date().toISOString();
}

async function heartbeat(jobId: string, source: string, note?: string | null, stageId?: string | null) {
  await recordJobHeartbeat({
    jobId,
    source,
    note,
    stageId: stageId ?? null
  });
}

function stageTypeToAgentType(stageType: string) {
  return stageType === "write" ? "writing" : stageType;
}

function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function truncateForPrompt(value: string | null | undefined, maxChars = 6000) {
  if (!value) {
    return "";
  }
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
}

function toSafeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\u0000/g, "");
}

function isOpenClawRealMode() {
  return process.env.OPENCLAW_AGENT_MODE === "real";
}

function routeReadinessError(route: AgentRuntimeSecrets) {
  if (!isOpenClawRealMode()) {
    return null;
  }
  if (!route.providerId) {
    return shouldUseProviderDirectRunner() ? "provider_not_bound" : null;
  }
  if (!route.providerBaseUrl) {
    return "provider_base_url_missing";
  }
  if (!route.model) {
    return "model_not_configured";
  }
  if (!route.apiKey) {
    return "provider_api_key_missing";
  }
  return null;
}

function routeAttemptPayload(input: {
  route: AgentRuntimeRoute;
  ok: boolean;
  latencyMs: number;
  error?: string | null;
}) {
  return {
    route: input.route,
    ok: input.ok,
    latencyMs: input.latencyMs,
    error: input.error ?? null
  };
}

function getModelCallResult(payload: Record<string, unknown> | null): OpenClawRunResult | null {
  if (!payload || !("result" in payload)) {
    return null;
  }

  return payload.result as OpenClawRunResult | null;
}

async function runOpenClawAgentIdempotent(input: {
  jobId: string;
  stageId?: string | null;
  stageIndex: number;
  attemptNo: number;
  actionType: OpenClawActionType;
  agentId: string;
  sessionId: string;
  message: string;
  providerDirectMessage?: string | null;
  outputDir?: string | null;
  timeoutSeconds: number;
}): Promise<OpenClawRunResult | null> {
  const idempotencyKey = [
    input.jobId,
    input.stageId ?? "job",
    input.attemptNo,
    input.actionType
  ].join(":");
  const existing = await getModelCallByKey(idempotencyKey);
  const routes = await resolveAgentRuntimeCandidates({ requestedAgentId: input.agentId });
  const primaryRoute = routes[0];
  const redactedPrimaryRoute = redactAgentRuntime(primaryRoute);
  const redactedRouteCandidates = routes.map(redactAgentRuntime);

  if (existing?.status === "succeeded") {
    await heartbeat(
      input.jobId,
      `openclaw.${input.actionType}.reused`,
      input.agentId,
      input.stageId ?? null
    );
    await appendJobEvent(
      input.jobId,
      "tool.openclaw_agent_reused",
      {
        stageId: input.stageId,
        agentId: primaryRoute.honeycombAgentId,
        requestedAgentId: input.agentId,
        openclawAgentId: primaryRoute.openclawAgentId,
        attemptNo: input.attemptNo,
        actionType: input.actionType,
        modelCallId: existing.id,
        idempotencyKey,
        route: redactedPrimaryRoute,
        routeCandidates: redactedRouteCandidates
      },
      {
        actor: "tool-gateway",
        stageId: input.stageId ?? null
      }
    );
    return getModelCallResult(existing.responsePayload);
  }

  if (existing?.status === "started") {
    throw new Error(
      `Ambiguous OpenClaw model call already started without a completed result: ${idempotencyKey}`
    );
  }

  await heartbeat(
    input.jobId,
    `openclaw.${input.actionType}.starting`,
    input.agentId,
    input.stageId ?? null
  );
  await markModelCallStarted({
    idempotencyKey,
    jobId: input.jobId,
    stageId: input.stageId,
    attemptNo: input.attemptNo,
    actionType: input.actionType,
    agentId: primaryRoute.honeycombAgentId,
    agentSessionId: input.sessionId,
    requestHash: sha256(input.message)
  });

  await appendJobEvent(
    input.jobId,
    "tool.openclaw_agent_requested",
    {
      stageId: input.stageId,
      agentId: primaryRoute.honeycombAgentId,
      requestedAgentId: input.agentId,
      openclawAgentId: primaryRoute.openclawAgentId,
      attemptNo: input.attemptNo,
      actionType: input.actionType,
      idempotencyKey,
      mode: isOpenClawRealMode() ? "real" : "mock",
      runner: isOpenClawRealMode()
        ? shouldUseProviderDirectRunner()
          ? "provider-direct"
          : getOpenClawAgentRunner()
        : "mock",
      route: redactedPrimaryRoute,
      routeCandidates: redactedRouteCandidates
    },
    {
      actor: "tool-gateway",
      stageId: input.stageId ?? null
    }
  );

  const routeAttempts: ReturnType<typeof routeAttemptPayload>[] = [];
  let lastError: string | null = null;
  try {
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex];
      const redactedRoute = redactAgentRuntime(route);
      const startedAt = Date.now();
      try {
        const readinessError = routeReadinessError(route);
        if (readinessError) {
          throw new Error(readinessError);
        }

        await heartbeat(
          input.jobId,
          `openclaw.${input.actionType}.route_started`,
          `${route.honeycombAgentId} route ${routeIndex + 1}/${routes.length}`,
          input.stageId ?? null
        );
        const result = await runOpenClawAgent({
          agentId: route.openclawAgentId,
          sessionId: input.sessionId,
          message: input.message,
          providerDirectMessage: input.providerDirectMessage,
          provider: {
            providerId: route.providerId,
            baseUrl: route.providerBaseUrl,
            model: route.model,
            apiKey: route.apiKey,
            agentRole: route.agentRole
          },
          outputDir: input.outputDir,
          timeoutSeconds: input.timeoutSeconds
        });
        const successAttempt = routeAttemptPayload({
          route: redactedRoute,
          ok: true,
          latencyMs: Date.now() - startedAt
        });
        routeAttempts.push(successAttempt);

        await markModelCallSucceeded({
          idempotencyKey,
          responsePayload: {
            result,
            route: redactedRoute,
            routeAttempts,
            routeSelection: {
              selectedIndex: routeIndex,
              attemptedCount: routeAttempts.length,
              failoverUsed: routeIndex > 0
            }
          }
        });

        await appendJobEvent(
          input.jobId,
          "tool.openclaw_agent_completed",
          {
            stageId: input.stageId,
            agentId: route.honeycombAgentId,
            requestedAgentId: input.agentId,
            openclawAgentId: route.openclawAgentId,
            attemptNo: input.attemptNo,
            actionType: input.actionType,
            idempotencyKey,
            mode: result?.mode ?? null,
            sessionId: result?.sessionId ?? input.sessionId,
            route: redactedRoute,
            routeAttempts,
            routeSelection: {
              selectedIndex: routeIndex,
              attemptedCount: routeAttempts.length,
              failoverUsed: routeIndex > 0
            }
          },
          {
            actor: "tool-gateway",
            stageId: input.stageId ?? null
          }
        );
        await heartbeat(
          input.jobId,
          `openclaw.${input.actionType}.completed`,
          `${route.honeycombAgentId} route ${routeIndex + 1}/${routes.length}`,
          input.stageId ?? null
        );

        maybeCrashOnce(
          `after-openclaw-${input.actionType}-stage-${input.stageIndex
            .toString()
            .padStart(3, "0")}-attempt-${input.attemptNo.toString().padStart(2, "0")}`,
          input.jobId
        );

        return result;
      } catch (error) {
        lastError = toSafeErrorMessage(error);
        const failedAttempt = routeAttemptPayload({
          route: redactedRoute,
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: lastError
        });
        routeAttempts.push(failedAttempt);
        await heartbeat(
          input.jobId,
          `openclaw.${input.actionType}.route_failed`,
          lastError,
          input.stageId ?? null
        );
        await appendJobEvent(
          input.jobId,
          "tool.openclaw_agent_route_failed",
          {
            stageId: input.stageId,
            agentId: route.honeycombAgentId,
            requestedAgentId: input.agentId,
            openclawAgentId: route.openclawAgentId,
            attemptNo: input.attemptNo,
            actionType: input.actionType,
            idempotencyKey,
            routeIndex,
            route: redactedRoute,
            error: lastError
          },
          {
            actor: "tool-gateway",
            stageId: input.stageId ?? null
          }
        );
      }
    }

    throw new Error(
      `All OpenClaw route attempts failed for ${idempotencyKey}: ${lastError ?? "unknown_error"}`
    );
  } catch (error) {
    await markModelCallFailed({
      idempotencyKey,
      error: toSafeErrorMessage(error)
    });
    await heartbeat(
      input.jobId,
      `openclaw.${input.actionType}.failed`,
      toSafeErrorMessage(error),
      input.stageId ?? null
    );
    throw new Error(toSafeErrorMessage(error));
  }
}

function toWslPath(inputPath: string) {
  const match = inputPath.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) {
    return inputPath.replace(/\\/g, "/");
  }

  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function displayOnlyHandoffLine(targetAgentId: string | null | undefined, note?: string) {
  if (!targetAgentId) {
    return "显示说明：这条消息只用于群内展示；实际状态以本地 DBOS/Postgres 为准。";
  }

  return `显示说明：@${targetAgentId}${note ? `（${note}）` : ""}只给用户看；实际交接已在本地编排服务完成。`;
}

async function postGroupMessage(input: {
  jobId: string;
  stageId?: string | null;
  senderAgentId: string;
  mentionAgentId?: string | null;
  messageType: GroupMessageType;
  content: string;
  artifactId?: string | null;
  id?: string;
}): Promise<GroupMessageRecord> {
  const job = await getJob(input.jobId);
  const groupMessage = await createGroupMessage(input);

  await deliverOutboundMessage({
    groupMessageId: groupMessage.id,
    jobId: groupMessage.jobId,
    stageId: groupMessage.stageId,
    ingressOrigin: job?.ingressOrigin ?? "http",
    senderAgentId: groupMessage.senderAgentId,
    mentionAgentId: groupMessage.mentionAgentId,
    messageType: groupMessage.messageType,
    content: groupMessage.content,
    artifactId: groupMessage.artifactId,
    feishuChatId: job?.feishuChatId ?? null,
    feishuMessageId: groupMessage.feishuMessageId
  });

  return groupMessage;
}

export async function markJobRunning(jobId: string) {
  await setJobStatus(jobId, "running");
}

export async function isJobCancelled(jobId: string) {
  const job = await getJob(jobId);
  return job?.status === "cancelled";
}

export async function getJobRoutingMode(jobId: string): Promise<RoutingMode> {
  const job = await getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const routingMode = job.routingMode ?? DEFAULT_ROUTING_MODE;
  await appendJobEvent(jobId, "main.routing_mode_selected", { routingMode });
  return routingMode;
}

export async function getJobDiscussionRounds(jobId: string): Promise<number> {
  const job = await getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const discussionRounds = job.discussionRounds ?? DEFAULT_DISCUSSION_ROUNDS;
  await appendJobEvent(jobId, "discussion.round_count_selected", { discussionRounds });
  return discussionRounds;
}

export async function enforceModelCallBudget(input: {
  jobId: string;
  nextActionType: OpenClawActionType;
  nextAgentId: string;
}) {
  const job = await getJob(input.jobId);
  if (!job) {
    throw new Error(`Job not found: ${input.jobId}`);
  }

  const currentModelCalls = await countModelCallsForJob(input.jobId);
  const maxModelCalls = job.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS;
  const allowed = currentModelCalls < maxModelCalls;

  if (!allowed) {
    const reason = `Model-call budget exhausted before ${input.nextActionType}`;
    await setJobStatus(input.jobId, "waiting_for_human", {
      reason,
      currentModelCalls,
      maxModelCalls,
      nextActionType: input.nextActionType,
      nextAgentId: input.nextAgentId
    });
    await appendJobEvent(input.jobId, "budget.model_calls_exhausted", {
      currentModelCalls,
      maxModelCalls,
      nextActionType: input.nextActionType,
      nextAgentId: input.nextAgentId
    });
  }

  return {
    allowed,
    currentModelCalls,
    maxModelCalls,
    nextActionType: input.nextActionType,
    nextAgentId: input.nextAgentId
  };
}

export async function shouldRunFinalQualityGate(input: {
  jobId: string;
  routingMode: RoutingMode;
}) {
  const job = await getJob(input.jobId);
  if (!job) {
    throw new Error(`Job not found: ${input.jobId}`);
  }

  const enabled =
    input.routingMode === "pipeline" ||
    input.routingMode === "master_slave_discussion" ||
    (input.routingMode === "classic_master_slave" && job.classicFinalGateEnabled);

  await appendJobEvent(input.jobId, "final.quality_gate_decision", {
    routingMode: input.routingMode,
    enabled,
    classicFinalGateEnabled: job.classicFinalGateEnabled
  });

  return {
    enabled,
    routingMode: input.routingMode,
    source: input.routingMode === "classic_master_slave" ? "job.classicFinalGateEnabled" : "routingMode"
  };
}

export async function getLatestStageOutputArtifactId(jobId: string) {
  const stages = await getStagesForJob(jobId);
  const latestStageWithOutput = [...stages]
    .reverse()
    .find((stage) => typeof stage.outputArtifactId === "string" && stage.outputArtifactId);

  if (!latestStageWithOutput?.outputArtifactId) {
    throw new Error(`No stage output artifact found for job: ${jobId}`);
  }

  return latestStageWithOutput.outputArtifactId;
}

export async function markJobPlanning(jobId: string) {
  await setJobStatus(jobId, "planning");
}

export async function markJobWaitingForHuman(jobId: string, reason: string) {
  await setJobStatus(jobId, "waiting_for_human", { reason });
}

export async function ensureJobWaitingForHuman(input: { jobId: string; reason: string }) {
  const job = await getJob(input.jobId);
  if (!job) {
    throw new Error(`Job not found: ${input.jobId}`);
  }
  if (job.status === "waiting_for_human") {
    return {
      changed: false,
      status: job.status,
      reason: job.heartbeatNote ?? input.reason
    };
  }

  await markJobWaitingForHuman(input.jobId, input.reason);
  return {
    changed: true,
    status: "waiting_for_human" as const,
    reason: input.reason
  };
}

export async function markJobFailed(jobId: string, reason: string) {
  await setJobStatus(jobId, "failed", { reason });
}

export async function prepareJobWorkspace(jobId: string) {
  const job = await getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const root = path.resolve(process.env.JOB_DATA_DIR ?? "data/jobs", jobId);
  const inputDir = path.join(root, "input");
  const planDir = path.join(root, "plan");
  const logsDir = path.join(root, "logs");
  const finalDir = path.join(root, "final");

  await mkdir(inputDir, { recursive: true });
  await mkdir(planDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await mkdir(finalDir, { recursive: true });

  const requestPath = path.join(inputDir, "user-request.md");
  await writeFile(requestPath, job.rawPrompt, "utf8");

  const logPath = path.join(logsDir, "main-log.md");
  await writeFile(logPath, `# Main Log\n\n- Job ${jobId} prepared.\n`, "utf8");

  await setJobWorkdir(jobId, root);

  const userRequest = await createArtifact({
    id: `${jobId}-ART-USER-REQUEST`,
    jobId,
    type: "user_request",
    title: "User request",
    content: job.rawPrompt,
    uri: requestPath
  });

  await createArtifact({
    id: `${jobId}-ART-MAIN-LOG`,
    jobId,
    type: "log",
    title: "Main log",
    uri: logPath
  });

  await postGroupMessage({
    id: `${jobId}-MSG-USER-TASK`,
    jobId,
    senderAgentId: "user",
    mentionAgentId: "main-agent",
    messageType: "user_task",
    artifactId: userRequest.id,
    content: [
      `Task completed: ${jobId}`,
      `@main-agent 新任务 ${jobId}`,
      displayOnlyHandoffLine("main-agent", "真人输入，进入主 Agent 编排"),
      "",
      job.rawPrompt,
      "",
      `用户需求 artifact：${requestPath}`
    ].join("\n")
  });

  return {
    workdir: root,
    userRequestArtifactId: userRequest.id
  };
}

export function inferStagesFromPrompt(rawPrompt: string): StageDefinition[] {
  const needsResearch =
    /研究|调研|资料|网上|搜索|查询|查一下|最新|现状|竞品|事实|数据|来源|research|search|latest|current/i.test(
      rawPrompt
    );
  const needsWriting =
    /文案|文章|脚本|故事|标题|邮件|公告|推文|方案|报告|总结|润色|写|copy|story|script|write|writing|content/i.test(
      rawPrompt
    );
  const needsImage =
    /图片|图像|插画|海报|封面|配图|视觉|生成图|image|picture|illustration|poster|visual/i.test(
      rawPrompt
    );
  const needsVideo =
    /视频|短片|动画|分镜|镜头|运镜|动态画面|生成视频|video|movie|clip|animation|animate|storyboard/i.test(
      rawPrompt
    );

  const shouldRunResearch =
    needsResearch ||
    /\u7814\u7a76|\u8c03\u7814|\u8d44\u6599|\u7f51\u4e0a|\u641c\u7d22|\u67e5\u8be2|\u6700\u65b0|\u73b0\u72b6|\u7ade\u54c1|\u4e8b\u5b9e|\u6570\u636e|\u6765\u6e90/i.test(rawPrompt);
  const shouldRunWriting =
    needsWriting ||
    /\u6587\u6848|\u6587\u7ae0|\u811a\u672c|\u6545\u4e8b|\u6807\u9898|\u90ae\u4ef6|\u516c\u544a|\u63a8\u6587|\u65b9\u6848|\u62a5\u544a|\u603b\u7ed3|\u6da6\u8272|\u5199/i.test(rawPrompt);
  const shouldRunImage =
    needsImage ||
    /\u56fe\u7247|\u56fe\u50cf|\u63d2\u753b|\u6d77\u62a5|\u5c01\u9762|\u914d\u56fe|\u89c6\u89c9|\u5ba3\u4f20\u56fe|\u751f\u6210\u56fe/i.test(rawPrompt);
  const shouldRunVideo =
    needsVideo ||
    /\u89c6\u9891|\u77ed\u7247|\u52a8\u753b|\u5206\u955c|\u955c\u5934|\u8fd0\u955c|\u52a8\u6001\u753b\u9762|\u751f\u6210\u89c6\u9891/i.test(rawPrompt);

  const stages: StageDefinition[] = [];

  if (shouldRunResearch) {
    stages.push({
      stageType: "research",
      agentId: "research-agent",
      name: "Collect task context",
      acceptanceCriteria: [
        "Gather relevant sources or context when external facts are needed",
        "Summarize facts, assumptions, risks, and useful constraints",
        "Provide a handoff that the next child agent or main-agent can consume"
      ],
      maxRetries: 3
    });
  }

  if (shouldRunWriting || (!shouldRunResearch && !shouldRunImage && !shouldRunVideo)) {
    stages.push({
      stageType: "write",
      agentId: "writer-agent",
      name: "Write requested content",
      acceptanceCriteria: [
        "Use the user request and upstream artifact as input",
        "Produce the requested copy, article, script, story, summary, or written content",
        "Include a handoff note if a later stage needs to use this text"
      ],
      maxRetries: 3
    });
  }

  if (shouldRunImage) {
    stages.push({
      stageType: "image",
      agentId: "image-agent",
      name: "Generate requested image output",
      acceptanceCriteria: [
        "Use the user request and upstream artifact as input",
        "Produce an image brief, image prompt, or image artifact path according to the task",
        "Preserve important constraints, style, subject, and usage requirements"
      ],
      maxRetries: 3
    });
  }

  if (shouldRunVideo) {
    stages.push({
      stageType: "video",
      agentId: "video-agent",
      name: "Generate requested video output",
      acceptanceCriteria: [
        "Use the user request and upstream artifact as input",
        "Produce a video brief, storyboard, video prompt, or video artifact path according to the task",
        "Preserve important constraints, style, subject, motion, timing, and usage requirements"
      ],
      maxRetries: 3
    });
  }

  return stages;
}

export function mergePromptStagesWithClusterStages(
  clusterStages: StageDefinition[] | undefined,
  promptStages: StageDefinition[]
): StageDefinition[] {
  if (!clusterStages?.length) {
    return promptStages;
  }
  if (!promptStages.length) {
    return clusterStages;
  }

  return promptStages.map((stage) => {
    const matchingClusterStage =
      clusterStages.find((candidate) => candidate.agentId === stage.agentId) ??
      clusterStages.find((candidate) => candidate.stageType === stage.stageType);

    if (!matchingClusterStage) {
      return stage;
    }

    return {
      ...stage,
      stageType: matchingClusterStage.stageType || stage.stageType,
      name: matchingClusterStage.name || stage.name,
      acceptanceCriteria: matchingClusterStage.acceptanceCriteria.length
        ? matchingClusterStage.acceptanceCriteria
        : stage.acceptanceCriteria,
      maxRetries: matchingClusterStage.maxRetries ?? stage.maxRetries
    };
  });
}

type StageSelectionSummary = {
  stageType: string;
  agentId: string;
  name: string;
  reason: string;
  source: "prompt" | "cluster";
};

type SkippedClusterStageSummary = {
  stageType: string;
  agentId: string;
  name: string;
  reason: string;
};

function stageSelectionReason(stage: StageDefinition) {
  if (stage.agentId === "research-agent" || stage.stageType === "research") {
    return "Selected only when the task needs fresh facts, sources, market context, or external research before production.";
  }
  if (stage.agentId === "writer-agent" || stage.stageType === "write" || stage.stageType === "writing") {
    return "Selected because the task needs written copy, titles, scripts, captions, summaries, or text that a downstream media stage can use.";
  }
  if (stage.agentId === "image-agent" || stage.stageType === "image") {
    return "Selected because the task asks for a still image, poster, cover, visual brief, or image-generation artifact.";
  }
  if (stage.agentId === "video-agent" || stage.stageType === "video") {
    return "Selected because the task asks for video, animation, storyboard, motion, timing, or a video-generation artifact.";
  }
  if (stage.agentId === "test-agent" || stage.stageType === "review") {
    return "Selected as the quality gate for child-agent deliverables.";
  }
  return "Selected because prompt analysis matched this specialist capability to the requested deliverable.";
}

function skippedClusterStageReason(stage: StageDefinition) {
  if (stage.agentId === "research-agent" || stage.stageType === "research") {
    return "Skipped because this task did not require fresh sourced research before production.";
  }
  if (stage.agentId === "writer-agent" || stage.stageType === "write" || stage.stageType === "writing") {
    return "Skipped because this task did not require a separate writing stage.";
  }
  if (stage.agentId === "image-agent" || stage.stageType === "image") {
    return "Skipped because this task did not request still-image or poster output.";
  }
  if (stage.agentId === "video-agent" || stage.stageType === "video") {
    return "Skipped because this task did not request video, animation, motion, storyboard, or video output.";
  }
  if (stage.agentId === "test-agent" || stage.stageType === "review") {
    return "Skipped from production stages because test-agent is invoked as a quality gate, not as a production child agent.";
  }
  return "Skipped because configured cluster stages are a capability pool and this specialist was not needed for the current deliverable.";
}

export function describeStageSelection(input: {
  promptStages: StageDefinition[];
  selectedStages: StageDefinition[];
  clusterStages?: StageDefinition[];
}) {
  const promptAgentIds = new Set(input.promptStages.map((stage) => stage.agentId));
  const promptStageTypes = new Set(input.promptStages.map((stage) => stage.stageType));
  const selectedAgentIds = new Set(input.selectedStages.map((stage) => stage.agentId));
  const selectedStageTypes = new Set(input.selectedStages.map((stage) => stage.stageType));

  const selectedStages: StageSelectionSummary[] = input.selectedStages.map((stage) => ({
    stageType: stage.stageType,
    agentId: stage.agentId,
    name: stage.name,
    reason: stageSelectionReason(stage),
    source:
      promptAgentIds.has(stage.agentId) || promptStageTypes.has(stage.stageType)
        ? "prompt"
        : "cluster"
  }));

  const skippedClusterStages: SkippedClusterStageSummary[] = (input.clusterStages ?? [])
    .filter((stage) => !selectedAgentIds.has(stage.agentId) && !selectedStageTypes.has(stage.stageType))
    .map((stage) => ({
      stageType: stage.stageType,
      agentId: stage.agentId,
      name: stage.name,
      reason: skippedClusterStageReason(stage)
    }));

  return {
    policy: [
      "Infer required stages from the current user task first.",
      "Use cluster.config as a capability pool that enriches selected stages, not as a mandatory fixed pipeline.",
      "Run the minimal specialist set needed for the requested deliverable, then quality-gate production outputs."
    ],
    selectedStages,
    skippedClusterStages
  };
}

type AgentPromptSnapshot = {
  path: string | null;
  contents: string | null;
  error: string | null;
};

async function loadAgentPromptSnapshot(
  agentId: string,
  clusterConfig: LoadedClusterConfig | null
): Promise<AgentPromptSnapshot> {
  if (!clusterConfig) {
    return {
      path: null,
      contents: null,
      error: "cluster_config_not_loaded"
    };
  }

  const agentConfig = clusterConfig.agents.find((agent) => agent.id === agentId);
  if (!agentConfig?.promptPath) {
    return {
      path: null,
      contents: null,
      error: "agent_prompt_path_not_configured"
    };
  }

  const promptPath = path.isAbsolute(agentConfig.promptPath)
    ? agentConfig.promptPath
    : path.resolve(path.dirname(clusterConfig.configPath), agentConfig.promptPath);

  try {
    return {
      path: promptPath,
      contents: truncateForPrompt(await readFile(promptPath, "utf8"), 5000),
      error: null
    };
  } catch (error) {
    return {
      path: promptPath,
      contents: null,
      error: toSafeErrorMessage(error)
    };
  }
}

function formatAgentPromptSnapshot(snapshot: AgentPromptSnapshot) {
  if (snapshot.contents) {
    return [
      `Agent AGENTS.md prompt snapshot (${snapshot.path ?? "unknown path"}):`,
      snapshot.contents
    ].join("\n");
  }
  return [
    "Agent AGENTS.md prompt snapshot:",
    `Path: ${snapshot.path ?? "not configured"}`,
    `Unavailable: ${snapshot.error ?? "not found"}`
  ].join("\n");
}

function stagePreflightInstructions(input: {
  workLogPath: string;
  stateDir: string;
  stageDir: string;
  upstreamArtifactPath?: string | null;
}) {
  return [
    "Agent preflight contract:",
    "- First review the AGENTS.md prompt snapshot/path supplied in this task packet and stay inside that specialist role.",
    "- Before producing, inspect available upstream artifacts, agent-work-log.md, final-summary/task-summary files, and experience-library hints.",
    "- Treat previous summaries and experience memory as hints; re-check the current user task before deciding what to create.",
    "- If the current runner cannot read a prompt, summary, or experience file, note the missing context in agent-work-log.md and continue with the supplied task packet.",
    "- Do not use a different specialist role just because that agent exists in the configured cluster.",
    `Work log path: ${input.workLogPath}`,
    `State JSON directory: ${input.stateDir}`,
    `Output directory: ${input.stageDir}`,
    input.upstreamArtifactPath ? `Upstream artifact path: ${input.upstreamArtifactPath}` : "Upstream artifact path: none"
  ].join("\n");
}

function isReviewStage(stage: StageDefinition) {
  return stage.stageType === "review" || stage.agentId === "test-agent";
}

export function executablePipelineStages(stages: StageDefinition[]): StageDefinition[] {
  return stages
    .filter((stage) => !isReviewStage(stage))
    .map((stage) => ({
      ...stage,
      maxRetries: Math.max(1, stage.maxRetries ?? 3)
    }));
}

export async function createPipelinePlan(input: {
  jobId: string;
  userRequestArtifactId: string;
}): Promise<StageRecord[]> {
  await markJobPlanning(input.jobId);
  const job = await getJob(input.jobId);
  if (!job) {
    throw new Error(`Job not found: ${input.jobId}`);
  }

  const workdir = job.workdir ?? path.resolve(process.env.JOB_DATA_DIR ?? "data/jobs", input.jobId);
  const planPath = path.join(workdir, "plan", "pipeline-plan.json");
  const rawPrompt = job.rawPrompt;
  const clusterConfig = await loadClusterConfig();
  const promptStages = inferStagesFromPrompt(rawPrompt);
  const mergedStages = mergePromptStagesWithClusterStages(clusterConfig?.stages, promptStages);
  const stages = executablePipelineStages(mergedStages);
  const orchestrationDecision = describeStageSelection({
    promptStages,
    selectedStages: mergedStages,
    clusterStages: clusterConfig?.stages
  });
  const selectedAgents = orchestrationDecision.selectedStages.map((stage) => stage.agentId);
  const skippedClusterAgents = orchestrationDecision.skippedClusterStages.map((stage) => stage.agentId);
  const skippedClusterStageCount = orchestrationDecision.skippedClusterStages.length;

  const plan = {
    jobId: input.jobId,
    sourceArtifactId: input.userRequestArtifactId,
    planningAgentId: "main-agent",
    routingMode: job.routingMode ?? clusterConfig?.defaultRoutingMode ?? DEFAULT_ROUTING_MODE,
    orchestrationDecision,
    clusterConfig: clusterConfig
      ? {
          clusterId: clusterConfig.clusterId,
          name: clusterConfig.name,
          configPath: clusterConfig.configPath,
          planner: clusterConfig.source.planner
        }
      : null,
    stages
  };

  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  await createArtifact({
    id: `${input.jobId}-ART-PIPELINE-PLAN`,
    jobId: input.jobId,
    type: "pipeline_plan",
    title: "Main-agent pipeline plan",
    content: JSON.stringify(plan, null, 2),
    uri: planPath
  });

  await appendJobEvent(input.jobId, "main.pipeline_planned", {
    planPath,
    routingMode: plan.routingMode,
    stageCount: plan.stages.length,
    clusterId: clusterConfig?.clusterId ?? null,
    filteredStageCount: mergedStages.length - stages.length,
    promptStageCount: promptStages.length,
    skippedClusterStageCount,
    selectedAgents,
    skippedClusterAgents,
    stageSelectionReasons: orchestrationDecision.selectedStages.map((stage) => ({
      agentId: stage.agentId,
      stageType: stage.stageType,
      reason: stage.reason
    }))
  });

  return createPipelineStages(input.jobId, plan.stages, input.userRequestArtifactId);
}

export async function runStageAgent(input: {
  jobId: string;
  stageId: string;
  attemptNo: number;
  routingMode?: RoutingMode;
  handoffTargetAgentId?: string | null;
  outputMessageType?: GroupMessageType;
}): Promise<StageRunResult> {
  const [job, stage] = await Promise.all([getJob(input.jobId), getStage(input.stageId)]);
  if (!job) {
    throw new Error(`Job not found: ${input.jobId}`);
  }

  await setJobStatus(input.jobId, input.attemptNo > 1 ? "fixing" : "running", {
    source: "stage.agent_started",
    stageId: input.stageId,
    attemptNo: input.attemptNo
  });

  const routingMode = input.routingMode ?? job.routingMode ?? DEFAULT_ROUTING_MODE;
  const handoffTargetAgentId =
    input.handoffTargetAgentId === undefined ? "test-agent" : input.handoffTargetAgentId;
  const outputMessageType = input.outputMessageType ?? "stage_output_to_test";
  const workdir = job.workdir ?? path.resolve(process.env.JOB_DATA_DIR ?? "data/jobs", input.jobId);
  const stageDir = path.join(
    workdir,
    "stages",
    `${stage.stageIndex.toString().padStart(3, "0")}-${stage.stageType}`
  );
  const stateDir = path.join(workdir, "state");
  const workLogPath = path.join(workdir, "agent-work-log.md");
  await mkdir(stageDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const agentSessionId =
    stage.originalAgentSessionId ??
    `${job.sessionId}:${stage.agentId}:stage-${stage.stageIndex.toString().padStart(3, "0")}`;
  const attemptId = await startStageAttempt({
    stageId: stage.id,
    attemptNo: input.attemptNo,
    agentId: stage.agentId,
    agentSessionId,
    inputArtifactId: stage.inputArtifactId
  });

  await appendJobEvent(
    input.jobId,
    "stage.agent_started",
    {
      stageId: stage.id,
      agentId: stage.agentId,
      attemptNo: input.attemptNo,
      agentSessionId,
      routingMode,
      handoffTargetAgentId,
      outputMessageType
    },
    {
            actor: "dbos-harness",
      stageId: stage.id
    }
  );

  const shouldForceFirstFailure =
    stage.stageIndex === 1 &&
    input.attemptNo === 1 &&
    /force fail|强制失败|测试失败/i.test(job.rawPrompt);
  const shouldAlwaysFail =
    stage.stageIndex === 1 && /always fail|连续失败|三次失败|一直失败/i.test(job.rawPrompt);

  const quality = shouldForceFirstFailure || shouldAlwaysFail ? "needs_fix" : "ready_for_test";
  const upstreamArtifact = stage.inputArtifactId ? await getArtifact(stage.inputArtifactId) : null;
  const upstreamPromptContext = upstreamArtifact
    ? truncateForPrompt(upstreamArtifact.content || upstreamArtifact.uri || "", 6000)
    : "";
  const clusterConfig = await loadClusterConfig().catch(() => null);
  const agentPromptSnapshot = await loadAgentPromptSnapshot(stage.agentId, clusterConfig);
  const preflightInstructions = stagePreflightInstructions({
    workLogPath,
    stateDir,
    stageDir,
    upstreamArtifactPath: upstreamArtifact?.uri ?? null
  });
  const isMediaProviderDirectStage = stage.stageType === "image" || stage.stageType === "video";
  await appendJobEvent(input.jobId, "stage.agent_prompt_context_loaded", {
    stageId: stage.id,
    agentId: stage.agentId,
    promptPath: agentPromptSnapshot.path,
    promptLoaded: Boolean(agentPromptSnapshot.contents),
    promptError: agentPromptSnapshot.error,
    memoryContext: {
      workLogPath,
      stateDir,
      upstreamArtifactPath: upstreamArtifact?.uri ?? null
    }
  });
  const providerDirectPrompt = [
    isMediaProviderDirectStage ? "" : formatAgentPromptSnapshot(agentPromptSnapshot),
    isMediaProviderDirectStage ? "" : preflightInstructions,
    `User task: ${truncateForPrompt(job.rawPrompt, 4000)}`,
    `Stage type: ${stage.stageType}`,
    `Stage name: ${stage.name}`,
    upstreamPromptContext ? `Upstream artifact context:\n${upstreamPromptContext}` : "",
    stage.stageType === "image"
      ? "Generate the requested image/poster directly. Use the user task as the visual brief."
      : "",
    stage.stageType === "video"
      ? "Create the requested video generation task directly. Use the user task as the creative brief."
      : ""
  ].filter(Boolean).join("\n\n");
  const agentPrompt = [
    formatAgentPromptSnapshot(agentPromptSnapshot),
    "",
    preflightInstructions,
    "",
    `User task: ${truncateForPrompt(job.rawPrompt, 4000)}`,
    upstreamPromptContext ? `Upstream artifact context:\n${upstreamPromptContext}` : "",
    `工作模式：${input.attemptNo === 1 ? "生产" : "修正"}`,
    `任务编号：${input.jobId}`,
    `阶段编号：${stage.stageIndex}`,
    `阶段类型：${stage.stageType}`,
    `阶段任务：${stage.name}`,
    `输出目录（Windows）：${stageDir}`,
    `输出目录（WSL）：${toWslPath(stageDir)}`,
    `工作日志路径（Windows）：${workLogPath}`,
    `工作日志路径（WSL）：${toWslPath(workLogPath)}`,
    `状态 JSON 目录（Windows）：${stateDir}`,
    `状态 JSON 目录（WSL）：${toWslPath(stateDir)}`,
    `上游产物路径：${upstreamArtifact?.uri ?? "无"}`,
    "",
    "请按你的 agent prompt 完成本阶段，只返回产物路径、工作日志路径、状态 JSON 路径。"
  ].join("\n");

  const openClawResult = await runOpenClawAgentIdempotent({
    jobId: input.jobId,
    stageId: stage.id,
    stageIndex: stage.stageIndex,
    attemptNo: input.attemptNo,
    actionType: "stage-agent",
    agentId: stage.agentId,
    sessionId: agentSessionId,
    message: agentPrompt,
    providerDirectMessage: providerDirectPrompt,
    outputDir: stageDir,
    timeoutSeconds: Number(process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS ?? 600)
  });

  const output = {
    task_id: input.jobId,
    stage_number: stage.stageIndex,
    agent_type: stageTypeToAgentType(stage.stageType),
    agent_name: stage.agentId,
    mode: input.attemptNo === 1 ? "production" : "correction",
    status: quality === "needs_fix" ? "needs_retry" : "completed",
    artifact_path: "",
    work_log_path: workLogPath,
    summary_path: workLogPath,
    upstream_artifact_paths: upstreamArtifact?.uri ? [upstreamArtifact.uri] : [],
    created_at: nowIso(),
    jobId: input.jobId,
    stageId: stage.id,
    stageName: stage.name,
    agentId: stage.agentId,
    attemptNo: input.attemptNo,
    routingMode,
    handoffTargetAgentId,
    quality,
    summary:
      openClawResult?.text ??
      (quality === "needs_fix"
        ? shouldAlwaysFail
          ? "Mock output keeps failing so the test agent can stop after three consecutive failures."
          : "Mock output intentionally omits the handoff note so the test agent can force a repair loop."
        : `Mock ${stage.agentId} completed ${stage.name}.`),
    handoff:
      quality === "needs_fix"
        ? null
        : {
            nextStageInput: `Output from ${stage.name}`,
            notes: `Use this artifact as input for the next stage.`
          },
    openclaw: openClawResult
      ? {
          mode: openClawResult.mode,
          sessionId: openClawResult.sessionId,
          artifacts: openClawResult.artifacts ?? []
        }
      : {
          mode: "mock",
          sessionId: agentSessionId,
          artifacts: []
        },
    acceptanceCriteria: stage.acceptanceCriteria
  };

  const stateJsonPath = path.join(
    stateDir,
    `stage-${stage.stageIndex.toString().padStart(3, "0")}-${stageTypeToAgentType(
      stage.stageType
    )}-output.json`
  );
  const outputMdPath = path.join(stageDir, `output-attempt-${input.attemptNo}.md`);
  const generatedArtifactLines = (openClawResult?.artifacts ?? []).flatMap((artifact, index) => [
    `Generated artifact ${index + 1}:`,
    artifact.filePath ? `- File: ${artifact.filePath}` : "",
    artifact.url ? `- URL: ${artifact.url}` : "",
    artifact.note ? `- Note: ${artifact.note}` : ""
  ]).filter(Boolean);
  output.artifact_path = outputMdPath;

  await writeFile(stateJsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await writeFile(
    outputMdPath,
    [
      `# ${stage.name}`,
      "",
      `Agent: ${stage.agentId}`,
      `Attempt: ${input.attemptNo}`,
      `Quality: ${quality}`,
      "",
      output.summary,
      "",
      ...generatedArtifactLines,
      ""
    ].join("\n"),
    "utf8"
  );
  await appendFile(
    workLogPath,
    [
      `## 阶段 ${stage.stageIndex} ${stage.agentId} 第 ${input.attemptNo} 次`,
      `- 时间：${output.created_at}`,
      `- 产物：${outputMdPath}`,
      `- 状态 JSON：${stateJsonPath}`,
      `- 摘要：${output.summary}`,
      ""
    ].join("\n"),
    "utf8"
  );

  const artifact = await createArtifact({
    id: `${stage.id}-ART-OUTPUT-${input.attemptNo.toString().padStart(2, "0")}`,
    jobId: input.jobId,
    stageId: stage.id,
    type: "stage_output",
    title: `${stage.name} output attempt ${input.attemptNo}`,
    content: JSON.stringify(output, null, 2),
    uri: stateJsonPath,
    metadata: {
      markdownPath: outputMdPath,
      workLogPath,
      stateJsonPath,
      agentSessionId,
      agentPromptPath: agentPromptSnapshot.path,
      agentPromptLoaded: Boolean(agentPromptSnapshot.contents),
      attemptNo: input.attemptNo,
      routingMode,
      handoffTargetAgentId,
      quality,
      generatedArtifacts: openClawResult?.artifacts ?? []
    }
  });

  await createArtifact({
    id: `${stage.id}-ART-SUMMARY-${input.attemptNo.toString().padStart(2, "0")}`,
    jobId: input.jobId,
    stageId: stage.id,
    type: "stage_summary",
    title: `${stage.name} work log attempt ${input.attemptNo}`,
    content: output.summary,
    uri: workLogPath,
    metadata: {
      stateJsonPath,
      attemptNo: input.attemptNo
    }
  });

  await completeStageAttempt({
    attemptId,
    stageId: stage.id,
    outputArtifactId: artifact.id,
    status: "completed"
  });

  await appendJobEvent(input.jobId, "stage.agent_completed", {
    stageId: stage.id,
    agentId: stage.agentId,
    attemptNo: input.attemptNo,
    routingMode,
    handoffTargetAgentId,
    outputMessageType,
    outputArtifactId: artifact.id
  });

  const groupMessage = await postGroupMessage({
    id: `${stage.id}-MSG-STAGE-OUTPUT-${input.attemptNo.toString().padStart(2, "0")}`,
    jobId: input.jobId,
    stageId: stage.id,
    senderAgentId: stage.agentId,
    mentionAgentId: handoffTargetAgentId,
    messageType: outputMessageType,
    artifactId: artifact.id,
    content: [
      handoffTargetAgentId
        ? `@${handoffTargetAgentId} stage output is ready: ${stage.name}`
        : `Stage output is ready for main-agent: ${stage.name}`,
      displayOnlyHandoffLine(handoffTargetAgentId, `mode=${routingMode}`),
      "",
      `Job: ${input.jobId}`,
      `Routing mode: ${routingMode}`,
      `Stage: ${stage.stageIndex} / ${stage.stageType}`,
      `Agent: ${stage.agentId}`,
      `Attempt: ${input.attemptNo}`,
      `Output artifact: ${artifact.id}`,
      `Output path: ${stateJsonPath}`,
      `Work log: ${workLogPath}`,
      "",
      `Summary: ${output.summary}`
    ].join("\n")
  });

  return {
    attemptId,
    agentSessionId,
    outputArtifactId: artifact.id,
    outputPath: stateJsonPath,
    groupMessageId: groupMessage.id,
    summary: output.summary
  };
}

export async function runTestAgent(input: {
  jobId: string;
  stageId: string;
  attemptId: string;
  attemptNo: number;
  outputArtifactId: string;
}): Promise<TestReviewResult> {
  const [job, stage, outputArtifact] = await Promise.all([
    getJob(input.jobId),
    getStage(input.stageId),
    getArtifact(input.outputArtifactId)
  ]);
  if (!job) {
    throw new Error(`Job not found: ${input.jobId}`);
  }

  await setJobStatus(input.jobId, "testing", {
    source: "stage.test_started",
    stageId: input.stageId,
    attemptNo: input.attemptNo
  });

  const parsed = outputArtifact.content ? JSON.parse(outputArtifact.content) : {};
  const testAgentId = "test-agent";
  const testAgentSessionId =
    stage.originalTestSessionId ??
    `${job.sessionId}:${testAgentId}:stage-${stage.stageIndex.toString().padStart(3, "0")}`;

  const workdir = job.workdir ?? path.resolve(process.env.JOB_DATA_DIR ?? "data/jobs", input.jobId);
  const stageDir = path.join(
    workdir,
    "stages",
    `${stage.stageIndex.toString().padStart(3, "0")}-${stage.stageType}`
  );
  const stateDir = path.join(workdir, "state");
  const workLogPath = String(parsed.work_log_path ?? path.join(workdir, "agent-work-log.md"));
  await mkdir(stageDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const testPrompt = [
    `测试类型：${stageTypeToAgentType(stage.stageType)}`,
    `任务编号：${input.jobId}`,
    `阶段编号：${stage.stageIndex}`,
    `待测产物路径：${outputArtifact.uri ?? "无"}`,
    `工作日志路径：${workLogPath}`,
    `输出目录（Windows）：${stageDir}`,
    `输出目录（WSL）：${toWslPath(stageDir)}`,
    "",
    "请按 test-agent prompt 审查并只返回测试结果、报告路径、状态JSON路径。"
  ].join("\n");

  const openClawTestResult = await runOpenClawAgentIdempotent({
    jobId: input.jobId,
    stageId: stage.id,
    stageIndex: stage.stageIndex,
    attemptNo: input.attemptNo,
    actionType: "test-agent",
    agentId: testAgentId,
    sessionId: testAgentSessionId,
    message: testPrompt,
    timeoutSeconds: Number(process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS ?? 600)
  });

  const parsedRealVerdict = openClawTestResult?.text.match(/(?:测试结果|判定)[：:]\s*(PASS|FAIL)/i);
  const realIssueCount = openClawTestResult?.text.match(/问题数[：:]\s*(\d+)/);
  const verdict =
    parsedRealVerdict?.[1]?.toUpperCase() === "PASS"
      ? "PASS"
      : parsedRealVerdict?.[1]?.toUpperCase() === "FAIL"
        ? "FAIL_RETRYABLE"
        : parsed.quality === "needs_fix" || !parsed.handoff
          ? "FAIL_RETRYABLE"
          : "PASS";
  const issueCount =
    verdict === "PASS" ? 0 : realIssueCount?.[1] ? Number(realIssueCount[1]) : 1;
  const requiredFixes =
    verdict === "PASS"
      ? []
      : openClawTestResult
        ? ["test-agent 判定未通过，请查看测试报告和返回文本。"]
        : ["Add a valid handoff object so the next stage can consume this output."];

  const reportPath = path.join(stageDir, `test-report-attempt-${input.attemptNo}.md`);
  const stateJsonPath = path.join(
    stateDir,
    `stage-${stage.stageIndex.toString().padStart(3, "0")}-${stageTypeToAgentType(
      stage.stageType
    )}-test.json`
  );
  const nextAction =
    verdict === "PASS"
      ? "continue_to_next_stage"
      : input.attemptNo >= stage.maxRetries
        ? "wait_for_human_decision"
        : "retry_previous_agent";
  const reportLines = [
    `### 判定：${verdict === "PASS" ? "PASS" : "FAIL"}`,
    `报告路径：${reportPath}`,
    `问题数：${issueCount}`,
    "",
    `Stage: ${stage.name}`,
    `Attempt: ${input.attemptNo}`,
    `Output artifact: ${input.outputArtifactId}`,
    `State JSON: ${stateJsonPath}`,
    "",
    verdict === "PASS"
      ? "All acceptance criteria are sufficiently satisfied for the mock pipeline."
      : [
          `Required fixes:\n${requiredFixes.map((fix) => `- ${fix}`).join("\n")}`,
          openClawTestResult ? `\nRaw test-agent output:\n${openClawTestResult.text}` : ""
        ].join("\n"),
    ""
  ];

  await writeFile(reportPath, reportLines.join("\n"), "utf8");
  const stateJson = {
    task_id: input.jobId,
    stage_number: stage.stageIndex,
    test_type: stageTypeToAgentType(stage.stageType),
    verdict: verdict === "PASS" ? "PASS" : "FAIL",
    issue_count: issueCount,
    retry_round: input.attemptNo,
    report_path: reportPath,
    tested_artifact_path: outputArtifact.uri,
    tested_summary_path: workLogPath,
    next_action: nextAction,
    created_at: nowIso()
  };
  await writeFile(stateJsonPath, `${JSON.stringify(stateJson, null, 2)}\n`, "utf8");

  const reportArtifact = await createArtifact({
    id: `${stage.id}-ART-TEST-${input.attemptNo.toString().padStart(2, "0")}`,
    jobId: input.jobId,
    stageId: stage.id,
    type: "test_report",
    title: `${stage.name} test report attempt ${input.attemptNo}`,
    content: reportLines.join("\n"),
    uri: reportPath,
    metadata: {
      verdict,
      issueCount,
      requiredFixes,
      testAgentSessionId,
      stateJsonPath,
      nextAction
    }
  });

  await createArtifact({
    id: `${stage.id}-ART-TEST-STATE-${input.attemptNo.toString().padStart(2, "0")}`,
    jobId: input.jobId,
    stageId: stage.id,
    type: "state_json",
    title: `${stage.name} test state attempt ${input.attemptNo}`,
    content: JSON.stringify(stateJson, null, 2),
    uri: stateJsonPath,
    metadata: {
      reportArtifactId: reportArtifact.id
    }
  });

  const reviewId = await saveTestReview({
    stageId: stage.id,
    attemptId: input.attemptId,
    attemptNo: input.attemptNo,
    testAgentId,
    testAgentSessionId,
    verdict,
    issueCount,
    reportArtifactId: reportArtifact.id,
    requiredFixes
  });

  await appendJobEvent(input.jobId, "stage.test_completed", {
    stageId: stage.id,
    attemptNo: input.attemptNo,
    verdict,
    issueCount,
    reportArtifactId: reportArtifact.id
  });

  const groupMessage =
    verdict === "PASS"
      ? null
      : await postGroupMessage({
          id: `${stage.id}-MSG-TEST-RESULT-${input.attemptNo.toString().padStart(2, "0")}`,
          jobId: input.jobId,
          stageId: stage.id,
          senderAgentId: testAgentId,
          mentionAgentId: stage.agentId,
          messageType: "test_fail_to_previous_agent",
          artifactId: reportArtifact.id,
          content: [
            `@${stage.agentId} 测试未通过，请根据报告重新跑本阶段。`,
            displayOnlyHandoffLine(stage.agentId, "返修"),
            "",
            `Job：${input.jobId}`,
            `阶段：${stage.stageIndex} / ${stage.stageType}`,
            `连续失败次数：${input.attemptNo}`,
            `报告 artifact：${reportArtifact.id}`,
            `报告路径：${reportPath}`,
            `状态 JSON：${stateJsonPath}`,
            "",
            ...requiredFixes.map((fix) => `- ${fix}`)
          ].join("\n")
        });

  return {
    reviewId,
    testAgentSessionId,
    verdict,
    issueCount,
    reportArtifactId: reportArtifact.id,
    reportPath,
    groupMessageId: groupMessage?.id ?? ""
  };
}

export async function runFinalTestAgent(input: {
  jobId: string;
  sourceArtifactId: string;
  routingMode: RoutingMode;
}): Promise<FinalQualityGateResult> {
  const [job, sourceArtifact] = await Promise.all([
    getJob(input.jobId),
    getArtifact(input.sourceArtifactId)
  ]);
  if (!job) {
    throw new Error(`Job not found: ${input.jobId}`);
  }

  await setJobStatus(input.jobId, "testing", {
    source: "final.test_started",
    sourceArtifactId: input.sourceArtifactId,
    routingMode: input.routingMode
  });

  const workdir = job.workdir ?? path.resolve(process.env.JOB_DATA_DIR ?? "data/jobs", input.jobId);
  const finalDir = path.join(workdir, "final");
  const stateDir = path.join(workdir, "state");
  await mkdir(finalDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const testAgentId = "test-agent";
  const testAgentSessionId = `${job.sessionId}:${testAgentId}:final-${input.routingMode}`;
  const finalTestPrompt = [
    "Final quality gate.",
    `Job: ${input.jobId}`,
    `Routing mode: ${input.routingMode}`,
    `Source artifact: ${input.sourceArtifactId}`,
    `Source artifact path: ${sourceArtifact.uri ?? "none"}`,
    "",
    "Review the final candidate for correctness, completeness, safety, and usefulness.",
    "Return PASS if it is acceptable. Return FAIL with required fixes if it should not be delivered.",
    "",
    "Source artifact content:",
    compactMultiline(sourceArtifact.content ?? "", 6000)
  ].join("\n");

  const openClawTestResult = await runOpenClawAgentIdempotent({
    jobId: input.jobId,
    stageId: null,
    stageIndex: 0,
    attemptNo: 1,
    actionType: "final-test-agent",
    agentId: testAgentId,
    sessionId: testAgentSessionId,
    message: finalTestPrompt,
    timeoutSeconds: Number(process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS ?? 600)
  });

  const parsedRealVerdict = openClawTestResult?.text.match(/(?:final verdict|verdict|判定|测试结果)[:：]\s*(PASS|FAIL)/i);
  const shouldForceFinalFailure = /force final fail|final quality fail|终检失败/i.test(job.rawPrompt);
  const verdict =
    parsedRealVerdict?.[1]?.toUpperCase() === "PASS"
      ? "PASS"
      : parsedRealVerdict?.[1]?.toUpperCase() === "FAIL" || shouldForceFinalFailure
        ? "FAIL_RETRYABLE"
        : "PASS";
  const issueCount = verdict === "PASS" ? 0 : 1;
  const requiredFixes =
    verdict === "PASS"
      ? []
      : openClawTestResult
        ? ["Final test-agent rejected the candidate. Inspect the final test report."]
        : ["Final quality gate was forced to fail by the request prompt."];

  const reportPath = path.join(finalDir, "final-test-report.md");
  const stateJsonPath = path.join(stateDir, "final-test-state.json");
  const reportLines = [
    `# Final Quality Gate`,
    "",
    `Verdict: ${verdict === "PASS" ? "PASS" : "FAIL"}`,
    `Job: ${input.jobId}`,
    `Routing mode: ${input.routingMode}`,
    `Source artifact: ${input.sourceArtifactId}`,
    `Issue count: ${issueCount}`,
    "",
    verdict === "PASS"
      ? "The final candidate passed the final quality gate."
      : [
          "Required fixes:",
          ...requiredFixes.map((fix) => `- ${fix}`),
          openClawTestResult ? `\nRaw test-agent output:\n${openClawTestResult.text}` : ""
        ].join("\n"),
    ""
  ];
  const stateJson = {
    task_id: input.jobId,
    routing_mode: input.routingMode,
    verdict: verdict === "PASS" ? "PASS" : "FAIL",
    issue_count: issueCount,
    source_artifact_id: input.sourceArtifactId,
    report_path: reportPath,
    next_action: verdict === "PASS" ? "finalize_job" : "wait_for_human_decision",
    created_at: nowIso()
  };

  await writeFile(reportPath, reportLines.join("\n"), "utf8");
  await writeFile(stateJsonPath, `${JSON.stringify(stateJson, null, 2)}\n`, "utf8");

  const reportArtifact = await createArtifact({
    id: `${input.jobId}-ART-FINAL-TEST-01`,
    jobId: input.jobId,
    type: "test_report",
    title: "Final quality gate report",
    content: reportLines.join("\n"),
    uri: reportPath,
    metadata: {
      routingMode: input.routingMode,
      verdict,
      issueCount,
      requiredFixes,
      sourceArtifactId: input.sourceArtifactId,
      testAgentSessionId,
      stateJsonPath
    }
  });

  await createArtifact({
    id: `${input.jobId}-ART-FINAL-TEST-STATE-01`,
    jobId: input.jobId,
    type: "state_json",
    title: "Final quality gate state",
    content: JSON.stringify(stateJson, null, 2),
    uri: stateJsonPath,
    metadata: {
      reportArtifactId: reportArtifact.id
    }
  });

  await appendJobEvent(
    input.jobId,
    "final.test_completed",
    {
      routingMode: input.routingMode,
      sourceArtifactId: input.sourceArtifactId,
      verdict,
      issueCount,
      reportArtifactId: reportArtifact.id
    },
    {
      actor: testAgentId,
      artifactId: reportArtifact.id
    }
  );

  const groupMessage = await postGroupMessage({
    id: `${input.jobId}-MSG-FINAL-TEST-01`,
    jobId: input.jobId,
    senderAgentId: testAgentId,
    mentionAgentId: "main-agent",
    messageType: verdict === "PASS" ? "final_test_pass" : "final_test_failed_waiting_for_user",
    artifactId: reportArtifact.id,
    content: [
      `@main-agent final quality gate ${verdict === "PASS" ? "passed" : "failed"}`,
      displayOnlyHandoffLine("main-agent", `mode=${input.routingMode}`),
      "",
      `Job: ${input.jobId}`,
      `Routing mode: ${input.routingMode}`,
      `Source artifact: ${input.sourceArtifactId}`,
      `Report artifact: ${reportArtifact.id}`,
      `Report path: ${reportPath}`,
      `Issue count: ${issueCount}`,
      "",
      ...requiredFixes.map((fix) => `- ${fix}`)
    ].join("\n")
  });

  return {
    reviewId: `${input.jobId}-FINAL-REVIEW-01`,
    testAgentSessionId,
    verdict,
    issueCount,
    reportArtifactId: reportArtifact.id,
    reportPath,
    groupMessageId: groupMessage.id
  };
}

export async function passStageAndHandoff(input: {
  jobId: string;
  stageId: string;
  outputArtifactId: string;
  reportArtifactId: string;
}) {
  await markStageCompleted(input.stageId);
  await setNextStageInput(input.stageId, input.outputArtifactId);
  const [stage, nextStage] = await Promise.all([getStage(input.stageId), getNextStage(input.stageId)]);
  const mentionAgentId = nextStage?.agentId ?? "main-agent";
  const messageType = nextStage ? "test_pass_to_next_agent" : "final_output";

  await postGroupMessage({
    id: `${input.stageId}-MSG-HANDOFF-PASS`,
    jobId: input.jobId,
    stageId: input.stageId,
    senderAgentId: "test-agent",
    mentionAgentId,
    messageType,
    artifactId: input.outputArtifactId,
    content: nextStage
      ? [
          `@${nextStage.agentId} 上一阶段测试通过，请继续下一步。`,
          displayOnlyHandoffLine(nextStage.agentId, "进入下一阶段"),
          "",
          `Job：${input.jobId}`,
          `上一阶段：${stage.stageIndex} / ${stage.name}`,
          `下一阶段：${nextStage.stageIndex} / ${nextStage.name}`,
          `输入 artifact：${input.outputArtifactId}`,
          `测试报告 artifact：${input.reportArtifactId}`
        ].join("\n")
      : [
          "@main-agent 最后阶段测试通过，请汇总最终结果。",
          displayOnlyHandoffLine("main-agent", "最终汇总"),
          "",
          `Job：${input.jobId}`,
          `最终输入 artifact：${input.outputArtifactId}`,
          `测试报告 artifact：${input.reportArtifactId}`
        ].join("\n")
  });

  await appendJobEvent(input.jobId, "stage.completed", {
    stageId: input.stageId,
    outputArtifactId: input.outputArtifactId
  });
}

export async function completeStageWithoutReview(input: {
  jobId: string;
  stageId: string;
  outputArtifactId: string;
  routingMode: RoutingMode;
  linkNextStage?: boolean;
  roundNo?: number;
}) {
  await markStageCompleted(input.stageId);
  if (input.linkNextStage) {
    await setNextStageInput(input.stageId, input.outputArtifactId);
  }

  await appendJobEvent(input.jobId, "stage.completed_without_review", {
    stageId: input.stageId,
    outputArtifactId: input.outputArtifactId,
    routingMode: input.routingMode,
    linkNextStage: input.linkNextStage ?? false,
    roundNo: input.roundNo ?? null
  });
}

export async function recordDiscussionRound(input: {
  jobId: string;
  roundNo: number;
  stageIds: string[];
}) {
  await appendJobEvent(input.jobId, "discussion.round_completed", {
    roundNo: input.roundNo,
    stageIds: input.stageIds
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactMultiline(value: string, maxLength = 2000) {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength)}...` : compacted;
}

function parseArtifactSummary(artifact: ArtifactRecord | null): string {
  if (!artifact?.content) {
    return "";
  }

  try {
    const parsed = JSON.parse(artifact.content) as Record<string, unknown>;
    const summary = asString(parsed.summary);
    if (summary) {
      return summary;
    }
  } catch {
    // Fall back to plain text below.
  }

  return compactMultiline(artifact.content);
}

function parseArtifactJson(artifact: ArtifactRecord | null): Record<string, unknown> | null {
  if (!artifact?.content) {
    return null;
  }

  try {
    const parsed = JSON.parse(artifact.content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractGeneratedArtifactRefs(parsed: Record<string, unknown> | null) {
  const openclaw = parsed?.openclaw;
  const openclawArtifacts =
    openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
      ? (openclaw as Record<string, unknown>).artifacts
      : null;
  const generatedArtifacts = parsed?.generatedArtifacts;
  const artifactInputs = [
    ...(Array.isArray(openclawArtifacts) ? openclawArtifacts : []),
    ...(Array.isArray(generatedArtifacts) ? generatedArtifacts : [])
  ];
  const refs = new Set<string>();

  for (const artifact of artifactInputs) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      continue;
    }
    const item = artifact as Record<string, unknown>;
    const ref = asString(item.filePath) ?? asString(item.url);
    if (ref) {
      refs.add(ref);
    }
  }

  return [...refs];
}

async function getArtifactOrNull(artifactId: string | null) {
  if (!artifactId) {
    return null;
  }

  try {
    return await getArtifact(artifactId);
  } catch {
    return null;
  }
}

async function getDiscussionOutputRows(events: AgentEventRecord[]) {
  const completedEvents = events.filter(
    (event) =>
      event.eventType === "stage.agent_completed" &&
      event.payload?.routingMode === "master_slave_discussion"
  );

  const rows = [];
  for (const event of completedEvents) {
    const artifactId = asString(event.payload?.outputArtifactId);
    const artifact = await getArtifactOrNull(artifactId);
    rows.push({
      seq: event.seq,
      stageId: event.stageId,
      agentId: asString(event.payload?.agentId) ?? event.actor,
      attemptNo: asNumber(event.payload?.attemptNo),
      artifactId,
      summary: parseArtifactSummary(artifact)
    });
  }

  return rows;
}

export async function mainAgentSynthesizeDiscussion(jobId: string) {
  const job = await getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const [stages, events] = await Promise.all([getStagesForJob(jobId), getAgentEventsForJob(jobId)]);
  const discussionRows = await getDiscussionOutputRows(events);
  const roundEvents = events.filter((event) => event.eventType === "discussion.round_completed");
  const workdir = job.workdir ?? path.resolve(process.env.JOB_DATA_DIR ?? "data/jobs", jobId);
  const finalDir = path.join(workdir, "final");
  await mkdir(finalDir, { recursive: true });

  const discussionThread = discussionRows.map((row) =>
    [
      `Seq: ${row.seq}`,
      `Round: ${row.attemptNo ?? "unknown"}`,
      `Agent: ${row.agentId}`,
      `Stage: ${row.stageId ?? "unknown"}`,
      `Artifact: ${row.artifactId ?? "missing"}`,
      `Summary: ${row.summary || "No summary recorded."}`
    ].join("\n")
  );
  const prompt = [
    "You are main-agent. Synthesize the completed master_slave_discussion thread into the final answer.",
    "Use the agent event ledger as the source of truth. Preserve useful disagreements, final consensus, risks, and next steps.",
    "",
    `Job: ${jobId}`,
    `Original user request: ${job.rawPrompt}`,
    `Stages: ${stages.map((stage) => `${stage.stageIndex}:${stage.agentId}`).join(", ")}`,
    `Completed discussion rounds: ${roundEvents.length}`,
    "",
    "Discussion thread:",
    discussionThread.join("\n\n---\n\n")
  ].join("\n");

  const sessionId = `${job.sessionId}:main-agent:discussion-synthesis`;
  const openClawResult = await runOpenClawAgentIdempotent({
    jobId,
    stageId: null,
    stageIndex: 0,
    attemptNo: 1,
    actionType: "main-agent-synthesis",
    agentId: "main-agent",
    sessionId,
    message: prompt,
    timeoutSeconds: Number(process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS ?? 600)
  });

  const synthesisBody =
    openClawResult?.text ??
    [
      `# ${jobId} Discussion Synthesis`,
      "",
      "main-agent synthesized the master_slave_discussion ledger.",
      "",
      `Rounds completed: ${roundEvents.length}`,
      `Stage outputs synthesized: ${discussionRows.length}`,
      "",
      "Discussion ledger summary:",
      ...discussionRows.map(
        (row) =>
          `- round ${row.attemptNo ?? "?"} ${row.agentId} (${row.artifactId ?? "no artifact"}): ${
            row.summary || "No summary recorded."
          }`
      )
    ].join("\n");
  const synthesisPath = path.join(finalDir, "discussion-synthesis.md");

  await writeFile(synthesisPath, synthesisBody, "utf8");
  const artifact = await createArtifact({
    id: `${jobId}-ART-DISCUSSION-SYNTHESIS`,
    jobId,
    type: "discussion_synthesis",
    title: "main-agent discussion synthesis",
    content: synthesisBody,
    uri: synthesisPath,
    metadata: {
      routingMode: "master_slave_discussion",
      roundCount: roundEvents.length,
      stageCount: stages.length,
      outputCount: discussionRows.length,
      sourceEventSeqs: discussionRows.map((row) => row.seq),
      agentSessionId: sessionId
    }
  });

  await appendJobEvent(
    jobId,
    "discussion.synthesized",
    {
      artifactId: artifact.id,
      synthesisPath,
      roundCount: roundEvents.length,
      outputCount: discussionRows.length
    },
    {
      actor: "main-agent",
      artifactId: artifact.id
    }
  );

  return {
    artifactId: artifact.id,
    synthesisPath,
    roundCount: roundEvents.length,
    outputCount: discussionRows.length
  };
}

export async function requestStageFix(input: {
  jobId: string;
  stageId: string;
  attemptNo: number;
  reportArtifactId: string;
}) {
  await setJobStatus(input.jobId, "fixing", {
    source: "stage.fix_requested",
    stageId: input.stageId,
    attemptNo: input.attemptNo,
    reportArtifactId: input.reportArtifactId
  });
  await markStageFixing(input.stageId);
  await appendJobEvent(input.jobId, "stage.fix_requested", {
    stageId: input.stageId,
    attemptNo: input.attemptNo,
    reportArtifactId: input.reportArtifactId
  });
}

export async function stopAfterConsecutiveFailures(input: {
  jobId: string;
  stageId: string;
  attemptNo: number;
  reportArtifactId: string;
}) {
  const stage = await getStage(input.stageId);
  await markStageWaitingForHuman(input.stageId);

  await postGroupMessage({
    id: `${input.stageId}-MSG-WAITING-FOR-USER`,
    jobId: input.jobId,
    stageId: input.stageId,
    senderAgentId: "test-agent",
    mentionAgentId: "main-agent",
    messageType: "test_failed_waiting_for_user",
    artifactId: input.reportArtifactId,
    content: [
      "@main-agent 连续 3 次测试未通过，测试停止，等待用户决策。",
      displayOnlyHandoffLine("main-agent", "等待人工决策"),
      "",
      `Job：${input.jobId}`,
      `阶段：${stage.stageIndex} / ${stage.name}`,
      `失败 Agent：${stage.agentId}`,
      `连续失败次数：${input.attemptNo}`,
      `最近测试报告 artifact：${input.reportArtifactId}`
    ].join("\n")
  });

  await markJobWaitingForHuman(input.jobId, `Stage ${stage.id} failed ${input.attemptNo} consecutive tests`);
}

type ExperienceCandidateInput = Parameters<typeof createExperienceCandidate>[0];

function stageStatusSucceeded(stage: StageRecord) {
  return stage.status === "completed" || stage.status === "test_passed";
}

function stageExperienceKind(stage: StageRecord) {
  return stageStatusSucceeded(stage) ? "success_pattern" : "failure_pattern";
}

function buildExperienceMetadata(input: {
  extractionVersion: string;
  memoryTier: "candidate" | "adopted";
  capacityBucket: string;
  decaySensitivity: "low" | "medium" | "high";
  requiresHumanReview?: boolean;
}) {
  return {
    extractionVersion: input.extractionVersion,
    requiresHumanReview: input.requiresHumanReview ?? true,
    memoryGovernance: {
      memoryTier: input.memoryTier,
      capacityBucket: input.capacityBucket,
      decaySensitivity: input.decaySensitivity,
      keepRawArtifactsOut: true,
      reviewPolicy: "adopt_before_reuse",
      consolidationHint: "Keep only transferable lessons; merge or reject narrow duplicates."
    }
  };
}

async function createJobExperienceCandidates(input: {
  job: JobRecord;
  stages: StageRecord[];
  finalArtifactId: string;
}) {
  const routingMode = input.job.routingMode ?? DEFAULT_ROUTING_MODE;
  const baseEvidence = [
    {
      type: "job_succeeded",
      jobId: input.job.id,
      routingMode,
      finalArtifactId: input.finalArtifactId
    },
    {
      type: "completed_stages",
      stages: input.stages.map((stage) => ({
        stageId: stage.id,
        stageIndex: stage.stageIndex,
        stageType: stage.stageType,
        agentId: stage.agentId,
        status: stage.status,
        retryCount: stage.retryCount
      }))
    }
  ];
  const candidates: ExperienceCandidateInput[] = [
    {
      id: `${input.job.id}-EXP-ROUTING-OUTCOME`,
      sourceJobId: input.job.id,
      kind: "routing_outcome",
      scope: "routing_mode",
      scopeKey: routingMode,
      summary: `Routing mode ${routingMode} completed a job successfully. Review whether this routing choice should be reused for similar tasks.`,
      evidence: baseEvidence,
      confidence: 0.55,
      utilityScore: 0.4,
      decayScore: 0.05,
      metadata: buildExperienceMetadata({
        extractionVersion: "routing-outcome.v2",
        memoryTier: "candidate",
        capacityBucket: "routing",
        decaySensitivity: "medium"
      })
    }
  ];

  const stageCandidates = input.stages.slice(0, 12).map((stage) => {
    const succeeded = stageStatusSucceeded(stage);
    const kind = stageExperienceKind(stage);
    const statusLabel = succeeded ? "completed" : `ended with status ${stage.status}`;
    return {
      id: `${input.job.id}-EXP-${stage.id}`,
      sourceJobId: input.job.id,
      kind,
      scope: "agent",
      scopeKey: stage.agentId,
      summary: `${stage.agentId} ${statusLabel} ${stage.stageType} stage "${stage.name}". Review the work log and test result for a transferable ${succeeded ? "success pattern" : "failure pattern"}.`,
      evidence: [
        {
          type: succeeded ? "agent_stage_succeeded" : "agent_stage_needs_review",
          jobId: input.job.id,
          stageId: stage.id,
          stageIndex: stage.stageIndex,
          stageType: stage.stageType,
          agentId: stage.agentId,
          status: stage.status,
          retryCount: stage.retryCount,
          outputArtifactId: stage.outputArtifactId
        },
        ...baseEvidence
      ],
      confidence: succeeded ? 0.62 : 0.5,
      utilityScore: succeeded ? 0.45 : 0.55,
      decayScore: succeeded ? 0.06 : 0.03,
      metadata: buildExperienceMetadata({
        extractionVersion: "agent-stage-reflection.v1",
        memoryTier: "candidate",
        capacityBucket: `agent:${stage.agentId}`,
        decaySensitivity: succeeded ? "medium" : "low"
      })
    } satisfies ExperienceCandidateInput;
  });

  const taskTypeCandidates = input.stages.slice(0, 8).map((stage) => ({
    id: `${input.job.id}-EXP-TASKTYPE-${stage.stageIndex}`,
    sourceJobId: input.job.id,
    kind: "agent_lesson",
    scope: "task_type",
    scopeKey: stage.stageType,
    summary: `Task type "${stage.stageType}" was handled by ${stage.agentId} in routing mode ${routingMode}. Review for reusable planning, quality, or handoff lessons.`,
    evidence: [
      {
        type: "task_type_stage_observed",
        jobId: input.job.id,
        stageId: stage.id,
        stageType: stage.stageType,
        agentId: stage.agentId,
        status: stage.status,
        retryCount: stage.retryCount
      }
    ],
    confidence: 0.5,
    utilityScore: 0.35,
    decayScore: 0.08,
    metadata: buildExperienceMetadata({
      extractionVersion: "task-type-lesson.v1",
      memoryTier: "candidate",
      capacityBucket: `task_type:${stage.stageType}`,
      decaySensitivity: "high"
    })
  } satisfies ExperienceCandidateInput));

  const created: ExperienceRecord[] = [];
  for (const candidate of [...candidates, ...stageCandidates, ...taskTypeCandidates]) {
    created.push(await createExperienceCandidate(candidate));
  }
  return created;
}

export async function finalizeJob(jobId: string) {
  const job = await getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  await heartbeat(jobId, "finalize.started");

  const stages = await getStagesForJob(jobId);
  const stageSummaries = await Promise.all(
    stages.map(async (stage) => {
      const outputArtifact = await getArtifactOrNull(stage.outputArtifactId);
      const parsed = parseArtifactJson(outputArtifact);
      return {
        stage,
        summary: (asString(parsed?.summary) ?? parseArtifactSummary(outputArtifact)) || "No summary recorded.",
        artifactPath: asString(parsed?.artifact_path) ?? outputArtifact?.uri ?? null,
        generatedArtifacts: extractGeneratedArtifactRefs(parsed)
      };
    })
  );
  const workdir = job.workdir ?? path.resolve(process.env.JOB_DATA_DIR ?? "data/jobs", jobId);
  const finalPath = path.join(workdir, "final", "final-answer.md");
  const discussionSynthesis =
    job.routingMode === "master_slave_discussion"
      ? await getArtifactOrNull(`${jobId}-ART-DISCUSSION-SYNTHESIS`)
      : null;
  const executionMode = isOpenClawRealMode()
    ? `real provider-backed execution (${getOpenClawAgentRunner()})`
    : "mock execution";
  const stageLines = stageSummaries.flatMap(({ stage, summary, artifactPath, generatedArtifacts }) => [
    `- ${stage.stageIndex}. ${stage.name} (${stage.agentId})`,
    `  Status: ${stage.status}`,
    `  Summary: ${compactMultiline(summary, 500)}`,
    artifactPath ? `  Artifact: ${artifactPath}` : "",
    ...generatedArtifacts.map((artifact, index) => `  Generated artifact ${index + 1}: ${artifact}`)
  ]).filter(Boolean);
  const finalOutput = [
    `# ${jobId} Final Output`,
    "",
    `Pipeline completed successfully with ${executionMode}.`,
    "",
    `Routing mode: ${job.routingMode ?? DEFAULT_ROUTING_MODE}`,
    "",
    "Completed stages:",
    ...stageLines,
    "",
    discussionSynthesis
      ? ["Main-agent discussion synthesis:", "", discussionSynthesis.content ?? ""].join("\n")
      : "No dedicated discussion synthesis artifact was required for this routing mode.",
    "",
    "Final owner: main-agent summarized the completed stage outputs.",
    ""
  ].join("\n");

  await writeFile(finalPath, finalOutput, "utf8");
  const artifact = await createArtifact({
    id: `${jobId}-ART-FINAL`,
    jobId,
    type: "final_output",
    title: "Final answer",
    content: finalOutput,
    uri: finalPath
  });

  const finalized = await setJobFinalOutput(jobId, finalOutput);
  if (!finalized) {
    return {
      finalOutput: "",
      finalArtifactId: artifact.id,
      finalPath
    };
  }

  await postGroupMessage({
    id: `${jobId}-MSG-FINAL`,
    jobId,
    senderAgentId: "main-agent",
    mentionAgentId: null,
    messageType: "final_output",
    artifactId: artifact.id,
    content: [
      `任务完成：${jobId}`,
      displayOnlyHandoffLine(null),
      "",
      `Routing mode: ${job.routingMode ?? DEFAULT_ROUTING_MODE}`,
      "All configured stages completed and the final result has been generated.",
      `Final artifact: ${artifact.id}`,
      `Final path: ${finalPath}`,
      `最终 artifact：${artifact.id}`,
      `最终路径：${finalPath}`
    ]
      .filter(
        (line) =>
          !line.includes("{jobId}") &&
          !line.includes("{artifact.id}") &&
          !(line.includes(finalPath) && !line.startsWith("Final path:"))
      )
      .join("\n")
  });
  await appendJobEvent(jobId, "final.artifact_created", {
    artifactId: artifact.id,
    finalPath
  });

  const experiences = await createJobExperienceCandidates({
    job,
    stages,
    finalArtifactId: artifact.id
  });
  await appendJobEvent(
    jobId,
    "experience.candidates_created",
    {
      experienceIds: experiences.map((experience) => experience.id),
      count: experiences.length,
      kinds: [...new Set(experiences.map((experience) => experience.kind))]
    },
    {
      actor: "memory-agent",
      artifactId: artifact.id
    }
  );

  await archiveJobSession({
    jobId,
    retentionDays: Number(process.env.SESSION_RETENTION_DAYS ?? 30),
    reason: "job_completed"
  });

  return {
    finalOutput,
    finalArtifactId: artifact.id,
    finalPath
  };
}
