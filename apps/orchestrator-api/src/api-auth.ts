import crypto from "node:crypto";
import type express from "express";
import { verifyMobileDeviceToken } from "../../../packages/db/src/mobile-devices";

export type ApiAuthActor =
  | { kind: "admin"; tokenSource: "honeycomb_api_token" }
  | { kind: "mobile_device"; deviceId: string }
  | { kind: "insecure"; tokenSource: "allow_insecure_api" };

export type ApiAuthDecision =
  | { ok: true; actor: ApiAuthActor }
  | { ok: false; error: "api_token_not_configured" | "invalid_api_token" };

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
  if (headerToken) {
    return headerToken;
  }

  const queryToken = request.query.access_token;
  return typeof queryToken === "string" && queryToken.trim() ? queryToken.trim() : null;
}

export function isPublicRequest(request: express.Request) {
  return request.method === "OPTIONS" || request.path === "/health";
}

export async function authorizeApiToken(input: {
  actualToken: string | null;
  expectedToken?: string | null;
  allowInsecure?: boolean;
  verifyMobileToken?: (token: string) => Promise<{ id: string } | null>;
}): Promise<ApiAuthDecision> {
  const expectedToken = input.expectedToken?.trim() || null;
  const actualToken = input.actualToken?.trim() || null;

  if (expectedToken && actualToken && timingSafeEqualString(actualToken, expectedToken)) {
    return {
      ok: true,
      actor: { kind: "admin", tokenSource: "honeycomb_api_token" }
    };
  }

  if (actualToken && input.verifyMobileToken) {
    const mobileDevice = await input.verifyMobileToken(actualToken);
    if (mobileDevice) {
      return {
        ok: true,
        actor: { kind: "mobile_device", deviceId: mobileDevice.id }
      };
    }
  }

  if (!expectedToken && input.allowInsecure) {
    return {
      ok: true,
      actor: { kind: "insecure", tokenSource: "allow_insecure_api" }
    };
  }

  if (!expectedToken) {
    return { ok: false, error: "api_token_not_configured" };
  }

  return { ok: false, error: "invalid_api_token" };
}

export async function requireApiToken(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction
) {
  if (isPublicRequest(request)) {
    next();
    return;
  }

  let decision: ApiAuthDecision;
  try {
    decision = await authorizeApiToken({
      actualToken: requestToken(request),
      expectedToken: process.env.HONEYCOMB_API_TOKEN,
      allowInsecure: process.env.HONEYCOMB_ALLOW_INSECURE_API === "true",
      verifyMobileToken: (token) => verifyMobileDeviceToken(token)
    });
  } catch (error) {
    next(error);
    return;
  }

  if (!decision.ok) {
    if (decision.error === "api_token_not_configured") {
      response.status(503).json({
        error: "api_token_not_configured",
        message: "HONEYCOMB_API_TOKEN is required for non-health API routes."
      });
      return;
    }

    response.status(401).json({ error: "invalid_api_token" });
    return;
  }

  response.locals.apiAuth = decision.actor;
  next();
}
