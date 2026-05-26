import "dotenv/config";
import { Pool } from "pg";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://temporal:temporal@localhost:5432/temporal";

export const pool = new Pool({ connectionString });

export async function closePool() {
  await pool.end();
}
