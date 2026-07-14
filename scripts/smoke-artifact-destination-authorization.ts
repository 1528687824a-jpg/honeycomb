import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  artifactDestinationRootKey,
  normalizeArtifactDestinationRootPath
} from "../packages/shared/src/artifact-destination-policy";
import { createToolApprovalRequest, decideToolApproval } from "../packages/db/src/approvals";
import {
  revokeArtifactDestinationGrant,
  upsertArtifactDestinationGrant
} from "../packages/db/src/artifact-destination-grants";
import {
  claimArtifactDelivery,
  completeArtifactDelivery,
  ensureArtifactDelivery,
  upsertArtifactFile
} from "../packages/db/src/artifact-deliveries";
import { createJob } from "../packages/db/src/jobs";
import { runMigrations } from "../packages/db/src/migrate";
import { createArtifact } from "../packages/db/src/pipeline";
import { closePool, pool } from "../packages/db/src/pool";
import { upsertRegisteredWorkspace } from "../packages/db/src/workspace-registry";

const marker = randomUUID().replace(/-/g, "");
let jobId: string | null = null;
let workspaceId: string | null = null;
const grantIds: string[] = [];
let tempRoot: string | null = null;

async function approvedGrantApproval(job: Awaited<ReturnType<typeof createJob>>, rootPath: string) {
  const approval = await createToolApprovalRequest({
    jobId: job.id,
    agentId: "panel-agent",
    requesterActor: "artifact-destination-smoke",
    toolName: "artifact.destination.grant",
    actionType: "artifact_destination_grant",
    riskLevel: "high",
    reason: "Artifact destination authorization smoke",
    target: `artifact-destination://${artifactDestinationRootKey(rootPath)}`,
    command: `Grant artifact delivery to ${normalizeArtifactDestinationRootPath(rootPath)}`,
    input: { rootPath }
  });
  assert.ok(approval);
  const decision = await decideToolApproval({
    approvalId: approval.id,
    status: "approved",
    decidedBy: "artifact-destination-smoke",
    decisionReason: "Explicit smoke authorization"
  });
  assert.equal(decision.approval?.status, "approved");
  return approval;
}

async function main() {
  await runMigrations();
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "honeycomb-destination-smoke-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const customRoot = path.join(tempRoot, "custom");
  const customTarget = path.join(customRoot, "campaign");
  await Promise.all([
    mkdir(path.join(workspaceRoot, "exports"), { recursive: true }),
    mkdir(customTarget, { recursive: true })
  ]);

  const job = await createJob({
    rawPrompt: `Artifact destination authorization smoke ${marker}`,
    displayTitle: "Artifact destination authorization smoke",
    ingressOrigin: "cli",
    workdir: workspaceRoot
  });
  jobId = job.id;
  const artifact = await createArtifact({
    id: `${job.id}-ART-DESTINATION-SMOKE`,
    jobId: job.id,
    type: "stage_output",
    title: "Destination authorization smoke source",
    content: "{}"
  });
  const checksum = "b".repeat(64);
  const file = await upsertArtifactFile({
    id: `${artifact.id}-FILE-01`,
    artifactId: artifact.id,
    jobId: job.id,
    kind: "image",
    status: "available",
    filePath: path.join(tempRoot, "source.png"),
    fileName: "source.png",
    mimeType: "image/png",
    format: "png",
    sizeBytes: 128,
    width: 1080,
    height: 1920,
    checksumSha256: checksum,
    source: "smoke"
  });

  const workspaceDelivery = await ensureArtifactDelivery({
    id: `${job.id}-DELIVERY-WORKSPACE`,
    jobId: job.id,
    artifactFileId: file.id,
    deliverableIndex: 0,
    required: true,
    target: "workspace",
    targetPath: "exports",
    requestedFileName: "workspace-poster.png",
    expectedSizeBytes: 128,
    expectedChecksumSha256: checksum
  });
  assert.equal(workspaceDelivery.authorizationStatus, "required");
  assert.equal((await claimArtifactDelivery({ jobId: job.id, deliveryId: workspaceDelivery.id })).claimed, false);

  const workspace = await upsertRegisteredWorkspace({
    id: `workspace-destination-smoke-${marker}`,
    rootPath: normalizeArtifactDestinationRootPath(workspaceRoot),
    rootPathKey: artifactDestinationRootKey(workspaceRoot),
    displayName: "Artifact destination smoke workspace",
    registeredBy: "artifact-destination-smoke"
  });
  workspaceId = workspace.id;
  const workspaceClaim = await claimArtifactDelivery({ jobId: job.id, deliveryId: workspaceDelivery.id });
  assert.equal(workspaceClaim.claimed, true);
  assert.equal(workspaceClaim.delivery?.authorizationKind, "registered_workspace");
  const outsideReceipt = await completeArtifactDelivery({
    jobId: job.id,
    deliveryId: workspaceDelivery.id,
    claimToken: workspaceClaim.claimToken!,
    deliveredPath: path.join(tempRoot, "outside", "workspace-poster.png"),
    deliveredSizeBytes: 128,
    deliveredChecksumSha256: checksum
  });
  assert.equal(outsideReceipt.completed, false);
  assert.equal(outsideReceipt.rejectionReason, "delivery_path_outside_destination");
  assert.equal((await completeArtifactDelivery({
    jobId: job.id,
    deliveryId: workspaceDelivery.id,
    claimToken: workspaceClaim.claimToken!,
    deliveredPath: path.join(workspaceRoot, "exports", "workspace-poster.png"),
    deliveredSizeBytes: 128,
    deliveredChecksumSha256: checksum
  })).completed, true);

  const customDelivery = await ensureArtifactDelivery({
    id: `${job.id}-DELIVERY-CUSTOM`,
    jobId: job.id,
    artifactFileId: file.id,
    deliverableIndex: 1,
    required: true,
    target: "custom",
    targetPath: customTarget,
    requestedFileName: "custom-poster.png",
    expectedSizeBytes: 128,
    expectedChecksumSha256: checksum
  });
  assert.equal(customDelivery.authorizationStatus, "required");
  const firstApproval = await approvedGrantApproval(job, customRoot);
  const firstGrant = await upsertArtifactDestinationGrant({
    rootPath: normalizeArtifactDestinationRootPath(customRoot),
    rootPathKey: artifactDestinationRootKey(customRoot),
    approvalId: firstApproval.id,
    grantedBy: "artifact-destination-smoke"
  });
  grantIds.push(firstGrant.id);
  const customClaim = await claimArtifactDelivery({ jobId: job.id, deliveryId: customDelivery.id });
  assert.equal(customClaim.claimed, true);
  assert.equal(customClaim.delivery?.authorizationKind, "custom_grant");
  await revokeArtifactDestinationGrant(firstGrant.id);
  assert.equal((await completeArtifactDelivery({
    jobId: job.id,
    deliveryId: customDelivery.id,
    claimToken: customClaim.claimToken!,
    deliveredPath: path.join(customTarget, "custom-poster.png"),
    deliveredSizeBytes: 128,
    deliveredChecksumSha256: checksum
  })).completed, true);

  const secondApproval = await approvedGrantApproval(job, customRoot);
  const secondGrant = await upsertArtifactDestinationGrant({
    rootPath: normalizeArtifactDestinationRootPath(customRoot),
    rootPathKey: artifactDestinationRootKey(customRoot),
    approvalId: secondApproval.id,
    grantedBy: "artifact-destination-smoke"
  });
  if (!grantIds.includes(secondGrant.id)) grantIds.push(secondGrant.id);
  const revokedBeforeClaim = await ensureArtifactDelivery({
    id: `${job.id}-DELIVERY-REVOKED`,
    jobId: job.id,
    artifactFileId: file.id,
    deliverableIndex: 2,
    required: true,
    target: "custom",
    targetPath: customTarget,
    requestedFileName: "revoked-poster.png",
    expectedSizeBytes: 128,
    expectedChecksumSha256: checksum
  });
  assert.equal(revokedBeforeClaim.authorizationStatus, "authorized");
  await revokeArtifactDestinationGrant(secondGrant.id);
  const revokedClaim = await claimArtifactDelivery({ jobId: job.id, deliveryId: revokedBeforeClaim.id });
  assert.equal(revokedClaim.claimed, false);
  assert.equal(revokedClaim.delivery?.authorizationStatus, "revoked");

  console.log(JSON.stringify({
    ok: true,
    jobId: job.id,
    checked: [
      "workspace_requires_registration",
      "workspace_authorization_refresh",
      "receipt_path_boundary",
      "custom_requires_separate_grant",
      "leased_delivery_survives_revocation",
      "revocation_blocks_unclaimed_delivery"
    ]
  }, null, 2));
}

async function cleanup() {
  if (jobId) {
    await pool.query(`delete from agent.artifact_deliveries where job_id = $1`, [jobId]);
    await pool.query(`delete from agent.artifact_files where job_id = $1`, [jobId]);
    await pool.query(`delete from agent.artifacts where job_id = $1`, [jobId]);
  }
  for (const grantId of grantIds) {
    await pool.query(`delete from agent.artifact_destination_grants where id = $1`, [grantId]);
  }
  if (workspaceId) {
    await pool.query(`delete from agent.registered_workspaces where id = $1`, [workspaceId]);
  }
  if (jobId) {
    await pool.query(`delete from agent.tool_approval_requests where job_id = $1`, [jobId]);
    await pool.query(`delete from agent.job_events where job_id = $1`, [jobId]);
    await pool.query(`delete from agent.jobs where id = $1`, [jobId]);
  }
  if (tempRoot) {
    const resolved = path.resolve(tempRoot);
    const temp = path.resolve(os.tmpdir());
    if (resolved !== temp && resolved.startsWith(`${temp}${path.sep}`)) {
      await rm(resolved, { recursive: true, force: true });
    }
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
