import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), ".runtime", `secret-storage-smoke-${randomUUID()}`);
process.env.HONEYCOMB_SECRET_DIR = root;

function expectedSecretFormat() {
  if (process.platform === "win32") {
    return "dpapi-user-v1";
  }
  if (process.platform === "darwin") {
    return "keychain-v1";
  }
  return "plaintext-local-v1";
}

async function main() {
  const { readProviderApiKey, saveProviderApiKey } = await import("../packages/runtime/src/local-secrets");

  const providerId = "smoke-provider";
  const marker = `sk-honeycomb-smoke-${randomUUID()}`;
  await saveProviderApiKey(providerId, marker);

  const readBack = await readProviderApiKey(providerId);
  if (readBack !== marker) {
    throw new Error("secret_storage_readback_failed");
  }

  const raw = await fs.readFile(path.join(root, "providers", `${providerId}.key`), "utf8");
  if (raw.includes(marker)) {
    throw new Error("secret_storage_contains_plaintext");
  }

  const expectedFormat = expectedSecretFormat();
  if (!raw.includes(`"format": "${expectedFormat}"`)) {
    throw new Error(`secret_storage_not_${expectedFormat}`);
  }

  console.log(JSON.stringify({
    ok: true,
    providerId,
    format: expectedFormat,
    plaintextPresent: false
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
