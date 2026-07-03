import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pool } from "./pool";

export type MobileDeviceStatus = "active" | "revoked";

export type MobileDeviceRecord = {
  id: string;
  displayName: string;
  platform: string | null;
  tokenPrefix: string;
  status: MobileDeviceStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

export type IssueMobileDeviceInput = {
  displayName: string;
  platform?: string | null;
  metadata?: Record<string, unknown>;
};

function nowIso() {
  return new Date().toISOString();
}

function deviceId() {
  return `MD-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID()
    .slice(0, 8)
    .toUpperCase()}`;
}

function normalizeStatus(value: unknown): MobileDeviceStatus {
  return value === "revoked" ? "revoked" : "active";
}

function toMobileDeviceRecord(row: any): MobileDeviceRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    platform: row.platform,
    tokenPrefix: row.token_prefix,
    status: normalizeStatus(row.status),
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null
  };
}

export function mobileDeviceTokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mobileDeviceTokenPrefix(token: string) {
  return token.slice(0, 18);
}

function newMobileDeviceToken(id: string) {
  const secret = randomBytes(32).toString("base64url");
  return `hcdev_${id}_${secret}`;
}

export async function issueMobileDevice(input: IssueMobileDeviceInput) {
  const id = deviceId();
  const token = newMobileDeviceToken(id);
  const tokenHash = mobileDeviceTokenHash(token);
  const tokenPrefix = mobileDeviceTokenPrefix(token);
  const result = await pool.query(
    `insert into agent.mobile_devices (
       id,
       display_name,
       platform,
       token_hash,
       token_prefix,
       status,
       metadata,
       created_at,
       updated_at
     )
     values ($1, $2, $3, $4, $5, 'active', $6, now(), now())
     returning *`,
    [
      id,
      input.displayName.trim(),
      input.platform?.trim() || null,
      tokenHash,
      tokenPrefix,
      input.metadata ?? {}
    ]
  );

  return {
    device: toMobileDeviceRecord(result.rows[0]),
    token
  };
}

export async function listMobileDevices(input: { includeRevoked?: boolean } = {}) {
  const result = await pool.query(
    input.includeRevoked
      ? `select * from agent.mobile_devices order by updated_at desc`
      : `select * from agent.mobile_devices where status = 'active' order by updated_at desc`
  );
  return result.rows.map(toMobileDeviceRecord);
}

export async function getMobileDevice(deviceIdValue: string) {
  const result = await pool.query(`select * from agent.mobile_devices where id = $1`, [deviceIdValue]);
  return result.rows[0] ? toMobileDeviceRecord(result.rows[0]) : null;
}

export async function verifyMobileDeviceToken(token: string, input: { touch?: boolean } = {}) {
  const tokenHash = mobileDeviceTokenHash(token);
  const result = await pool.query(
    input.touch === false
      ? `select * from agent.mobile_devices where token_hash = $1 and status = 'active'`
      : `update agent.mobile_devices
         set last_seen_at = now(), updated_at = now()
         where token_hash = $1 and status = 'active'
         returning *`,
    [tokenHash]
  );
  return result.rows[0] ? toMobileDeviceRecord(result.rows[0]) : null;
}

export async function revokeMobileDevice(deviceIdValue: string) {
  const result = await pool.query(
    `update agent.mobile_devices
     set status = 'revoked',
         revoked_at = coalesce(revoked_at, now()),
         updated_at = now()
     where id = $1
     returning *`,
    [deviceIdValue]
  );
  return result.rows[0] ? toMobileDeviceRecord(result.rows[0]) : null;
}

export async function touchMobileDevice(deviceIdValue: string, at = nowIso()) {
  const result = await pool.query(
    `update agent.mobile_devices
     set last_seen_at = $2,
         updated_at = now()
     where id = $1 and status = 'active'
     returning *`,
    [deviceIdValue, at]
  );
  return result.rows[0] ? toMobileDeviceRecord(result.rows[0]) : null;
}
