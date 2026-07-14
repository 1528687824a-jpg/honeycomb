import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  ConversationAttachment,
  ConversationMessageRecord,
  ConversationMessageRole,
  ConversationMessageStatus,
  ConversationProjectRecord,
  ConversationProjectWithThreads,
  ConversationRecord,
  ConversationWorkspaceSnapshot
} from "../../shared/src/types";
import { pool } from "./pool";

const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

type QueryClient = Pick<PoolClient, "query">;

export class ConversationRecordConflictError extends Error {
  constructor(message = "conversation_record_conflict") {
    super(message);
    this.name = "ConversationRecordConflictError";
  }
}

export class ConversationRecordDeletedError extends Error {
  constructor(message = "conversation_record_deleted") {
    super(message);
    this.name = "ConversationRecordDeletedError";
  }
}

export function normalizeConversationClientTimestamp(value?: string | null, now = new Date()) {
  if (!value) return now.toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return now.toISOString();
  return new Date(Math.min(timestamp, now.getTime() + MAX_CLIENT_CLOCK_SKEW_MS)).toISOString();
}

function toIso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function toNullableIso(value: unknown) {
  if (!value) return null;
  return toIso(value);
}

function toConversationProjectRecord(row: any): ConversationProjectRecord {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path ?? null,
    pinned: row.pinned ?? false,
    archivedAt: toNullableIso(row.archived_at),
    metadata: row.metadata ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toConversationRecord(row: any): ConversationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    draft: row.draft ?? "",
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    pinned: row.pinned ?? false,
    unread: row.unread ?? false,
    archivedAt: toNullableIso(row.archived_at),
    metadata: row.metadata ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toConversationMessageRecord(row: any): ConversationMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    body: row.body,
    status: row.status,
    jobId: row.job_id ?? null,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    metadata: row.metadata ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function fallbackId(prefix: "project" | "conversation" | "message") {
  return `${prefix}-${randomUUID()}`;
}

async function withTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export type UpsertConversationProjectInput = {
  id?: string;
  name: string;
  workspacePath?: string | null;
  pinned?: boolean;
  archivedAt?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type UpsertConversationInput = {
  id?: string;
  projectId: string;
  title: string;
  draft?: string;
  attachments?: ConversationAttachment[];
  pinned?: boolean;
  unread?: boolean;
  archivedAt?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type UpsertConversationMessageInput = {
  id?: string;
  conversationId: string;
  role: ConversationMessageRole;
  body: string;
  status?: ConversationMessageStatus;
  jobId?: string | null;
  attachments?: ConversationAttachment[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

async function upsertProjectWithClient(
  client: QueryClient,
  input: UpsertConversationProjectInput
) {
  const id = input.id?.trim() || fallbackId("project");
  const now = new Date();
  const updatedAt = normalizeConversationClientTimestamp(input.updatedAt, now);
  const createdAt = normalizeConversationClientTimestamp(input.createdAt ?? updatedAt, now);
  const result = await client.query(
    `insert into agent.conversation_projects (
      id, name, workspace_path, pinned, archived_at, metadata, created_at, updated_at
    ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
    on conflict (id) do update set
      name = excluded.name,
      workspace_path = excluded.workspace_path,
      pinned = excluded.pinned,
      archived_at = excluded.archived_at,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
    where conversation_projects.deleted_at is null
      and excluded.updated_at >= conversation_projects.updated_at
    returning *`,
    [
      id,
      input.name.trim(),
      input.workspacePath?.trim() || null,
      input.pinned ?? false,
      input.archivedAt ?? null,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
      updatedAt
    ]
  );
  if (result.rows[0]) return toConversationProjectRecord(result.rows[0]);

  const current = await client.query(
    `select * from agent.conversation_projects where id = $1`,
    [id]
  );
  if (current.rows[0]?.deleted_at) throw new ConversationRecordDeletedError();
  if (!current.rows[0]) throw new ConversationRecordConflictError();
  return toConversationProjectRecord(current.rows[0]);
}

async function upsertConversationWithClient(client: QueryClient, input: UpsertConversationInput) {
  const id = input.id?.trim() || fallbackId("conversation");
  const now = new Date();
  const updatedAt = normalizeConversationClientTimestamp(input.updatedAt, now);
  const createdAt = normalizeConversationClientTimestamp(input.createdAt ?? updatedAt, now);
  const result = await client.query(
    `insert into agent.conversations (
      id, project_id, title, draft, attachments, pinned, unread, archived_at, metadata, created_at, updated_at
    ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11)
    on conflict (id) do update set
      title = excluded.title,
      draft = excluded.draft,
      attachments = excluded.attachments,
      pinned = excluded.pinned,
      unread = excluded.unread,
      archived_at = excluded.archived_at,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
    where conversations.deleted_at is null
      and conversations.project_id = excluded.project_id
      and excluded.updated_at >= conversations.updated_at
    returning *`,
    [
      id,
      input.projectId,
      input.title.trim(),
      input.draft ?? "",
      JSON.stringify(input.attachments ?? []),
      input.pinned ?? false,
      input.unread ?? false,
      input.archivedAt ?? null,
      JSON.stringify(input.metadata ?? {}),
      createdAt,
      updatedAt
    ]
  );
  if (result.rows[0]) return toConversationRecord(result.rows[0]);

  const current = await client.query(`select * from agent.conversations where id = $1`, [id]);
  if (current.rows[0]?.deleted_at) throw new ConversationRecordDeletedError();
  if (!current.rows[0] || current.rows[0].project_id !== input.projectId) {
    throw new ConversationRecordConflictError();
  }
  return toConversationRecord(current.rows[0]);
}

async function upsertMessageWithClient(
  client: QueryClient,
  input: UpsertConversationMessageInput
) {
  const id = input.id?.trim() || fallbackId("message");
  const now = new Date();
  const updatedAt = normalizeConversationClientTimestamp(input.updatedAt, now);
  const createdAt = normalizeConversationClientTimestamp(input.createdAt ?? updatedAt, now);
  const result = await client.query(
    `insert into agent.conversation_messages (
      id, conversation_id, role, body, status, job_id, attachments, metadata, created_at, updated_at
    ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
    on conflict (id) do update set
      role = excluded.role,
      body = excluded.body,
      status = excluded.status,
      job_id = coalesce(excluded.job_id, conversation_messages.job_id),
      attachments = excluded.attachments,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
    where conversation_messages.deleted_at is null
      and conversation_messages.conversation_id = excluded.conversation_id
      and excluded.updated_at >= conversation_messages.updated_at
    returning *`,
    [
      id,
      input.conversationId,
      input.role,
      input.body,
      input.status ?? "sent",
      input.jobId ?? null,
      JSON.stringify(input.attachments ?? []),
      JSON.stringify(input.metadata ?? {}),
      createdAt,
      updatedAt
    ]
  );
  if (result.rows[0]) return toConversationMessageRecord(result.rows[0]);

  const current = await client.query(
    `select * from agent.conversation_messages where id = $1`,
    [id]
  );
  if (current.rows[0]?.deleted_at) throw new ConversationRecordDeletedError();
  if (!current.rows[0] || current.rows[0].conversation_id !== input.conversationId) {
    throw new ConversationRecordConflictError();
  }
  return toConversationMessageRecord(current.rows[0]);
}

export async function upsertConversationProject(input: UpsertConversationProjectInput) {
  return upsertProjectWithClient(pool, input);
}

export async function upsertConversation(input: UpsertConversationInput) {
  return upsertConversationWithClient(pool, input);
}

export async function upsertConversationMessage(input: UpsertConversationMessageInput) {
  return upsertMessageWithClient(pool, input);
}

export async function getConversationProject(projectId: string) {
  const result = await pool.query(
    `select * from agent.conversation_projects where id = $1 and deleted_at is null`,
    [projectId]
  );
  return result.rows[0] ? toConversationProjectRecord(result.rows[0]) : null;
}

export async function getConversation(conversationId: string) {
  const result = await pool.query(
    `select * from agent.conversations where id = $1 and deleted_at is null`,
    [conversationId]
  );
  return result.rows[0] ? toConversationRecord(result.rows[0]) : null;
}

export async function getConversationMessage(messageId: string) {
  const result = await pool.query(
    `select * from agent.conversation_messages where id = $1 and deleted_at is null`,
    [messageId]
  );
  return result.rows[0] ? toConversationMessageRecord(result.rows[0]) : null;
}

export async function listConversationProjects(input: { includeArchived?: boolean } = {}) {
  const result = await pool.query(
    `select *
     from agent.conversation_projects
     where deleted_at is null
       and ($1::boolean or archived_at is null)
     order by pinned desc, updated_at desc, id`,
    [input.includeArchived ?? false]
  );
  return result.rows.map(toConversationProjectRecord);
}

export async function listConversations(input: {
  projectId: string;
  includeArchived?: boolean;
}) {
  const result = await pool.query(
    `select *
     from agent.conversations
     where project_id = $1
       and deleted_at is null
       and ($2::boolean or archived_at is null)
     order by pinned desc, updated_at desc, id`,
    [input.projectId, input.includeArchived ?? false]
  );
  return result.rows.map(toConversationRecord);
}

export async function listConversationMessages(input: {
  conversationId: string;
  limit?: number;
}) {
  const limit = Math.max(1, Math.min(input.limit ?? 500, 2000));
  const result = await pool.query(
    `select *
     from (
       select *
       from agent.conversation_messages
       where conversation_id = $1
         and deleted_at is null
       order by created_at desc, id desc
       limit $2
     ) recent
     order by created_at, id`,
    [input.conversationId, limit]
  );
  return result.rows.map(toConversationMessageRecord);
}

export async function patchConversationProject(
  projectId: string,
  input: Partial<Pick<ConversationProjectRecord, "name" | "workspacePath" | "pinned" | "archivedAt" | "metadata">>
) {
  const current = await getConversationProject(projectId);
  if (!current) return null;
  return upsertConversationProject({
    ...current,
    ...input,
    id: projectId,
    name: input.name ?? current.name,
    updatedAt: new Date().toISOString()
  });
}

export async function patchConversation(
  conversationId: string,
  input: Partial<Pick<ConversationRecord, "title" | "draft" | "attachments" | "pinned" | "unread" | "archivedAt" | "metadata">>
) {
  const current = await getConversation(conversationId);
  if (!current) return null;
  return upsertConversation({
    ...current,
    ...input,
    id: conversationId,
    title: input.title ?? current.title,
    updatedAt: new Date().toISOString()
  });
}

export async function patchConversationMessage(
  messageId: string,
  input: Partial<Pick<ConversationMessageRecord, "status" | "jobId" | "metadata">>
) {
  const current = await getConversationMessage(messageId);
  if (!current) return null;
  return upsertConversationMessage({
    ...current,
    ...input,
    id: messageId,
    updatedAt: new Date().toISOString()
  });
}

export async function deleteConversationProject(projectId: string) {
  return withTransaction(async (client) => {
    const deletedAt = new Date().toISOString();
    await client.query(
      `update agent.conversation_messages message
       set deleted_at = $2, updated_at = $2
       from agent.conversations conversation
       where message.conversation_id = conversation.id
         and conversation.project_id = $1
         and message.deleted_at is null`,
      [projectId, deletedAt]
    );
    await client.query(
      `update agent.conversations
       set deleted_at = $2, updated_at = $2
       where project_id = $1 and deleted_at is null`,
      [projectId, deletedAt]
    );
    const result = await client.query(
      `update agent.conversation_projects
       set deleted_at = $2, updated_at = $2
       where id = $1 and deleted_at is null
       returning id`,
      [projectId, deletedAt]
    );
    return result.rowCount === 1;
  });
}

export async function deleteConversation(conversationId: string) {
  return withTransaction(async (client) => {
    const deletedAt = new Date().toISOString();
    await client.query(
      `update agent.conversation_messages
       set deleted_at = $2, updated_at = $2
       where conversation_id = $1 and deleted_at is null`,
      [conversationId, deletedAt]
    );
    const result = await client.query(
      `update agent.conversations
       set deleted_at = $2, updated_at = $2
       where id = $1 and deleted_at is null
       returning id`,
      [conversationId, deletedAt]
    );
    return result.rowCount === 1;
  });
}

async function snapshotWithClient(client: QueryClient): Promise<ConversationWorkspaceSnapshot> {
  const [projectResult, conversationResult, messageResult] = await Promise.all([
    client.query(
      `select * from agent.conversation_projects
       where deleted_at is null
       order by pinned desc, updated_at desc, id`
    ),
    client.query(
      `select * from agent.conversations
       where deleted_at is null
       order by pinned desc, updated_at desc, id`
    ),
    client.query(
      `select * from agent.conversation_messages
       where deleted_at is null
       order by created_at, id`
    )
  ]);
  const messagesByConversation = new Map<string, ConversationMessageRecord[]>();
  for (const row of messageResult.rows) {
    const message = toConversationMessageRecord(row);
    const messages = messagesByConversation.get(message.conversationId) ?? [];
    messages.push(message);
    messagesByConversation.set(message.conversationId, messages);
  }
  const conversationsByProject = new Map<
    string,
    Array<ConversationRecord & { messages: ConversationMessageRecord[] }>
  >();
  for (const row of conversationResult.rows) {
    const conversation = toConversationRecord(row);
    const conversations = conversationsByProject.get(conversation.projectId) ?? [];
    conversations.push({
      ...conversation,
      messages: messagesByConversation.get(conversation.id) ?? []
    });
    conversationsByProject.set(conversation.projectId, conversations);
  }
  const projects: ConversationProjectWithThreads[] = projectResult.rows.map((row) => {
    const project = toConversationProjectRecord(row);
    return {
      ...project,
      conversations: conversationsByProject.get(project.id) ?? []
    };
  });
  return {
    projects,
    generatedAt: new Date().toISOString()
  };
}

export async function getConversationWorkspaceSnapshot() {
  return withTransaction(async (client) => snapshotWithClient(client));
}

export async function syncConversationWorkspaceSnapshot(input: ConversationWorkspaceSnapshot) {
  return withTransaction(async (client) => {
    let conversationCount = 0;
    let messageCount = 0;
    for (const project of input.projects) {
      await upsertProjectWithClient(client, project);
      for (const conversation of project.conversations) {
        await upsertConversationWithClient(client, {
          ...conversation,
          projectId: project.id
        });
        conversationCount += 1;
        for (const message of conversation.messages) {
          await upsertMessageWithClient(client, {
            ...message,
            conversationId: conversation.id
          });
          messageCount += 1;
        }
      }
    }
    return {
      snapshot: await snapshotWithClient(client),
      accepted: {
        projects: input.projects.length,
        conversations: conversationCount,
        messages: messageCount
      }
    };
  });
}
