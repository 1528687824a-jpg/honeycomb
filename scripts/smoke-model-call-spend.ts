import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { upsertModelProvider } from "../packages/db/src/config-registry";
import { createJob, getJob } from "../packages/db/src/jobs";
import {
  claimModelCallSpendDispatch,
  markModelCallSpendOutcomeUnknown,
  releaseModelCallSpendByIdempotency,
  reserveModelCallSpend,
  reserveStandaloneModelSpend,
  settleModelCallSpend
} from "../packages/db/src/model-call-spend";
import { runMigrations } from "../packages/db/src/migrate";
import { closePool, pool } from "../packages/db/src/pool";

const marker = randomUUID().replace(/-/g, "");
const providerId = `spend-smoke-${marker}`;
const panelProviderId = `spend-panel-smoke-${marker}`;
const jobIds: string[] = [];
const previousUserLimit = process.env.HONEYCOMB_USER_DAILY_MAX_COST_USD;

function reservation(input: {
  jobId: string;
  requesterSuffix: string;
  routeIndex: number;
  routeAttemptNo?: number;
}) {
  const idempotencyKey = `${input.jobId}:${input.requesterSuffix}`;
  return reserveModelCallSpend({
    reservationKey: `${idempotencyKey}:route:${input.routeIndex}:attempt:${input.routeAttemptNo ?? 1}`,
    idempotencyKey,
    jobId: input.jobId,
    providerId,
    model: "image-smoke",
    agentId: "image-agent",
    actionType: "stage-agent",
    routeIndex: input.routeIndex,
    routeAttemptNo: input.routeAttemptNo ?? 1,
    kind: "image"
  });
}

async function makeJob(requesterId: string, maxCostUsd: number) {
  const job = await createJob({
    rawPrompt: `Spend ledger smoke ${marker}`,
    displayTitle: "Spend ledger smoke",
    ingressOrigin: "cli",
    requesterId,
    maxCostUsd
  });
  jobIds.push(job.id);
  return job;
}

async function main() {
  process.env.HONEYCOMB_USER_DAILY_MAX_COST_USD = "0.10";
  await runMigrations();
  await upsertModelProvider({
    id: providerId,
    displayName: "Spend smoke provider",
    baseUrl: "https://example.invalid/v1",
    defaultModel: "image-smoke",
    metadata: {
      pricing: {
        models: {
          "image-smoke": { perRequestUsd: 0.06 }
        }
      },
      spendLimits: { dailyUsd: 0.15 }
    }
  });
  await upsertModelProvider({
    id: panelProviderId,
    displayName: "Panel spend smoke provider",
    baseUrl: "https://example.invalid/v1",
    defaultModel: "panel-smoke",
    metadata: {
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      spendLimits: { dailyUsd: 1 }
    }
  });

  const lifecycle = await makeJob(`spend-lifecycle-${marker}`, 1);
  const first = await reservation({ jobId: lifecycle.id, requesterSuffix: "first", routeIndex: 0 });
  assert.equal(first.allowed, true);
  assert.equal(first.reservationUsd, 0.06);
  const reused = await reservation({ jobId: lifecycle.id, requesterSuffix: "first", routeIndex: 0 });
  assert.equal(reused.allowed, true);
  assert.equal(reused.reused, true);
  await markModelCallSpendOutcomeUnknown({
    idempotencyKey: `${lifecycle.id}:first`,
    note: "smoke_unknown"
  });
  assert.equal((await getJob(lifecycle.id))?.spendBudget.reservedUsd, 0.06);
  await releaseModelCallSpendByIdempotency({
    idempotencyKey: `${lifecycle.id}:first`,
    note: "smoke_confirmed_not_accepted"
  });
  assert.equal((await getJob(lifecycle.id))?.spendBudget.reservedUsd, 0);

  const settled = await reservation({ jobId: lifecycle.id, requesterSuffix: "settled", routeIndex: 1 });
  assert.equal(settled.allowed, true);
  await settleModelCallSpend({
    reservationKey: settled.record!.reservationKey,
    note: "smoke_success"
  });
  assert.equal((await getJob(lifecycle.id))?.spendBudget.settledUsd, 0.06);

  const concurrent = await makeJob(`spend-concurrent-${marker}`, 0.1);
  const concurrentResults = await Promise.all([
    reservation({ jobId: concurrent.id, requesterSuffix: "a", routeIndex: 0 }),
    reservation({ jobId: concurrent.id, requesterSuffix: "b", routeIndex: 1 })
  ]);
  assert.equal(concurrentResults.filter((entry) => entry.allowed).length, 1);
  assert.equal(concurrentResults.filter((entry) => entry.blockingScope === "job").length, 1);

  const userLimited = await makeJob(`spend-lifecycle-${marker}`, 1);
  const userResult = await reservation({ jobId: userLimited.id, requesterSuffix: "user", routeIndex: 0 });
  assert.equal(userResult.allowed, false);
  assert.equal(userResult.blockingScope, "user_daily");

  const providerLimited = await makeJob(`spend-provider-${marker}`, 1);
  const providerResult = await reservation({
    jobId: providerLimited.id,
    requesterSuffix: "provider",
    routeIndex: 0
  });
  assert.equal(providerResult.allowed, false);
  assert.equal(providerResult.blockingScope, "provider_daily");

  const panelReservationKey = `panel:spend-smoke-${marker}`;
  const panelSpend = await reserveStandaloneModelSpend({
    reservationKey: panelReservationKey,
    requesterId: `panel-requester-${marker}`,
    providerId: panelProviderId,
    model: "panel-smoke",
    agentId: "panel-agent",
    actionType: "panel-chat",
    kind: "chat",
    inputTokenCeiling: 1_000,
    outputTokenCeiling: 900
  });
  assert.equal(panelSpend.allowed, true);
  const panelDispatch = await claimModelCallSpendDispatch({
    reservationKey: panelReservationKey,
    note: "panel_smoke_dispatch_started"
  });
  assert.equal(panelDispatch?.status, "outcome_unknown");
  assert.equal(
    await claimModelCallSpendDispatch({ reservationKey: panelReservationKey }),
    null
  );
  await settleModelCallSpend({
    reservationKey: panelReservationKey,
    usage: { promptTokens: 100, completionTokens: 100 },
    note: "panel_smoke_success"
  });
  const panelLedger = await pool.query(
    `select job_id, status, actual_usd from agent.model_call_spend where reservation_key = $1`,
    [panelReservationKey]
  );
  assert.equal(panelLedger.rows[0]?.job_id, null);
  assert.equal(panelLedger.rows[0]?.status, "settled");
  assert.equal(Number(panelLedger.rows[0]?.actual_usd), 0.0002);

  console.log(JSON.stringify({
    ok: true,
    jobs: jobIds,
    checked: [
      "idempotent_reservation",
      "unknown_outcome_commitment",
      "known_failure_release",
      "fixed_request_settlement",
      "concurrent_job_limit",
      "user_daily_limit",
      "provider_daily_limit",
      "panel_agent_daily_spend_ledger",
      "panel_agent_single_dispatch_claim"
    ]
  }, null, 2));
}

async function cleanup() {
  if (jobIds.length > 0) {
    await pool.query(`delete from agent.model_call_spend where job_id = any($1::text[])`, [jobIds]);
    await pool.query(`delete from agent.job_events where job_id = any($1::text[])`, [jobIds]);
    await pool.query(`delete from agent.jobs where id = any($1::text[])`, [jobIds]);
  }
  await pool.query(`delete from agent.model_providers where id = $1`, [providerId]);
  await pool.query(`delete from agent.model_call_spend where provider_id = $1`, [panelProviderId]);
  await pool.query(`delete from agent.model_providers where id = $1`, [panelProviderId]);
  if (previousUserLimit === undefined) {
    delete process.env.HONEYCOMB_USER_DAILY_MAX_COST_USD;
  } else {
    process.env.HONEYCOMB_USER_DAILY_MAX_COST_USD = previousUserLimit;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error(error));
    await closePool();
  });
