import type { AgentEventRecord } from "../../shared/src/types";
import { pool } from "./pool";

function toAgentEventRecord(row: any): AgentEventRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    jobId: row.job_id,
    stageId: row.stage_id,
    seq: row.seq,
    actor: row.actor,
    eventType: row.event_type,
    payload: row.payload ?? {},
    artifactId: row.artifact_id,
    groupMessageId: row.group_message_id,
    feishuMessageId: row.feishu_message_id,
    createdAt: row.created_at.toISOString()
  };
}

export async function appendAgentEvent(input: {
  sessionId: string;
  jobId: string;
  actor: string;
  eventType: string;
  payload?: Record<string, unknown>;
  stageId?: string | null;
  artifactId?: string | null;
  groupMessageId?: string | null;
  feishuMessageId?: string | null;
}): Promise<AgentEventRecord> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [input.sessionId]);

    const result = await client.query(
      `insert into agent.agent_events (
        session_id,
        job_id,
        stage_id,
        seq,
        actor,
        event_type,
        payload,
        artifact_id,
        group_message_id,
        feishu_message_id
      )
      values (
        $1,
        $2,
        $3,
        (select coalesce(max(seq), 0) + 1 from agent.agent_events where session_id = $1),
        $4,
        $5,
        $6::jsonb,
        $7,
        $8,
        $9
      )
      returning *`,
      [
        input.sessionId,
        input.jobId,
        input.stageId ?? null,
        input.actor,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
        input.artifactId ?? null,
        input.groupMessageId ?? null,
        input.feishuMessageId ?? null
      ]
    );

    await client.query("commit");
    return toAgentEventRecord(result.rows[0]);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getAgentEventsForJob(jobId: string): Promise<AgentEventRecord[]> {
  const result = await pool.query(`select * from agent.agent_events where job_id = $1 order by seq`, [
    jobId
  ]);
  return result.rows.map(toAgentEventRecord);
}

