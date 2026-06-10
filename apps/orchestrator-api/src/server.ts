import "dotenv/config";
import express from "express";
import { z } from "zod";
import {
  archiveJobSession,
  appendJobEvent,
  cancelJob,
  createJob,
  getJob,
  getJobByFeishuMessageId,
  getJobBySessionId,
  InvalidJobListCursorError,
  listJobs,
  restoreJobSession
} from "../../../packages/db/src/jobs";
import { markModelCallFailedUnknownOutcome } from "../../../packages/db/src/model-calls";
import {
  listExperiences,
  setExperienceStatus
} from "../../../packages/db/src/experience";
import {
  getGroupMessagesForJob,
  getJobDetails,
  getJobTimeline,
  InvalidTimelineCursorError
} from "../../../packages/db/src/pipeline";
import {
  createPlanForJob,
  createPlanItem,
  getPlan,
  listPlans,
  updatePlan,
  updatePlanItem
} from "../../../packages/db/src/plans";
import {
  compressSession,
  getRuntimeUsage,
  getSessionEvents,
  listRuntimeLogs,
  listSessions
} from "../../../packages/db/src/runtime";
import {
  getWorkspaceGitStatus,
  inspectWorkspace,
  listWorkspaceFiles,
  readWorkspaceFile,
  WorkspacePathError
} from "./workspaces";
import {
  EXPERIENCE_STATUSES,
  INGRESS_ORIGINS,
  JOB_STATUSES,
  ROUTING_MODES,
  TASK_PLAN_ITEM_STATUSES,
  TASK_PLAN_STATUSES,
  type ExperienceStatus
} from "../../../packages/shared/src/types";
import { launchDbos, startJobWorkflow } from "./dbos-runtime";
import { ingressAdapters } from "./adapters";

const unstickModelCallSchema = z.object({
  jobId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  reason: z.string().optional(),
  restartWorkflow: z.boolean().optional().default(true)
});

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(2000).optional()
});

const runtimeLogsQuerySchema = z.object({
  source: z.enum(["job_event", "agent_event", "model_call"]).optional(),
  jobId: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(300).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

const runtimeUsageQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional()
});

const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  prompt: z.string().trim().min(1).max(300).optional()
});

const sessionEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional()
});

const archiveSessionSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).optional(),
  reason: z.string().max(500).optional(),
  requesterId: z.string().max(200).optional()
});

const restoreSessionSchema = z.object({
  reason: z.string().max(500).optional(),
  requesterId: z.string().max(200).optional()
});

const forkSessionSchema = z.object({
  prompt: z.string().min(1).optional(),
  inheritWorkdir: z.boolean().optional().default(true),
  startWorkflow: z.boolean().optional().default(true),
  routingMode: z.enum(ROUTING_MODES).optional(),
  maxModelCalls: z.number().int().min(1).max(100).optional(),
  classicFinalGateEnabled: z.boolean().optional(),
  discussionRounds: z.number().int().min(1).max(10).optional(),
  requesterId: z.string().max(200).optional()
});

const compressSessionSchema = z.object({
  maxEvents: z.number().int().min(10).max(300).optional(),
  reason: z.string().max(500).optional()
});

const listPlansQuerySchema = z.object({
  jobId: z.string().trim().min(1).max(200).optional(),
  status: z.enum(TASK_PLAN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const createJobPlanSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(2000).optional(),
  source: z.string().trim().min(1).max(80).optional(),
  sourceArtifactId: z.string().trim().min(1).max(240).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  syncItems: z.boolean().optional()
});

const updatePlanSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(TASK_PLAN_STATUSES).optional(),
  metadata: z.record(z.unknown()).optional()
});

const createPlanItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().max(4000).nullable().optional(),
  status: z.enum(TASK_PLAN_ITEM_STATUSES).optional(),
  agentId: z.string().trim().min(1).max(200).nullable().optional(),
  stageId: z.string().trim().min(1).max(240).nullable().optional(),
  artifactId: z.string().trim().min(1).max(240).nullable().optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  metadata: z.record(z.unknown()).optional()
});

const updatePlanItemSchema = createPlanItemSchema.partial().extend({
  title: z.string().trim().min(1).max(300).optional()
});

const workspaceRootQuerySchema = z.object({
  rootPath: z.string().trim().min(1).max(2000)
});

const workspaceFilesQuerySchema = workspaceRootQuerySchema.extend({
  subpath: z.string().trim().max(2000).optional(),
  depth: z.coerce.number().int().min(0).max(8).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
  includeHidden: z.coerce.boolean().optional()
});

const workspaceFileQuerySchema = workspaceRootQuerySchema.extend({
  subpath: z.string().trim().min(1).max(2000),
  maxBytes: z.coerce.number().int().min(1).max(1024 * 1024).optional()
});

const listJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  ingressOrigin: z.enum(INGRESS_ORIGINS).optional(),
  prompt: z.string().trim().min(1).max(300).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(["createdAt", "updatedAt"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().min(1).max(2000).optional()
});

const cancelJobSchema = z.object({
  reason: z.string().max(500).optional(),
  requesterId: z.string().max(200).optional()
});

const listExperiencesQuerySchema = z.object({
  status: z.enum(EXPERIENCE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const defaultCorsOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "tauri://localhost"
];

function getCorsOrigins() {
  return (process.env.ORCHESTRATOR_CORS_ORIGINS ?? defaultCorsOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requireAdminToken(request: express.Request, response: express.Response) {
  const expectedToken = process.env.ADMIN_API_TOKEN?.trim();
  if (!expectedToken) {
    response.status(403).json({ error: "admin_api_token_not_configured" });
    return false;
  }

  const actualToken = request.header("x-admin-token")?.trim();
  if (actualToken !== expectedToken) {
    response.status(401).json({ error: "invalid_admin_token" });
    return false;
  }

  return true;
}

async function respondWithExperienceStatus(
  request: express.Request,
  response: express.Response,
  status: Exclude<ExperienceStatus, "candidate">
) {
  const experienceId = Array.isArray(request.params.experienceId)
    ? request.params.experienceId[0] ?? ""
    : request.params.experienceId;
  const result = await setExperienceStatus(experienceId, status);
  if (!result.experience) {
    response.status(404).json({ error: "experience_not_found" });
    return;
  }

  if (result.changed) {
    await appendJobEvent(
      result.experience.sourceJobId,
      `experience.${status}`,
      {
        experienceId: result.experience.id,
        kind: result.experience.kind,
        scope: result.experience.scope,
        scopeKey: result.experience.scopeKey
      },
      {
        actor: "user"
      }
    );
  }

  response.json(result);
}

async function main() {
  const app = express();
  await launchDbos();
  const port = Number(process.env.ORCHESTRATOR_PORT ?? 3000);
  const corsOrigins = getCorsOrigins();

  app.use((request, response, next) => {
    const origin = request.header("origin");
    if (origin && corsOrigins.includes(origin)) {
      response.header("access-control-allow-origin", origin);
      response.header("vary", "Origin");
      response.header("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
      response.header("access-control-allow-headers", "content-type,x-admin-token");
    }

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }

    next();
  });

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  for (const adapter of ingressAdapters) {
    if (adapter.isEnabled(process.env)) {
      adapter.mount(app, {
        createJob,
        getJobByFeishuMessageId,
        startJobWorkflow
      });
    }
  }

  app.post("/admin/model-calls/failed-unknown-outcome", async (request, response, next) => {
    try {
      if (!requireAdminToken(request, response)) {
        return;
      }

      const input = unstickModelCallSchema.parse(request.body);
      const job = await getJob(input.jobId);
      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      const modelCall = await markModelCallFailedUnknownOutcome({
        idempotencyKey: input.idempotencyKey,
        error: input.reason
          ? `failed_unknown_outcome: ${input.reason}`
          : "failed_unknown_outcome: manually marked by admin"
      });

      if (!modelCall) {
        response.status(404).json({ error: "started_model_call_not_found" });
        return;
      }

      await appendJobEvent(input.jobId, "tool.openclaw_agent_failed_unknown_outcome", {
        modelCallId: modelCall.id,
        idempotencyKey: modelCall.idempotencyKey,
        reason: input.reason ?? null
      }, {
        actor: "admin",
        stageId: modelCall.stageId
      });

      let workflowId: string | null = null;
      if (input.restartWorkflow) {
        const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
        workflowId = await startJobWorkflow(input.jobId, `job-${input.jobId}-unstick-${stamp}`);
      }

      response.json({
        ok: true,
        modelCallId: modelCall.id,
        status: modelCall.status,
        workflowId
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs", async (request, response, next) => {
    try {
      const query = listJobsQuerySchema.parse(request.query);
      const result = await listJobs(query);
      response.json(result);
    } catch (error) {
      if (error instanceof InvalidJobListCursorError) {
        response.status(400).json({ error: error.message });
        return;
      }

      next(error);
    }
  });

  app.get("/runtime/logs", async (request, response, next) => {
    try {
      const query = runtimeLogsQuerySchema.parse(request.query);
      response.json(await listRuntimeLogs(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/runtime/usage", async (request, response, next) => {
    try {
      const query = runtimeUsageQuerySchema.parse(request.query);
      response.json(await getRuntimeUsage(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspaces/inspect", async (request, response, next) => {
    try {
      const query = workspaceRootQuerySchema.parse(request.query);
      response.json(await inspectWorkspace(query.rootPath));
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspaces/files", async (request, response, next) => {
    try {
      const query = workspaceFilesQuerySchema.parse(request.query);
      response.json(
        await listWorkspaceFiles(query.rootPath, {
          subpath: query.subpath,
          depth: query.depth,
          limit: query.limit,
          includeHidden: query.includeHidden
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspaces/file", async (request, response, next) => {
    try {
      const query = workspaceFileQuerySchema.parse(request.query);
      response.json(
        await readWorkspaceFile(query.rootPath, {
          subpath: query.subpath,
          maxBytes: query.maxBytes
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/workspaces/git/status", async (request, response, next) => {
    try {
      const query = workspaceRootQuerySchema.parse(request.query);
      response.json(await getWorkspaceGitStatus(query.rootPath));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sessions", async (request, response, next) => {
    try {
      const query = listSessionsQuerySchema.parse(request.query);
      response.json(await listSessions(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sessions/:sessionId/events", async (request, response, next) => {
    try {
      const query = sessionEventsQuerySchema.parse(request.query);
      response.json(await getSessionEvents(request.params.sessionId, query));
    } catch (error) {
      next(error);
    }
  });

  app.post("/sessions/:sessionId/archive", async (request, response, next) => {
    try {
      const input = archiveSessionSchema.parse(request.body ?? {});
      const job = await getJobBySessionId(request.params.sessionId);
      if (!job) {
        response.status(404).json({ error: "session_not_found" });
        return;
      }
      const archived = await archiveJobSession({
        jobId: job.id,
        retentionDays: input.retentionDays,
        reason: input.reason ?? "session_archived"
      });
      response.json({
        ok: true,
        changed: !job.archivedAt,
        sessionId: request.params.sessionId,
        job: archived
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/sessions/:sessionId/restore", async (request, response, next) => {
    try {
      const input = restoreSessionSchema.parse(request.body ?? {});
      const job = await restoreJobSession({
        sessionId: request.params.sessionId,
        reason: input.reason ?? "session_restored",
        requesterId: input.requesterId
      });
      if (!job) {
        response.status(404).json({ error: "session_not_found" });
        return;
      }
      response.json({
        ok: true,
        sessionId: request.params.sessionId,
        job
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/sessions/:sessionId/fork", async (request, response, next) => {
    try {
      const input = forkSessionSchema.parse(request.body ?? {});
      const source = await getJobBySessionId(request.params.sessionId);
      if (!source) {
        response.status(404).json({ error: "session_not_found" });
        return;
      }
      const forked = await createJob({
        rawPrompt: input.prompt ?? source.rawPrompt,
        workdir: input.inheritWorkdir ? source.workdir ?? undefined : undefined,
        ingressOrigin: "http",
        routingMode: input.routingMode ?? source.routingMode,
        maxModelCalls: input.maxModelCalls ?? source.maxModelCalls,
        classicFinalGateEnabled: input.classicFinalGateEnabled ?? source.classicFinalGateEnabled,
        discussionRounds: input.discussionRounds ?? source.discussionRounds,
        requesterId: input.requesterId ?? "session-fork"
      });
      await appendJobEvent(forked.id, "session.forked", {
        sourceSessionId: source.sessionId,
        sourceJobId: source.id,
        inheritedWorkdir: input.inheritWorkdir
      }, {
        actor: "session-ledger"
      });
      const workflowId = input.startWorkflow ? await startJobWorkflow(forked.id) : null;
      response.status(201).json({
        ok: true,
        sourceSessionId: source.sessionId,
        sessionId: forked.sessionId,
        job: forked,
        workflowId
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/sessions/:sessionId/compress", async (request, response, next) => {
    try {
      const input = compressSessionSchema.parse(request.body ?? {});
      const result = await compressSession(request.params.sessionId, input);
      if (!result) {
        response.status(404).json({ error: "session_not_found" });
        return;
      }
      response.json({
        ok: true,
        ...result
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/plans", async (request, response, next) => {
    try {
      const query = listPlansQuerySchema.parse(request.query);
      response.json(await listPlans(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/plans/:planId", async (request, response, next) => {
    try {
      const plan = await getPlan(request.params.planId);
      if (!plan) {
        response.status(404).json({ error: "plan_not_found" });
        return;
      }
      response.json(plan);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/plans/:planId", async (request, response, next) => {
    try {
      const input = updatePlanSchema.parse(request.body ?? {});
      const plan = await updatePlan(request.params.planId, input);
      if (!plan) {
        response.status(404).json({ error: "plan_not_found" });
        return;
      }
      response.json(plan);
    } catch (error) {
      next(error);
    }
  });

  app.post("/plans/:planId/items", async (request, response, next) => {
    try {
      const input = createPlanItemSchema.parse(request.body ?? {});
      const item = await createPlanItem(request.params.planId, input);
      if (!item) {
        response.status(404).json({ error: "plan_not_found" });
        return;
      }
      response.status(201).json(item);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/plans/:planId/items/:itemId", async (request, response, next) => {
    try {
      const input = updatePlanItemSchema.parse(request.body ?? {});
      const item = await updatePlanItem(request.params.planId, request.params.itemId, input);
      if (!item) {
        response.status(404).json({ error: "plan_item_not_found" });
        return;
      }
      response.json(item);
    } catch (error) {
      next(error);
    }
  });

  app.get("/memory/experiences", async (request, response, next) => {
    try {
      const query = listExperiencesQuerySchema.parse(request.query);
      response.json(await listExperiences(query));
    } catch (error) {
      next(error);
    }
  });

  app.post("/memory/experiences/:experienceId/adopt", async (request, response, next) => {
    try {
      await respondWithExperienceStatus(request, response, "adopted");
    } catch (error) {
      next(error);
    }
  });

  app.post("/memory/experiences/:experienceId/reject", async (request, response, next) => {
    try {
      await respondWithExperienceStatus(request, response, "rejected");
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId", async (request, response, next) => {
    try {
      const job = await getJob(request.params.jobId);

      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      response.json(job);
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/messages", async (request, response, next) => {
    try {
      const job = await getJob(request.params.jobId);

      if (!job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      const messages = await getGroupMessagesForJob(request.params.jobId);
      response.json({
        jobId: job.id,
        ingressOrigin: job.ingressOrigin,
        messages
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/jobs/:jobId/cancel", async (request, response, next) => {
    try {
      const input = cancelJobSchema.parse(request.body ?? {});
      const result = await cancelJob({
        jobId: request.params.jobId,
        reason: input.reason,
        requesterId: input.requesterId
      });

      if (!result.job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      if (result.reason === "already_terminal") {
        response.status(409).json({
          error: "job_already_terminal",
          jobId: result.job.id,
          status: result.job.status
        });
        return;
      }

      response.json({
        ok: true,
        changed: result.changed,
        reason: result.reason,
        jobId: result.job.id,
        status: result.job.status
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/jobs/:jobId/plan", async (request, response, next) => {
    try {
      const input = createJobPlanSchema.parse(request.body ?? {});
      const plan = await createPlanForJob(request.params.jobId, input);
      if (!plan) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }
      response.status(201).json(plan);
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/details", async (request, response, next) => {
    try {
      const details = await getJobDetails(request.params.jobId);

      if (!details.job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      response.json(details);
    } catch (error) {
      next(error);
    }
  });

  app.get("/jobs/:jobId/timeline", async (request, response, next) => {
    try {
      const query = timelineQuerySchema.parse(request.query);
      const timeline = await getJobTimeline(request.params.jobId, {
        limit: query.limit,
        since: query.since,
        cursor: query.cursor
      });

      if (!timeline.job) {
        response.status(404).json({ error: "job_not_found" });
        return;
      }

      response.json(timeline);
    } catch (error) {
      if (error instanceof InvalidTimelineCursorError) {
        response.status(400).json({ error: error.message });
        return;
      }

      next(error);
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "invalid_request", issues: error.issues });
      return;
    }

    if (error instanceof WorkspacePathError) {
      response.status(400).json({ error: error.message });
      return;
    }

    console.error(error);
    response.status(500).json({ error: "internal_error" });
  });

  app.listen(port, () => {
    console.log(`Orchestrator API listening on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
