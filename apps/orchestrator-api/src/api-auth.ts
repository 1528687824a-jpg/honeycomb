import crypto from "node:crypto";
import type express from "express";

const STREAM_TICKET_VERSION = 1;
const DEFAULT_STREAM_TICKET_TTL_MS = 60_000;
const MIN_STREAM_TICKET_TTL_MS = 5_000;
const MAX_STREAM_TICKET_TTL_MS = 300_000;

type StreamTicketPayload = {
  version: typeof STREAM_TICKET_VERSION;
  path: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export function timingSafeEqualString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function bearerToken(value: string | undefined) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function requestToken(request: express.Request) {
  const headerToken =
    bearerToken(request.header("authorization")) || request.header("x-honeycomb-token")?.trim();
  return headerToken || null;
}

function streamTicketSignature(apiToken: string, encodedPayload: string) {
  return crypto
    .createHmac("sha256", apiToken)
    .update(`honeycomb.stream-ticket.v1.${encodedPayload}`, "utf8")
    .digest("base64url");
}

export function issueStreamTicket(input: {
  apiToken: string;
  path: string;
  ttlMs?: number;
  nowMs?: number;
}) {
  const apiToken = input.apiToken.trim();
  const path = input.path.trim();
  if (!apiToken) throw new Error("stream_ticket_api_token_required");
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.length > 2000) {
    throw new Error("invalid_stream_ticket_path");
  }
  const ttlMs = Math.min(
    Math.max(input.ttlMs ?? DEFAULT_STREAM_TICKET_TTL_MS, MIN_STREAM_TICKET_TTL_MS),
    MAX_STREAM_TICKET_TTL_MS
  );
  const issuedAt = input.nowMs ?? Date.now();
  const payload: StreamTicketPayload = {
    version: STREAM_TICKET_VERSION,
    path,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    nonce: crypto.randomBytes(16).toString("base64url")
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    ticket: `${encodedPayload}.${streamTicketSignature(apiToken, encodedPayload)}`,
    path,
    expiresAt: new Date(payload.expiresAt).toISOString()
  };
}

export function verifyStreamTicket(input: {
  ticket: string;
  apiToken: string;
  path: string;
  nowMs?: number;
}) {
  if (!input.ticket || input.ticket.length > 4096 || !input.apiToken.trim()) return false;
  const parts = input.ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expectedSignature = streamTicketSignature(input.apiToken.trim(), parts[0]);
  if (!timingSafeEqualString(parts[1], expectedSignature)) return false;

  try {
    const payload = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8")
    ) as Partial<StreamTicketPayload>;
    const nowMs = input.nowMs ?? Date.now();
    return payload.version === STREAM_TICKET_VERSION &&
      payload.path === input.path &&
      Number.isInteger(payload.issuedAt) &&
      Number.isInteger(payload.expiresAt) &&
      typeof payload.nonce === "string" &&
      /^[A-Za-z0-9_-]{16,64}$/.test(payload.nonce) &&
      payload.issuedAt! <= nowMs + 30_000 &&
      payload.expiresAt! > nowMs &&
      payload.expiresAt! - payload.issuedAt! >= MIN_STREAM_TICKET_TTL_MS &&
      payload.expiresAt! - payload.issuedAt! <= MAX_STREAM_TICKET_TTL_MS;
  } catch {
    return false;
  }
}

export function isPublicRequest(request: express.Request) {
  return request.method === "OPTIONS" || request.path === "/health";
}

export function requireApiToken(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction
) {
  if (isPublicRequest(request)) {
    next();
    return;
  }

  const expectedToken = process.env.HONEYCOMB_API_TOKEN?.trim();
  if (!expectedToken) {
    if (process.env.HONEYCOMB_ALLOW_INSECURE_API === "true") {
      next();
      return;
    }

    response.status(503).json({
      error: "api_token_not_configured",
      message: "HONEYCOMB_API_TOKEN is required for non-health API routes."
    });
    return;
  }

  const actualToken = requestToken(request);
  if (actualToken && timingSafeEqualString(actualToken, expectedToken)) {
    next();
    return;
  }

  const queryTicket = request.query.stream_ticket;
  const streamTicket = typeof queryTicket === "string" ? queryTicket.trim() : "";
  if (request.method === "GET" && streamTicket && verifyStreamTicket({
    ticket: streamTicket,
    apiToken: expectedToken,
    path: request.path
  })) {
    next();
    return;
  }

  response.status(401).json({ error: "invalid_api_token" });
}
