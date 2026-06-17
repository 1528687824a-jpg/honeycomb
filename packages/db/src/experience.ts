import { randomUUID } from "node:crypto";
import {
  EXPERIENCE_KINDS,
  EXPERIENCE_SCOPES,
  EXPERIENCE_STATUSES,
  type ExperienceKind,
  type ExperienceRecord,
  type ExperienceScope,
  type ExperienceStatus
} from "../../shared/src/types";
import { pool } from "./pool";

function normalizeStatus(value: unknown): ExperienceStatus {
  return typeof value === "string" && (EXPERIENCE_STATUSES as readonly string[]).includes(value)
    ? (value as ExperienceStatus)
    : "candidate";
}

function normalizeKind(value: unknown): ExperienceKind {
  return typeof value === "string" && (EXPERIENCE_KINDS as readonly string[]).includes(value)
    ? (value as ExperienceKind)
    : "routing_outcome";
}

function normalizeScope(value: unknown): ExperienceScope {
  return typeof value === "string" && (EXPERIENCE_SCOPES as readonly string[]).includes(value)
    ? (value as ExperienceScope)
    : "routing_mode";
}

function clampScore(value: unknown, fallback = 0) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(Math.max(numeric, 0), 1);
}

function toIsoOrNull(value: unknown) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function toExperienceRecord(row: any): ExperienceRecord {
  return {
    id: row.id,
    sourceJobId: row.source_job_id,
    kind: normalizeKind(row.kind),
    scope: normalizeScope(row.scope),
    scopeKey: row.scope_key ?? "",
    status: normalizeStatus(row.status),
    summary: row.summary,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    confidence: clampScore(row.confidence),
    utilityScore: clampScore(row.utility_score),
    decayScore: clampScore(row.decay_score),
    occurrenceCount: Number(row.occurrence_count ?? 1),
    metadata: row.metadata ?? {},
    createdAt: toIsoOrNull(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoOrNull(row.updated_at) ?? new Date(0).toISOString(),
    adoptedAt: toIsoOrNull(row.adopted_at),
    rejectedAt: toIsoOrNull(row.rejected_at),
    lastRecalledAt: toIsoOrNull(row.last_recalled_at),
    recallCount: Number(row.recall_count ?? 0),
    lastReinforcedAt: toIsoOrNull(row.last_reinforced_at)
  };
}

export async function createExperienceCandidate(input: {
  id?: string;
  sourceJobId: string;
  kind: ExperienceKind;
  scope: ExperienceScope;
  scopeKey: string;
  summary: string;
  evidence: Array<Record<string, unknown>>;
  confidence: number;
  utilityScore?: number;
  decayScore?: number;
  occurrenceCount?: number;
  lastReinforcedAt?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const id = input.id ?? `EXP-${randomUUID().slice(0, 12).toUpperCase()}`;
  const confidence = clampScore(input.confidence);
  const utilityScore = clampScore(input.utilityScore, confidence);
  const decayScore = clampScore(input.decayScore);
  const occurrenceCount = Math.max(Math.trunc(input.occurrenceCount ?? 1), 1);
  const result = await pool.query(
    `insert into agent.experience_candidates (
      id,
      source_job_id,
      kind,
      scope,
      scope_key,
      summary,
      evidence,
      confidence,
      utility_score,
      decay_score,
      occurrence_count,
      metadata,
      last_reinforced_at
    ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13::timestamptz)
    on conflict (source_job_id, kind, scope, scope_key)
    do update set
      summary = excluded.summary,
      evidence = excluded.evidence,
      confidence = excluded.confidence,
      utility_score = greatest(agent.experience_candidates.utility_score, excluded.utility_score),
      decay_score = least(agent.experience_candidates.decay_score, excluded.decay_score),
      occurrence_count = greatest(agent.experience_candidates.occurrence_count, excluded.occurrence_count),
      metadata = excluded.metadata,
      last_reinforced_at = coalesce(excluded.last_reinforced_at, agent.experience_candidates.last_reinforced_at),
      updated_at = now()
    returning *`,
    [
      id,
      input.sourceJobId,
      input.kind,
      input.scope,
      input.scopeKey,
      input.summary,
      JSON.stringify(input.evidence),
      confidence,
      utilityScore,
      decayScore,
      occurrenceCount,
      JSON.stringify(input.metadata ?? {}),
      input.lastReinforcedAt
    ]
  );

  return toExperienceRecord(result.rows[0]);
}

export async function getExperience(experienceId: string): Promise<ExperienceRecord | null> {
  const result = await pool.query(`select * from agent.experience_candidates where id = $1`, [
    experienceId
  ]);
  return result.rows[0] ? toExperienceRecord(result.rows[0]) : null;
}

export async function listExperiences(input: {
  status?: ExperienceStatus;
  limit?: number;
} = {}) {
  const status = input.status ? normalizeStatus(input.status) : null;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  const values: unknown[] = [];
  const where: string[] = [];

  if (status) {
    values.push(status);
    where.push(`status = $${values.length}`);
  }
  values.push(limit);

  const [itemsResult, summaryResult] = await Promise.all([
    pool.query(
      `select *
       from agent.experience_candidates
       ${where.length ? `where ${where.join(" and ")}` : ""}
       order by
         case
           when status = 'adopted' then utility_score - decay_score
           else confidence
         end desc,
         updated_at desc,
         id desc
       limit $${values.length}`,
      values
    ),
    pool.query(
      `select
        count(*) filter (where status = 'candidate') as candidate,
        count(*) filter (where status = 'adopted') as adopted,
        count(*) filter (where status = 'rejected') as rejected
       from agent.experience_candidates`
    )
  ]);
  const counts = summaryResult.rows[0];

  return {
    experiences: itemsResult.rows.map(toExperienceRecord),
    summary: {
      candidate: Number(counts.candidate ?? 0),
      adopted: Number(counts.adopted ?? 0),
      rejected: Number(counts.rejected ?? 0)
    },
    filters: {
      status,
      limit
    }
  };
}

export async function setExperienceStatus(
  experienceId: string,
  status: Exclude<ExperienceStatus, "candidate">
) {
  const result = await pool.query(
    `update agent.experience_candidates
     set status = $2,
         adopted_at = case when $2 = 'adopted' then coalesce(adopted_at, now()) else null end,
         rejected_at = case when $2 = 'rejected' then coalesce(rejected_at, now()) else null end,
         utility_score = case
           when $2 = 'adopted' then greatest(utility_score, confidence)
           else utility_score
         end,
         decay_score = case
           when $2 = 'rejected' then least(1.000::numeric, greatest(decay_score, 0.800::numeric))
           else decay_score
         end,
         last_reinforced_at = case
           when $2 = 'adopted' then coalesce(last_reinforced_at, now())
           else last_reinforced_at
         end,
         updated_at = now()
     where id = $1
       and status <> $2
     returning *`,
    [experienceId, status]
  );

  if (result.rows[0]) {
    return {
      experience: toExperienceRecord(result.rows[0]),
      changed: true
    };
  }

  return {
    experience: await getExperience(experienceId),
    changed: false
  };
}

export async function recordExperienceRecall(experienceIds: string[]) {
  const uniqueIds = [...new Set(experienceIds.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) {
    return { recalled: 0 };
  }

  const result = await pool.query(
    `update agent.experience_candidates
     set recall_count = recall_count + 1,
         last_recalled_at = now(),
         utility_score = least(1.000::numeric, utility_score + 0.020::numeric),
         decay_score = greatest(0.000::numeric, decay_score - 0.020::numeric),
         updated_at = now()
     where id = any($1::text[])
       and status = 'adopted'
     returning id`,
    [uniqueIds]
  );

  return { recalled: result.rowCount ?? 0 };
}
