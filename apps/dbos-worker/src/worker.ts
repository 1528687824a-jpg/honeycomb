import "dotenv/config";
import { launchDbos } from "../../orchestrator-api/src/dbos-runtime";

async function main() {
  await launchDbos();
  console.log("DBOS worker launched for workflow recovery");

  await new Promise(() => {
    // Keep this optional worker process alive for recovery-only runs.
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
