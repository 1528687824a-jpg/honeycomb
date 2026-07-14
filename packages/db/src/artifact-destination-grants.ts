import { randomUUID } from "node:crypto";
import {
  isArtifactPathInsideRoot,
  normalizeArtifactDestinationRootPath
} from "../../shared/src/artifact-destination-policy";
import type { ArtifactDestinationGrantRecord } from "../../shared/src/types";
import { pool } from "./pool";

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toArtifactDestinationGrantRecord(row: any): ArtifactDestinationGrantRecord {
  return {
    id: row.id,
    rootPath: row.root_path,
    rootPathKey: row.root_path_key,
    displayName: row.display_name ?? null,
    enabled: Boolean(row.enabled),
    approvalId: row.approval_id,
    grantedBy: row.granted_by ?? null,
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    lastUsedAt: iso(row.last_used_at)
  };
}

function fallbackGrantId() {
  return `destination-grant-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function listArtifactDestinationGrants(input: { enabled?: boolean } = {}) {
  const values: unknown[] = [];
  const where: string[] = [];
  if (input.enabled !== undefined) {
    values.push(input.enabled);
    where.push(`enabled = $${values.length}`);
  }
  const result = await pool.query(
    `select *
     from agent.artifact_destination_grants
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by updated_at desc, root_path asc`,
    values
  );
  return result.rows.map(toArtifactDestinationGrantRecord);
}

export async function getArtifactDestinationGrant(grantId: string) {
  const result = await pool.query(
    `select * from agent.artifact_destination_grants where id = $1`,
    [grantId]
  );
  return result.rows[0] ? toArtifactDestinationGrantRecord(result.rows[0]) : null;
}

export async function findActiveArtifactDestinationGrant(requestedDirectoryPath: string) {
  const normalizedRequested = normalizeArtifactDestinationRootPath(requestedDirectoryPath);
  const result = await pool.query(
    `select *
     from agent.artifact_destination_grants
     where enabled = true
       and revoked_at is null
       and (expires_at is null or expires_at > now())
     order by length(root_path_key) desc, updated_at desc`
  );
  const row = result.rows.find((candidate) =>
    isArtifactPathInsideRoot(candidate.root_path, normalizedRequested)
  );
  return row ? toArtifactDestinationGrantRecord(row) : null;
}

export async function upsertArtifactDestinationGrant(input: {
  id?: string;
  rootPath: string;
  rootPathKey: string;
  displayName?: string | null;
  approvalId: string;
  grantedBy?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const id = input.id?.trim() || fallbackGrantId();
  const result = await pool.query(
    `insert into agent.artifact_destination_grants (
       id, root_path, root_path_key, display_name, enabled, approval_id,
       granted_by, expires_at, revoked_at, metadata, last_used_at
     ) values ($1, $2, $3, $4, true, $5, $6, $7::timestamptz, null, $8::jsonb, now())
     on conflict (root_path_key) do update set
       root_path = excluded.root_path,
       display_name = excluded.display_name,
       enabled = true,
       approval_id = excluded.approval_id,
       granted_by = excluded.granted_by,
       expires_at = excluded.expires_at,
       revoked_at = null,
       metadata = excluded.metadata,
       updated_at = now(),
       last_used_at = now()
     returning *`,
    [
      id,
      input.rootPath,
      input.rootPathKey,
      input.displayName ?? null,
      input.approvalId,
      input.grantedBy ?? null,
      input.expiresAt ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return toArtifactDestinationGrantRecord(result.rows[0]);
}

export async function revokeArtifactDestinationGrant(grantId: string) {
  const result = await pool.query(
    `update agent.artifact_destination_grants
     set enabled = false,
         revoked_at = coalesce(revoked_at, now()),
         updated_at = now()
     where id = $1
       and enabled = true
     returning *`,
    [grantId]
  );
  if (result.rows[0]) {
    return { changed: true as const, grant: toArtifactDestinationGrantRecord(result.rows[0]) };
  }
  return { changed: false as const, grant: await getArtifactDestinationGrant(grantId) };
}

export async function markArtifactDestinationGrantUsed(grantId: string) {
  const result = await pool.query(
    `update agent.artifact_destination_grants
     set last_used_at = now(),
         updated_at = now()
     where id = $1
       and enabled = true
       and revoked_at is null
       and (expires_at is null or expires_at > now())
     returning *`,
    [grantId]
  );
  return result.rows[0] ? toArtifactDestinationGrantRecord(result.rows[0]) : null;
}
