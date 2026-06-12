import crypto from "node:crypto";
import type express from "express";

function timingSafeEqualString(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function bearerToken(value: string | undefined) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function requestToken(request: express.Request) {
  const headerToken =
    bearerToken(request.header("authorization")) || request.header("x-honeycomb-token")?.trim();
  if (headerToken) {
    return headerToken;
  }

  const queryToken = request.query.access_token;
  return typeof queryToken === "string" && queryToken.trim() ? queryToken.trim() : null;
}

function isPublicRequest(request: express.Request) {
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
  if (!actualToken || !timingSafeEqualString(actualToken, expectedToken)) {
    response.status(401).json({ error: "invalid_api_token" });
    return;
  }

  next();
}
