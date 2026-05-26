import "dotenv/config";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool, pool } from "../packages/db/src/pool";

const apply = process.argv.includes("--apply");

function resolveJobDataRoot() {
  return path.resolve(process.env.JOB_DATA_DIR ?? "data/jobs");
}

function assertInsideRoot(root: string, target: string) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside JOB_DATA_DIR: ${target}`);
  }
}

async function main() {
  const root = resolveJobDataRoot();
  const result = await pool.query(
    `select id, workdir, retention_until
     from agent.jobs
     where archived_at is not null
       and retention_until is not null
       and retention_until <= now()
       and cleanup_status in ('retained', 'eligible', 'cleanup_failed')
     order by retention_until asc
     limit 50`
  );

  const candidates = result.rows.map((row) => ({
    id: row.id as string,
    workdir: path.resolve(row.workdir ?? path.join(root, row.id)),
    retentionUntil: row.retention_until?.toISOString?.() ?? String(row.retention_until)
  }));

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          candidateCount: candidates.length,
          candidates,
          note: "Run with --apply to remove per-job stages/ and state/ directories after writing archive/session-summary.json. Long-term experience files are never touched."
        },
        null,
        2
      )
    );
    return;
  }

  for (const candidate of candidates) {
    assertInsideRoot(root, candidate.workdir);

    const archiveDir = path.join(candidate.workdir, "archive");
    await mkdir(archiveDir, { recursive: true });

    const summary = await pool.query(
      `select
        j.id,
        j.status,
        j.final_output,
        j.created_at,
        j.completed_at,
        j.archived_at,
        j.retention_until,
        count(distinct s.id) as stage_count,
        count(distinct r.id) as review_count,
        count(distinct gm.id) as group_message_count,
        count(distinct ae.id) as agent_event_count
      from agent.jobs j
      left join agent.job_stages s on s.job_id = j.id
      left join agent.test_reviews r on r.stage_id = s.id
      left join agent.group_messages gm on gm.job_id = j.id
      left join agent.agent_events ae on ae.job_id = j.id
      where j.id = $1
      group by j.id`,
      [candidate.id]
    );

    await writeFile(
      path.join(archiveDir, "session-summary.json"),
      `${JSON.stringify(summary.rows[0] ?? { id: candidate.id }, null, 2)}\n`,
      "utf8"
    );

    await rm(path.join(candidate.workdir, "stages"), { recursive: true, force: true });
    await rm(path.join(candidate.workdir, "state"), { recursive: true, force: true });

    await pool.query(
      `update agent.jobs
       set cleanup_status = 'cleaned', updated_at = now()
       where id = $1`,
      [candidate.id]
    );

    await pool.query(
      `insert into agent.job_events (job_id, event_type, payload)
       values ($1, 'job.cleanup_completed', $2::jsonb)`,
      [
        candidate.id,
        JSON.stringify({
          cleanedPaths: ["stages", "state"],
          preservedPaths: ["archive/session-summary.json", "final", "plan", "logs", "agent-work-log.md"],
          neverTouched: ["经验库-*.md", "OpenClaw workspace lessons"]
        })
      ]
    );
  }

  console.log(JSON.stringify({ mode: "apply", cleanedCount: candidates.length }, null, 2));
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);

