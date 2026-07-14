import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  claimArtifactDelivery,
  claimJobArtifactDeliveryFinalization,
  completeArtifactDelivery,
  ensureArtifactDelivery,
  failArtifactDelivery,
  getArtifactDeliverySummary,
  upsertArtifactFile
} from "../packages/db/src/artifact-deliveries";
import { createJob, getJob, setJobFinalOutput, setJobStatus, setJobWorkflowId } from "../packages/db/src/jobs";
import { runMigrations } from "../packages/db/src/migrate";
import { createArtifact } from "../packages/db/src/pipeline";
import { closePool, pool } from "../packages/db/src/pool";

const marker = randomUUID().replace(/-/g, "");
let jobId: string | null = null;

async function main() {
  await runMigrations();
  const job = await createJob({
    rawPrompt: `Artifact delivery smoke ${marker}`,
    displayTitle: "Artifact delivery smoke",
    ingressOrigin: "cli"
  });
  jobId = job.id;
  const artifact = await createArtifact({
    id: `${job.id}-ART-SMOKE`,
    jobId: job.id,
    type: "stage_output",
    title: "Artifact delivery smoke source",
    content: "{}"
  });
  const checksum = "a".repeat(64);
  const file = await upsertArtifactFile({
    id: `${artifact.id}-FILE-01`,
    artifactId: artifact.id,
    jobId: job.id,
    kind: "image",
    status: "available",
    filePath: `/app/data/jobs/${job.id}/poster.png`,
    fileName: "poster.png",
    mimeType: "image/png",
    format: "png",
    sizeBytes: 128,
    width: 1080,
    height: 1920,
    checksumSha256: checksum,
    source: "base64"
  });
  const delivery = await ensureArtifactDelivery({
    id: `${job.id}-DELIVERY-01`,
    jobId: job.id,
    artifactFileId: file.id,
    deliverableIndex: 0,
    required: true,
    target: "desktop",
    requestedFileName: "poster.png",
    expectedSizeBytes: 128,
    expectedChecksumSha256: checksum
  });
  const documentChecksum = "b".repeat(64);
  const documentFile = await upsertArtifactFile({
    id: `${artifact.id}-FILE-02`,
    artifactId: artifact.id,
    jobId: job.id,
    kind: "document",
    status: "available",
    filePath: `/app/data/jobs/${job.id}/report.docx`,
    fileName: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    format: "docx",
    sizeBytes: 256,
    checksumSha256: documentChecksum,
    source: "honeycomb-document-normalizer"
  });
  const documentDelivery = await ensureArtifactDelivery({
    id: `${job.id}-DELIVERY-02`,
    jobId: job.id,
    artifactFileId: documentFile.id,
    deliverableIndex: 1,
    required: true,
    target: "desktop",
    requestedFileName: "report.docx",
    expectedSizeBytes: 256,
    expectedChecksumSha256: documentChecksum
  });
  assert.equal((await getArtifactDeliverySummary(job.id)).readyToFinalize, false);

  const concurrentClaims = await Promise.all([
    claimArtifactDelivery({ jobId: job.id, deliveryId: delivery.id }),
    claimArtifactDelivery({ jobId: job.id, deliveryId: delivery.id })
  ]);
  assert.equal(concurrentClaims.filter((claim) => claim.claimed).length, 1);
  const firstClaim = concurrentClaims.find((claim) => claim.claimed)!;
  const rejectedReceipt = await completeArtifactDelivery({
    jobId: job.id,
    deliveryId: delivery.id,
    claimToken: firstClaim.claimToken!,
    deliveredPath: "C:\\Desktop\\poster.png",
    deliveredSizeBytes: 127,
    deliveredChecksumSha256: checksum
  });
  assert.equal(rejectedReceipt.completed, false);
  assert.equal((await failArtifactDelivery({
    jobId: job.id,
    deliveryId: delivery.id,
    claimToken: firstClaim.claimToken!,
    error: "smoke_receipt_mismatch"
  })).failed, true);

  const retryClaim = await claimArtifactDelivery({
    jobId: job.id,
    deliveryId: delivery.id,
    retryDelaySeconds: 0
  });
  assert.equal(retryClaim.claimed, true);
  const completed = await completeArtifactDelivery({
    jobId: job.id,
    deliveryId: delivery.id,
    claimToken: retryClaim.claimToken!,
    deliveredPath: "C:\\Desktop\\poster.png",
    deliveredSizeBytes: 128,
    deliveredChecksumSha256: checksum.toUpperCase()
  });
  assert.equal(completed.completed, true);
  assert.equal((await getArtifactDeliverySummary(job.id)).readyToFinalize, false);

  const documentClaim = await claimArtifactDelivery({
    jobId: job.id,
    deliveryId: documentDelivery.id
  });
  assert.equal(documentClaim.claimed, true);
  assert.equal((await completeArtifactDelivery({
    jobId: job.id,
    deliveryId: documentDelivery.id,
    claimToken: documentClaim.claimToken!,
    deliveredPath: "C:\\Desktop\\report.docx",
    deliveredSizeBytes: 256,
    deliveredChecksumSha256: documentChecksum
  })).completed, true);
  assert.equal((await getArtifactDeliverySummary(job.id)).readyToFinalize, true);

  await setJobStatus(job.id, "waiting_for_human", { reason: "artifact_delivery_pending" });
  assert.equal(await claimJobArtifactDeliveryFinalization(job.id), true);
  assert.equal(await claimJobArtifactDeliveryFinalization(job.id), false);

  await setJobFinalOutput(job.id, "artifact delivery smoke complete");
  await setJobWorkflowId(job.id, `late-workflow-${marker}`);
  assert.equal((await getJob(job.id))?.status, "succeeded");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    checked: [
      "canonical_artifact_file",
      "canonical_document_artifact_file",
      "single_concurrent_delivery_claim",
      "receipt_size_and_checksum_gate",
      "failed_delivery_retry",
      "all_required_media_and_document_deliveries_gate_finalization",
      "single_finalization_claim",
      "late_workflow_write_preserves_terminal_status"
    ]
  }, null, 2));
}

async function cleanup() {
  if (!jobId) return;
  await pool.query(`delete from agent.artifact_deliveries where job_id = $1`, [jobId]);
  await pool.query(`delete from agent.artifact_files where job_id = $1`, [jobId]);
  await pool.query(`delete from agent.artifacts where job_id = $1`, [jobId]);
  await pool.query(`delete from agent.job_events where job_id = $1`, [jobId]);
  await pool.query(`delete from agent.jobs where id = $1`, [jobId]);
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
