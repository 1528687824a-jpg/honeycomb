import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const secretEnvNames = [
  "ADMIN_API_TOKEN",
  "ARK_API_KEY",
  "DEEPSEEK_API_KEY",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
  "M3_PLANNER_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY"
];

const envAssignmentFilePattern = /\.(env\.example|md|ya?ml|toml|ps1)$/i;
const highConfidenceSecretPatterns = [
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g
];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => !file.startsWith("package-lock.json"));
}

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  return (
    normalized === "" ||
    normalized === "true" ||
    normalized === "false" ||
    normalized === "mock" ||
    normalized.startsWith("$") ||
    normalized.startsWith("<") ||
    normalized.startsWith("local-") ||
    normalized.includes("secrets.") ||
    normalized.includes("local-smoke")
  );
}

function main() {
  const envAssignmentPattern = new RegExp(
    `^\\s*(?:\\$env:|export\\s+)?(${secretEnvNames.join("|")})\\s*[:=]\\s*(.+?)\\s*(?:#.*)?$`
  );
  const findings: string[] = [];

  for (const file of trackedFiles()) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const pattern of highConfidenceSecretPatterns) {
      const matches = content.match(pattern) ?? [];
      for (const match of matches) {
        findings.push(`${file}: high-confidence secret-looking token ${match.slice(0, 8)}...`);
      }
    }

    if (!envAssignmentFilePattern.test(file)) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = line.match(envAssignmentPattern);
      if (!match) {
        return;
      }
      const [, name, value] = match;
      if (!isPlaceholder(value)) {
        findings.push(`${file}:${index + 1}: ${name} appears to have a committed value`);
      }
    });
  }

  if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ ok: true, checked: "tracked_files_no_obvious_secrets" }, null, 2));
}

main();
