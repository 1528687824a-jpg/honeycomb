import "dotenv/config";
import { closePool, pool } from "./pool";

const maxAttempts = Number(process.env.POSTGRES_WAIT_ATTEMPTS ?? 60);
const delayMs = Number(process.env.POSTGRES_WAIT_DELAY_MS ?? 1000);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query("select 1");
      console.log("Postgres is ready");
      return;
    } catch (error) {
      lastError = error;
      console.log(`Waiting for Postgres (${attempt}/${maxAttempts})`);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Postgres did not become ready");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
