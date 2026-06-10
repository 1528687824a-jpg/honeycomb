import { randomUUID } from "node:crypto";
import {
  TASK_PLAN_ITEM_STATUSES,
  TASK_PLAN_STATUSES,
  type StageStatus,
  type TaskPlanItemRecord,
  type TaskPlanItemStatus,
  type TaskPlanRecord,
  type TaskPlanStatus,
  type TaskPlanWithItems
} from "../../shared/src/types";
import { appendJobEvent, getJob } from "./jobs";
import { getStagesForJob } from "./pipeline";
import { pool } from "./pool";

type PlanListSummary = TaskPlanRecord & {
  itemCount: number;
  completedItemCount: number;
  inProgressItemCount: number;
  blockedItemCount: number;
};

function normalizePlanStatus(value: unknown): TaskPlanStatus {
  return typeof value === "string" && (TASK_PLAN_STATUSES as readonly string[]).includes(value)
    ? (value as TaskPlanStatus)
    : "active";
}

function normalizePlanItemStatus(value: unknown): TaskPlanItemStatus {
  return typeof value === "string" && (TASK_PLAN_ITEM_STATUSES as readonly string[]).includes(value)
    ? (value as TaskPlanItemStatus)
    : "pending";
}

function normalizeAcceptanceCriteria(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function toTaskPlanRecord(row: any): TaskPlanRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    title: row.title,
    summary: row.summary,
    status: normalizePlanStatus(row.status),
    source: row.source,
    sourceArtifactId: row.source_artifact_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function toTaskPlanItemRecord(row: any): TaskPlanItemRecord {
  return {
    id: row.id,
    planId: row.plan_id,
    position: row.position,
    title: row.title,
    body: row.body,
    status: normalizePlanItemStatus(row.status),
    agentId: row.agent_id,
    stageId: row.stage_id,
    artifactId: row.artifact_id,
    acceptanceCriteria: normalizeAcceptanceCriteria(row.acceptance_criteria),
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null
  };
}

function toPlanListSummary(row: any): PlanListSummary {
  return {
    ...toTaskPlanRecord(row),
    itemCount: Number(row.item_count ?? 0),
    completedItemCount: Number(row.completed_item_count ?? 0),
    inProgressItemCount: Number(row.in_progress_item_count ?? 0),
    blockedItemCount: Number(row.blocked_item_count ?? 0)
  };
}

function planTitleFromPrompt(rawPrompt: string) {
  const compact = rawPrompt.replace(/\s+/g, " ").trim();
  return compact ? `任务计划：${compact.slice(0, 48)}` : "任务计划";
}

function mapStageStatusToPlanItemStatus(status: StageStatus): TaskPlanItemStatus {
  switch (status) {
    case "completed":
    case "test_passed":
      return "completed";
    case "running":
    case "test_pending":
    case "test_failed":
    case "fixing":
      return "in_progress";
    case "waiting_for_human":
    case "failed":
      return "blocked";
    case "skipped":
      return "cancelled";
    case "pending":
    default:
      return "pending";
  }
}

async function getLatestPipelinePlanArtifactId(jobId: string): Promise<string | null> {
  const result = await pool.query(
    `select id
     from agent.artifacts
     where job_id = $1 and type = 'pipeline_plan'
     order by created_at desc
     limit 1`,
    [jobId]
  );

  return result.rows[0]?.id ?? null;
}

async function upsertPlanItem(input: {
  planId: string;
  position: number;
  title: string;
  body?: string | null;
  status: TaskPlanItemStatus;
  agentId?: string | null;
  stageId?: string | null;
  artifactId?: string | null;
  acceptanceCriteria?: string[];
  metadata?: Record<string, unknown>;
}): Promise<TaskPlanItemRecord> {
  const id = `${input.planId}-ITEM-${input.position.toString().padStart(3, "0")}`;
  const result = await pool.query(
    `insert into agent.task_plan_items (
      id,
      plan_id,
      position,
      title,
      body,
      status,
      agent_id,
      stage_id,
      artifact_id,
      acceptance_criteria,
      metadata,
      completed_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, case when $6 = 'completed' then now() else null end)
    on conflict (plan_id, position) do update
      set title = excluded.title,
          body = excluded.body,
          status = excluded.status,
          agent_id = excluded.agent_id,
          stage_id = excluded.stage_id,
          artifact_id = excluded.artifact_id,
          acceptance_criteria = excluded.acceptance_criteria,
          metadata = agent.task_plan_items.metadata || excluded.metadata,
          completed_at = case
            when excluded.status = 'completed' then coalesce(agent.task_plan_items.completed_at, now())
            else null
          end,
          updated_at = now()
    returning *`,
    [
      id,
      input.planId,
      input.position,
      input.title,
      input.body ?? null,
      input.status,
      input.agentId ?? null,
      input.stageId ?? null,
      input.artifactId ?? null,
      JSON.stringify(input.acceptanceCriteria ?? []),
      JSON.stringify(input.metadata ?? {})
    ]
  );

  return toTaskPlanItemRecord(result.rows[0]);
}

export async function createPlanForJob(
  jobId: string,
  input: {
    title?: string;
    summary?: string;
    source?: string;
    sourceArtifactId?: string | null;
    metadata?: Record<string, unknown>;
    syncItems?: boolean;
  } = {}
): Promise<TaskPlanWithItems | null> {
  const job = await getJob(jobId);
  if (!job) {
    return null;
  }

  const planId = `PLAN-${job.id}`;
  const sourceArtifactId =
    input.sourceArtifactId === undefined ? await getLatestPipelinePlanArtifactId(job.id) : input.sourceArtifactId;
  const title = input.title?.trim() || planTitleFromPrompt(job.rawPrompt);
  const summary =
    input.summary?.trim() ||
    `根据任务 ${job.id} 的编排结果生成的可跟踪计划，后续可同步到右侧 Todo 面板。`;
  const metadata = {
    routingMode: job.routingMode,
    sessionId: job.sessionId,
    createdFrom: "job",
    ...(input.metadata ?? {})
  };

  const planResult = await pool.query(
    `insert into agent.task_plans (
      id,
      job_id,
      title,
      summary,
      status,
      source,
      source_artifact_id,
      metadata
    ) values ($1, $2, $3, $4, 'active', $5, $6, $7::jsonb)
    on conflict (id) do update
      set title = excluded.title,
          summary = excluded.summary,
          source = excluded.source,
          source_artifact_id = excluded.source_artifact_id,
          metadata = agent.task_plans.metadata || excluded.metadata,
          updated_at = now()
    returning *`,
    [
      planId,
      job.id,
      title,
      summary,
      input.source ?? "pipeline",
      sourceArtifactId,
      JSON.stringify(metadata)
    ]
  );

  if (input.syncItems !== false) {
    const stages = await getStagesForJob(job.id);
    if (stages.length > 0) {
      for (const stage of stages) {
        await upsertPlanItem({
          planId,
          position: stage.stageIndex,
          title: stage.name,
          body: `由 ${stage.agentId} 负责，阶段类型：${stage.stageType}`,
          status: mapStageStatusToPlanItemStatus(stage.status),
          agentId: stage.agentId,
          stageId: stage.id,
          artifactId: stage.outputArtifactId,
          acceptanceCriteria: stage.acceptanceCriteria,
          metadata: {
            stageType: stage.stageType,
            retryCount: stage.retryCount,
            maxRetries: stage.maxRetries
          }
        });
      }
    } else {
      await upsertPlanItem({
        planId,
        position: 1,
        title: "澄清任务并生成编排计划",
        body: job.rawPrompt,
        status: job.status === "created" ? "pending" : "in_progress",
        acceptanceCriteria: ["明确任务目标", "确认需要参与的 agent", "生成后续可执行步骤"],
        metadata: {
          fallback: true
        }
      });
    }
  }

  await appendJobEvent(
    job.id,
    "plan.upserted",
    {
      planId,
      source: input.source ?? "pipeline",
      sourceArtifactId
    },
    {
      actor: "plan-ledger"
    }
  );

  const plan = toTaskPlanRecord(planResult.rows[0]);
  const items = await listPlanItems(plan.id);
  return { plan, items };
}

export async function listPlans(input: {
  jobId?: string;
  status?: TaskPlanStatus;
  limit?: number;
} = {}): Promise<{
  plans: PlanListSummary[];
  filters: {
    jobId: string | null;
    status: TaskPlanStatus | null;
    limit: number;
  };
}> {
  const values: unknown[] = [];
  const where: string[] = [];
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);

  if (input.jobId) {
    values.push(input.jobId);
    where.push(`p.job_id = $${values.length}`);
  }
  if (input.status) {
    values.push(input.status);
    where.push(`p.status = $${values.length}`);
  }
  values.push(limit);

  const result = await pool.query(
    `select
       p.*,
       count(i.id)::int as item_count,
       count(i.id) filter (where i.status = 'completed')::int as completed_item_count,
       count(i.id) filter (where i.status = 'in_progress')::int as in_progress_item_count,
       count(i.id) filter (where i.status = 'blocked')::int as blocked_item_count
     from agent.task_plans p
     left join agent.task_plan_items i on i.plan_id = p.id
     ${where.length ? `where ${where.join(" and ")}` : ""}
     group by p.id
     order by p.updated_at desc, p.id desc
     limit $${values.length}`,
    values
  );

  return {
    plans: result.rows.map(toPlanListSummary),
    filters: {
      jobId: input.jobId ?? null,
      status: input.status ?? null,
      limit
    }
  };
}

export async function listPlanItems(planId: string): Promise<TaskPlanItemRecord[]> {
  const result = await pool.query(
    `select *
     from agent.task_plan_items
     where plan_id = $1
     order by position asc, id asc`,
    [planId]
  );

  return result.rows.map(toTaskPlanItemRecord);
}

export async function getPlan(planId: string): Promise<TaskPlanWithItems | null> {
  const result = await pool.query(`select * from agent.task_plans where id = $1`, [planId]);
  if (!result.rows[0]) {
    return null;
  }

  const plan = toTaskPlanRecord(result.rows[0]);
  const items = await listPlanItems(plan.id);
  return { plan, items };
}

export async function updatePlan(
  planId: string,
  input: {
    title?: string;
    summary?: string | null;
    status?: TaskPlanStatus;
    metadata?: Record<string, unknown>;
  }
): Promise<TaskPlanRecord | null> {
  const current = await getPlan(planId);
  if (!current) {
    return null;
  }

  const result = await pool.query(
    `update agent.task_plans
     set title = coalesce($2, title),
         summary = case when $3::boolean then $4 else summary end,
         status = coalesce($5, status),
         metadata = metadata || $6::jsonb,
         updated_at = now()
     where id = $1
     returning *`,
    [
      planId,
      input.title?.trim() || null,
      Object.prototype.hasOwnProperty.call(input, "summary"),
      input.summary ?? null,
      input.status ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );

  const plan = toTaskPlanRecord(result.rows[0]);
  await appendJobEvent(
    plan.jobId,
    "plan.updated",
    {
      planId,
      status: plan.status
    },
    {
      actor: "plan-ledger"
    }
  );

  return plan;
}

export async function createPlanItem(
  planId: string,
  input: {
    title: string;
    body?: string | null;
    status?: TaskPlanItemStatus;
    agentId?: string | null;
    stageId?: string | null;
    artifactId?: string | null;
    acceptanceCriteria?: string[];
    metadata?: Record<string, unknown>;
  }
): Promise<TaskPlanItemRecord | null> {
  const current = await getPlan(planId);
  if (!current) {
    return null;
  }

  const result = await pool.query(
    `insert into agent.task_plan_items (
      id,
      plan_id,
      position,
      title,
      body,
      status,
      agent_id,
      stage_id,
      artifact_id,
      acceptance_criteria,
      metadata,
      completed_at
    )
    select
      $2,
      $1,
      coalesce(max(position), 0) + 1,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9::jsonb,
      $10::jsonb,
      case when $5 = 'completed' then now() else null end
    from agent.task_plan_items
    where plan_id = $1
    returning *`,
    [
      planId,
      `${planId}-ITEM-${randomUUID().slice(0, 8).toUpperCase()}`,
      input.title.trim(),
      input.body ?? null,
      input.status ?? "pending",
      input.agentId ?? null,
      input.stageId ?? null,
      input.artifactId ?? null,
      JSON.stringify(input.acceptanceCriteria ?? []),
      JSON.stringify(input.metadata ?? {})
    ]
  );

  await pool.query(`update agent.task_plans set updated_at = now() where id = $1`, [planId]);
  const item = toTaskPlanItemRecord(result.rows[0]);
  await appendJobEvent(
    current.plan.jobId,
    "plan.item_created",
    {
      planId,
      itemId: item.id,
      status: item.status
    },
    {
      actor: "plan-ledger",
      stageId: item.stageId,
      artifactId: item.artifactId
    }
  );

  return item;
}

export async function updatePlanItem(
  planId: string,
  itemId: string,
  input: {
    title?: string;
    body?: string | null;
    status?: TaskPlanItemStatus;
    agentId?: string | null;
    stageId?: string | null;
    artifactId?: string | null;
    acceptanceCriteria?: string[];
    metadata?: Record<string, unknown>;
  }
): Promise<TaskPlanItemRecord | null> {
  const current = await getPlan(planId);
  if (!current) {
    return null;
  }

  const result = await pool.query(
    `update agent.task_plan_items
     set title = coalesce($3, title),
         body = case when $4::boolean then $5 else body end,
         status = coalesce($6, status),
         agent_id = case when $7::boolean then $8 else agent_id end,
         stage_id = case when $9::boolean then $10 else stage_id end,
         artifact_id = case when $11::boolean then $12 else artifact_id end,
         acceptance_criteria = case when $13::boolean then $14::jsonb else acceptance_criteria end,
         metadata = metadata || $15::jsonb,
         completed_at = case
           when coalesce($6, status) = 'completed' then coalesce(completed_at, now())
           else null
         end,
         updated_at = now()
     where plan_id = $1 and id = $2
     returning *`,
    [
      planId,
      itemId,
      input.title?.trim() || null,
      Object.prototype.hasOwnProperty.call(input, "body"),
      input.body ?? null,
      input.status ?? null,
      Object.prototype.hasOwnProperty.call(input, "agentId"),
      input.agentId ?? null,
      Object.prototype.hasOwnProperty.call(input, "stageId"),
      input.stageId ?? null,
      Object.prototype.hasOwnProperty.call(input, "artifactId"),
      input.artifactId ?? null,
      Object.prototype.hasOwnProperty.call(input, "acceptanceCriteria"),
      JSON.stringify(input.acceptanceCriteria ?? []),
      JSON.stringify(input.metadata ?? {})
    ]
  );

  if (!result.rows[0]) {
    return null;
  }

  await pool.query(`update agent.task_plans set updated_at = now() where id = $1`, [planId]);
  const item = toTaskPlanItemRecord(result.rows[0]);
  await appendJobEvent(
    current.plan.jobId,
    "plan.item_updated",
    {
      planId,
      itemId: item.id,
      status: item.status
    },
    {
      actor: "plan-ledger",
      stageId: item.stageId,
      artifactId: item.artifactId
    }
  );

  return item;
}
