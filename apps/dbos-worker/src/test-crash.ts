import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function maybeCrashOnce(label: string, jobId: string) {
  if (process.env.DBOS_TEST_CRASH_ONCE_AFTER !== label) {
    return;
  }

  const markerDir = path.resolve(process.env.DBOS_TEST_CRASH_MARKER_DIR ?? ".runtime/dbos-crash");
  const markerPath = path.join(markerDir, `${jobId}-${label.replace(/[^A-Za-z0-9_.-]/g, "_")}.marker`);

  if (existsSync(markerPath)) {
    return;
  }

  mkdirSync(markerDir, { recursive: true });
  writeFileSync(markerPath, new Date().toISOString(), "utf8");
  process.exit(99);
}
