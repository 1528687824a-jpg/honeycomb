import { createHash } from "node:crypto";
import {
  JOB_EXECUTION_SUMMARY_QUERY_VERSION,
  projectJobExecutionSummary,
  type JobExecutionSummary,
  type JobExecutionSummaryQueryResponse
} from "../../shared/src/job-execution-summary";
import type { JobExecutionState } from "../../shared/src/job-execution-state";
import { getJobExecutionStates } from "./job-execution-state";

export function createJobExecutionSummary(state: JobExecutionState): JobExecutionSummary {
  const draft = projectJobExecutionSummary(state);
  const revision = createHash("sha256").update(JSON.stringify(draft), "utf8").digest("hex");
  return { ...draft, revision };
}

export function selectChangedJobExecutionSummaries(
  summaries: JobExecutionSummary[],
  knownRevisions: Record<string, string> = {}
) {
  const changed: JobExecutionSummary[] = [];
  const unchangedJobIds: string[] = [];
  for (const summary of summaries) {
    if (knownRevisions[summary.jobId] === summary.revision) {
      unchangedJobIds.push(summary.jobId);
    } else {
      changed.push(summary);
    }
  }
  return { changed, unchangedJobIds };
}

export async function queryJobExecutionSummaries(input: {
  jobIds: string[];
  knownRevisions?: Record<string, string>;
}): Promise<JobExecutionSummaryQueryResponse> {
  const jobIds = [...new Set(input.jobIds.map((jobId) => jobId.trim()).filter(Boolean))];
  if (jobIds.length > 200) throw new Error("job_execution_summary_batch_too_large");
  const states = await getJobExecutionStates(jobIds);
  const summaries = states.map(createJobExecutionSummary);
  const foundIds = new Set(summaries.map((summary) => summary.jobId));
  const { changed, unchangedJobIds } = selectChangedJobExecutionSummaries(
    summaries,
    input.knownRevisions
  );

  return {
    version: JOB_EXECUTION_SUMMARY_QUERY_VERSION,
    generatedAt: states[0]?.generatedAt ?? new Date().toISOString(),
    requested: jobIds.length,
    returned: changed.length,
    summaries: changed,
    unchangedJobIds,
    missingJobIds: jobIds.filter((jobId) => !foundIds.has(jobId)),
    revisions: Object.fromEntries(summaries.map((summary) => [summary.jobId, summary.revision]))
  };
}
