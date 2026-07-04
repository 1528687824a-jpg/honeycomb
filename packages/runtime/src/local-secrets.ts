import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SecretBackendFormat = "dpapi-user-v1" | "keychain-v1" | "plaintext-local-v1";

type SecretBackendContext = {
  filePath: string;
  providerId?: string;
};

type SecretBackend = {
  format: SecretBackendFormat;
  protect(secret: string, context: SecretBackendContext): Promise<Record<string, unknown>>;
  unprotect(payload: Record<string, unknown>, context: SecretBackendContext): Promise<string | null>;
};

function defaultSecretRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "io.agentopenclaw.desktop", "honeycomb-secrets");
  }
  if (process.platform !== "win32") {
    return path.join(os.homedir(), ".config", "io.agentopenclaw.desktop", "honeycomb-secrets");
  }
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "io.agentopenclaw.desktop",
    "honeycomb-secrets"
  );
}

function secretRoot() {
  return (
    process.env.HONEYCOMB_SECRET_DIR ||
    defaultSecretRoot()
  );
}

function safeName(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function providerSecretPath(providerId: string) {
  return path.join(secretRoot(), "providers", `${safeName(providerId)}.key`);
}

const DEFAULT_SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
const secretCache = new Map<string, { value: string; expiresAt: number }>();

function secretCacheTtlMs() {
  const value = Number(process.env.HONEYCOMB_SECRET_CACHE_TTL_MS ?? DEFAULT_SECRET_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SECRET_CACHE_TTL_MS;
}

function readCachedSecret(filePath: string) {
  const cached = secretCache.get(filePath);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    secretCache.delete(filePath);
    return null;
  }
  return cached.value;
}

function writeCachedSecret(filePath: string, value: string) {
  secretCache.set(filePath, {
    value,
    expiresAt: Date.now() + secretCacheTtlMs()
  });
}

export function clearProviderApiKeyCache() {
  secretCache.clear();
}

function runCommand(command: string, args: string[], input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} failed`));
    });
    child.stdin.end(input);
  });
}

function runPowerShellDpapi(action: "protect" | "unprotect", base64Input: string) {
  const script =
    action === "protect"
      ? `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$inputText=[Console]::In.ReadToEnd().Trim();$bytes=[Convert]::FromBase64String($inputText);$protected=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))`
      : `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$inputText=[Console]::In.ReadToEnd().Trim();$bytes=[Convert]::FromBase64String($inputText);$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($plain))`;

  return runCommand(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    base64Input
  );
}

const dpapiSecretBackend: SecretBackend = {
  format: "dpapi-user-v1",
  async protect(secret: string) {
    return {
      format: "dpapi-user-v1",
      ciphertext: await runPowerShellDpapi("protect", Buffer.from(secret, "utf8").toString("base64"))
    };
  },
  async unprotect(payload: Record<string, unknown>) {
    if (typeof payload.ciphertext !== "string") {
      return null;
    }
    const decrypted = await runPowerShellDpapi("unprotect", payload.ciphertext);
    return unwrapNestedPlaintextSecret(Buffer.from(decrypted, "base64").toString("utf8"));
  }
};

const plaintextLocalSecretBackend: SecretBackend = {
  format: "plaintext-local-v1",
  async protect(secret: string) {
    return {
      format: "plaintext-local-v1",
      value: Buffer.from(secret, "utf8").toString("base64")
    };
  },
  async unprotect(payload: Record<string, unknown>) {
    if (typeof payload.value !== "string") {
      return null;
    }
    return unwrapNestedPlaintextSecret(Buffer.from(payload.value, "base64").toString("utf8"));
  }
};

function keychainService() {
  return process.env.HONEYCOMB_KEYCHAIN_SERVICE?.trim() || "io.agentopenclaw.desktop.honeycomb-secrets";
}

function keychainAccount(context: SecretBackendContext) {
  if (context.providerId) {
    return `provider:${safeName(context.providerId)}`;
  }
  return `file:${createHash("sha256").update(context.filePath, "utf8").digest("hex").slice(0, 32)}`;
}

function runMacOsSecurity(args: string[]) {
  return runCommand("security", args);
}

const keychainSecretBackend: SecretBackend = {
  format: "keychain-v1",
  async protect(secret: string, context: SecretBackendContext) {
    const service = keychainService();
    const account = keychainAccount(context);
    await runMacOsSecurity(["add-generic-password", "-s", service, "-a", account, "-w", secret, "-U"]);
    return {
      format: "keychain-v1",
      service,
      account
    };
  },
  async unprotect(payload: Record<string, unknown>) {
    if (typeof payload.service !== "string" || typeof payload.account !== "string") {
      return null;
    }
    const secret = await runMacOsSecurity([
      "find-generic-password",
      "-s",
      payload.service,
      "-a",
      payload.account,
      "-w"
    ]);
    return unwrapNestedPlaintextSecret(secret);
  }
};

export function selectSecretBackendFormat(input: {
  platform?: NodeJS.Platform;
  configured?: string | null;
} = {}): SecretBackendFormat {
  const configured = input.configured ?? process.env.HONEYCOMB_SECRET_BACKEND;
  const normalized = configured?.trim().toLowerCase();
  if (normalized === "dpapi" || normalized === "dpapi-user-v1") {
    return "dpapi-user-v1";
  }
  if (normalized === "keychain" || normalized === "keychain-v1") {
    return "keychain-v1";
  }
  if (normalized === "plaintext" || normalized === "plaintext-local" || normalized === "plaintext-local-v1") {
    return "plaintext-local-v1";
  }

  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    return "dpapi-user-v1";
  }
  if (platform === "darwin") {
    return "keychain-v1";
  }
  return "plaintext-local-v1";
}

function secretBackendForFormat(format: SecretBackendFormat) {
  switch (format) {
    case "dpapi-user-v1":
      return dpapiSecretBackend;
    case "keychain-v1":
      return keychainSecretBackend;
    case "plaintext-local-v1":
      return plaintextLocalSecretBackend;
  }
}

function secretBackendForWrite() {
  return secretBackendForFormat(selectSecretBackendFormat());
}

async function encryptSecret(secret: string, context: SecretBackendContext) {
  return secretBackendForWrite().protect(secret, context);
}

async function decryptSecret(payload: unknown, context: SecretBackendContext) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const format = record.format;
  if (format === "dpapi-user-v1" || format === "keychain-v1" || format === "plaintext-local-v1") {
    return secretBackendForFormat(format).unprotect(record, context);
  }

  return null;
}

function unwrapNestedPlaintextSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed) as { format?: unknown; value?: unknown };
    if (parsed.format === "plaintext-local-v1" && typeof parsed.value === "string") {
      return Buffer.from(parsed.value, "base64").toString("utf8");
    }
  } catch {
    // Keep the original value if it is not one of Honeycomb's secret envelopes.
  }

  return value;
}

function hasRecognizedSecretEnvelope(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const format = (payload as Record<string, unknown>).format;
  return format === "dpapi-user-v1" || format === "keychain-v1" || format === "plaintext-local-v1";
}

export function fingerprintSecret(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);
}

export async function saveProviderApiKey(providerId: string, apiKey: string) {
  const filePath = providerSecretPath(providerId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(await encryptSecret(apiKey, { filePath, providerId }), null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  writeCachedSecret(filePath, apiKey);
  return {
    configured: true,
    fingerprint: fingerprintSecret(apiKey)
  };
}

export async function readProviderApiKey(providerId: string) {
  const filePath = providerSecretPath(providerId);
  const cached = readCachedSecret(filePath);
  if (cached) {
    return cached;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (parsed !== null) {
      let decrypted: string | null;
      try {
        decrypted = await decryptSecret(parsed, { filePath, providerId });
      } catch {
        return null;
      }
      if (decrypted !== null) {
        writeCachedSecret(filePath, decrypted);
        return decrypted;
      }
      if (hasRecognizedSecretEnvelope(parsed)) {
        return null;
      }
    }

    const legacy = raw.trim();
    if (!legacy) {
      return null;
    }
    await saveProviderApiKey(providerId, legacy);
    writeCachedSecret(filePath, legacy);
    return legacy;
  } catch {
    return null;
  }
}

export async function getProviderApiKeyStatus(providerId: string) {
  const apiKey = await readProviderApiKey(providerId);
  return {
    configured: Boolean(apiKey),
    fingerprint: apiKey ? fingerprintSecret(apiKey) : null
  };
}
