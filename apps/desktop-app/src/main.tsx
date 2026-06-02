import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  cancelJob,
  createJob,
  getHealth,
  getJob,
  getJobTimeline,
  listJobs,
  type JobRecord,
  type JobStatus,
  type JobTimeline,
  type ListJobsResponse,
  type RoutingMode
} from "./api";
import "./styles.css";

type ApiState = "checking" | "online" | "offline";
type JobStatusFilter = "all" | "running" | "waiting_for_human" | "cancelled";
type JobTimeFilter = "all" | "24h" | "7d" | "custom";
type Language = "en" | "zh";

const routingModes: RoutingMode[] = [
  "supervisor_pipeline",
  "pipeline",
  "classic_master_slave",
  "master_slave_discussion"
];

const cancellableStatuses: JobStatus[] = [
  "created",
  "queued",
  "planning",
  "running",
  "testing",
  "fixing",
  "waiting_for_human"
];

const jobStatusFilters: Array<{ id: JobStatusFilter; status?: JobStatus }> = [
  { id: "all" },
  { id: "running", status: "running" },
  { id: "waiting_for_human", status: "waiting_for_human" },
  { id: "cancelled", status: "cancelled" }
];

const jobTimeFilters: Array<{ id: JobTimeFilter }> = [
  { id: "all" },
  { id: "24h" },
  { id: "7d" },
  { id: "custom" }
];

const languageOptions: Array<{ id: Language; label: string }> = [
  { id: "en", label: "English" },
  { id: "zh", label: "中文" }
];

const translations = {
  en: {
    subtitle: "Local multi-agent control console",
    apiOnline: "API online",
    apiOffline: "API offline",
    apiChecking: "Checking API",
    refresh: "Refresh",
    languageLabel: "Language",
    newJob: "New Job",
    routing: "Routing",
    budget: "Budget",
    startJob: "Start Job",
    jobs: "Jobs",
    jobStatusFilter: "Job status filter",
    jobTimeFilter: "Job created time filter",
    searchPrompts: "Search prompts",
    searchPromptsAria: "Search job prompts",
    since: "Since",
    until: "Until",
    noJobsMatch: "No jobs match.",
    loadMore: "Load More",
    noJobSelected: "No job selected",
    cancel: "Cancel",
    cancelled: "Cancelled",
    status: "Status",
    created: "Created",
    timeline: "Timeline",
    noJobLoaded: "No job loaded.",
    latestItems: "latest items",
    complete: "complete",
    noTimelineEvents: "No timeline events.",
    statusFilters: {
      all: "All",
      running: "Running",
      waiting_for_human: "Waiting",
      cancelled: "Cancelled"
    },
    timeFilters: {
      all: "All Time",
      "24h": "24h",
      "7d": "7d",
      custom: "Custom"
    },
    statuses: {
      created: "created",
      queued: "queued",
      planning: "planning",
      running: "running",
      testing: "testing",
      fixing: "fixing",
      waiting_for_human: "waiting",
      succeeded: "succeeded",
      failed: "failed",
      cancelled: "cancelled"
    },
    sources: {
      job_event: "job event",
      agent_event: "agent event",
      group_message: "group message",
      stage_attempt: "stage attempt",
      test_review: "test review",
      artifact: "artifact"
    }
  },
  zh: {
    subtitle: "本地多 Agent 控制台",
    apiOnline: "API 在线",
    apiOffline: "API 离线",
    apiChecking: "正在检查 API",
    refresh: "刷新",
    languageLabel: "语言",
    newJob: "新任务",
    routing: "编排模式",
    budget: "预算",
    startJob: "启动任务",
    jobs: "任务",
    jobStatusFilter: "任务状态筛选",
    jobTimeFilter: "任务创建时间筛选",
    searchPrompts: "搜索任务提示词",
    searchPromptsAria: "搜索任务提示词",
    since: "开始",
    until: "结束",
    noJobsMatch: "没有匹配的任务。",
    loadMore: "加载更多",
    noJobSelected: "未选择任务",
    cancel: "取消",
    cancelled: "已取消",
    status: "状态",
    created: "创建时间",
    timeline: "时间线",
    noJobLoaded: "没有加载任务。",
    latestItems: "最新事件",
    complete: "完整",
    noTimelineEvents: "没有时间线事件。",
    statusFilters: {
      all: "全部",
      running: "运行中",
      waiting_for_human: "等待",
      cancelled: "已取消"
    },
    timeFilters: {
      all: "全部时间",
      "24h": "24 小时",
      "7d": "7 天",
      custom: "自定义"
    },
    statuses: {
      created: "已创建",
      queued: "排队中",
      planning: "规划中",
      running: "运行中",
      testing: "测试中",
      fixing: "修复中",
      waiting_for_human: "等待人工",
      succeeded: "已成功",
      failed: "已失败",
      cancelled: "已取消"
    },
    sources: {
      job_event: "任务事件",
      agent_event: "Agent 事件",
      group_message: "群消息",
      stage_attempt: "阶段尝试",
      test_review: "测试评审",
      artifact: "产物"
    }
  }
} satisfies Record<
  Language,
  {
    subtitle: string;
    apiOnline: string;
    apiOffline: string;
    apiChecking: string;
    refresh: string;
    languageLabel: string;
    newJob: string;
    routing: string;
    budget: string;
    startJob: string;
    jobs: string;
    jobStatusFilter: string;
    jobTimeFilter: string;
    searchPrompts: string;
    searchPromptsAria: string;
    since: string;
    until: string;
    noJobsMatch: string;
    loadMore: string;
    noJobSelected: string;
    cancel: string;
    cancelled: string;
    status: string;
    created: string;
    timeline: string;
    noJobLoaded: string;
    latestItems: string;
    complete: string;
    noTimelineEvents: string;
    statusFilters: Record<JobStatusFilter, string>;
    timeFilters: Record<JobTimeFilter, string>;
    statuses: Record<JobStatus, string>;
    sources: Record<JobTimeline["timeline"][number]["source"], string>;
  }
>;

function getInitialLanguage(): Language {
  const queryLanguage = new URLSearchParams(window.location.search).get("lang");
  if (queryLanguage === "zh" || queryLanguage === "en") {
    return queryLanguage;
  }
  const storedLanguage = window.localStorage.getItem("agentOpenClaw.language");
  return storedLanguage === "zh" ? "zh" : "en";
}

function formatTime(value: string | null | undefined, language: Language) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function compactEventType(value: string) {
  return value.replace(/^job\./, "").replace(/^stage\./, "").replace(/^group\./, "");
}

function isCancellable(job: JobRecord | null) {
  return job ? cancellableStatuses.includes(job.status) : false;
}

function statusTone(status: JobStatus) {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "waiting_for_human") return "warn";
  return "active";
}

function localDateTimeToIso(value: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function App() {
  const [language, setLanguage] = useState<Language>(getInitialLanguage);
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [prompt, setPrompt] = useState("Draft a short launch note for a tiny multi-agent product.");
  const [routingMode, setRoutingMode] = useState<RoutingMode>("supervisor_pipeline");
  const [maxModelCalls, setMaxModelCalls] = useState(20);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [jobListPage, setJobListPage] = useState<ListJobsResponse["page"] | null>(null);
  const [jobStatusFilter, setJobStatusFilter] = useState<JobStatusFilter>("all");
  const [jobTimeFilter, setJobTimeFilter] = useState<JobTimeFilter>("all");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  const [jobPromptFilter, setJobPromptFilter] = useState("");
  const [selectedJobId, setSelectedJobId] = useState("");
  const [selectedJob, setSelectedJob] = useState<JobRecord | null>(null);
  const [timeline, setTimeline] = useState<JobTimeline | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobsRequestSeq = useRef(0);
  const copy = translations[language];

  const statusText = useMemo(() => {
    if (apiState === "online") return copy.apiOnline;
    if (apiState === "offline") return copy.apiOffline;
    return copy.apiChecking;
  }, [apiState, copy]);

  const selectedFromList = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? selectedJob,
    [jobs, selectedJob, selectedJobId]
  );

  const activeStatusFilter = jobStatusFilters.find((filter) => filter.id === jobStatusFilter);
  const trimmedJobPromptFilter = jobPromptFilter.trim();

  useEffect(() => {
    window.localStorage.setItem("agentOpenClaw.language", language);
  }, [language]);

  function getJobTimeWindow() {
    if (jobTimeFilter === "24h") {
      return { since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), until: undefined };
    }
    if (jobTimeFilter === "7d") {
      return { since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), until: undefined };
    }
    if (jobTimeFilter === "custom") {
      return {
        since: localDateTimeToIso(customSince),
        until: localDateTimeToIso(customUntil)
      };
    }
    return { since: undefined, until: undefined };
  }

  async function refreshJobs(preferredJobId = selectedJobId) {
    const requestSeq = ++jobsRequestSeq.current;
    const timeWindow = getJobTimeWindow();
    const response = await listJobs({
      limit: 50,
      status: activeStatusFilter?.status,
      prompt: trimmedJobPromptFilter || undefined,
      since: timeWindow.since,
      until: timeWindow.until,
      sort: "createdAt",
      order: "desc"
    });
    if (requestSeq !== jobsRequestSeq.current) {
      return selectedJobId;
    }

    setJobs(response.jobs);
    setJobListPage(response.page);
    const nextSelectedId = response.jobs.some((job) => job.id === preferredJobId)
      ? preferredJobId
      : response.jobs[0]?.id || "";
    setSelectedJobId(nextSelectedId);
    return nextSelectedId;
  }

  async function loadMoreJobs() {
    if (!jobListPage?.nextCursor) return;
    setBusy(true);
    setError(null);
    try {
      const requestSeq = ++jobsRequestSeq.current;
      const timeWindow = getJobTimeWindow();
      const response = await listJobs({
        limit: 50,
        status: activeStatusFilter?.status,
        prompt: trimmedJobPromptFilter || undefined,
        since: timeWindow.since,
        until: timeWindow.until,
        sort: "createdAt",
        order: "desc",
        cursor: jobListPage.nextCursor
      });
      if (requestSeq !== jobsRequestSeq.current) {
        return;
      }

      setJobs((currentJobs) => {
        const existingIds = new Set(currentJobs.map((job) => job.id));
        return [...currentJobs, ...response.jobs.filter((job) => !existingIds.has(job.id))];
      });
      setJobListPage(response.page);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function refreshJob(targetJobId = selectedJobId) {
    if (!targetJobId) {
      setSelectedJob(null);
      setTimeline(null);
      return;
    }

    const timelineCursor =
      timeline?.job.id === targetJobId && timeline.summary.nextCursor
        ? timeline.summary.nextCursor
        : undefined;
    const [job, nextTimeline] = await Promise.all([
      getJob(targetJobId),
      getJobTimeline(targetJobId, 500, undefined, timelineCursor)
    ]);
    setSelectedJob(job);
    setTimeline((currentTimeline) => {
      if (!timelineCursor || currentTimeline?.job.id !== targetJobId) {
        return nextTimeline;
      }

      const existingIds = new Set(currentTimeline.timeline.map((item) => item.id));
      const appendedItems = nextTimeline.timeline.filter((item) => !existingIds.has(item.id));
      return {
        ...nextTimeline,
        timeline: [...currentTimeline.timeline, ...appendedItems]
      };
    });
  }

  async function refreshAll(targetJobId = selectedJobId) {
    const nextSelectedId = await refreshJobs(targetJobId);
    await refreshJob(nextSelectedId);
  }

  async function submitJob() {
    setBusy(true);
    setError(null);
    try {
      const created = await createJob({
        prompt,
        routingMode,
        maxModelCalls
      });
      await refreshAll(created.jobId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function cancelSelectedJob() {
    if (!selectedJobId) return;
    setBusy(true);
    setError(null);
    try {
      await cancelJob(selectedJobId);
      await refreshAll(selectedJobId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    getHealth()
      .then(() => {
        setApiState("online");
        return refreshAll();
      })
      .catch(() => setApiState("offline"));
  }, []);

  useEffect(() => {
    if (!selectedJobId || apiState !== "online") return;
    refreshJob(selectedJobId).catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught))
    );
  }, [selectedJobId, apiState]);

  useEffect(() => {
    if (apiState !== "online") return;
    const interval = window.setInterval(() => {
      refreshAll(selectedJobId).catch(() => {
        setApiState("offline");
      });
    }, 4000);
    return () => window.clearInterval(interval);
  }, [apiState, selectedJobId, jobStatusFilter, jobTimeFilter, customSince, customUntil, trimmedJobPromptFilter]);

  useEffect(() => {
    if (apiState !== "online") return;
    refreshAll("").catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [jobStatusFilter, jobTimeFilter, customSince, customUntil, trimmedJobPromptFilter, apiState]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Agent OpenClaw</h1>
          <p>{copy.subtitle}</p>
        </div>
        <div className="topbarActions">
          <div className="languageToggle" role="group" aria-label={copy.languageLabel}>
            {languageOptions.map((option) => (
              <button
                key={option.id}
                className={option.id === language ? "languageButton active" : "languageButton"}
                type="button"
                onClick={() => setLanguage(option.id)}
                aria-pressed={option.id === language}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className={`status ${apiState}`}>{statusText}</span>
          <button
            className="secondaryButton"
            type="button"
            onClick={() => refreshAll().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))}
            disabled={apiState !== "online" || busy}
          >
            {copy.refresh}
          </button>
        </div>
      </header>

      <section className="composerBand">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            submitJob();
          }}
        >
          <label htmlFor="prompt">{copy.newJob}</label>
          <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <div className="composerControls">
            <label htmlFor="routingMode">{copy.routing}</label>
            <select
              id="routingMode"
              value={routingMode}
              onChange={(event) => setRoutingMode(event.target.value as RoutingMode)}
            >
              {routingModes.map((mode) => (
                <option value={mode} key={mode}>
                  {mode}
                </option>
              ))}
            </select>
            <label htmlFor="maxModelCalls">{copy.budget}</label>
            <input
              id="maxModelCalls"
              type="number"
              min="1"
              max="100"
              value={maxModelCalls}
              onChange={(event) => setMaxModelCalls(Number(event.target.value))}
            />
            <button data-testid="start-job-button" type="submit" disabled={apiState !== "online" || busy || !prompt.trim()}>
              {copy.startJob}
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </form>
      </section>

      <section className="dashboard">
        <aside className="jobList">
          <div className="sectionHeader">
            <h2>{copy.jobs}</h2>
            <span>{jobListPage?.hasMore ? `${jobs.length}+` : jobs.length}</span>
          </div>
          <div className="jobFilters">
            <div className="filterSegments" aria-label={copy.jobStatusFilter}>
              {jobStatusFilters.map((filter) => (
                <button
                  key={filter.id}
                  className={filter.id === jobStatusFilter ? "filterSegment active" : "filterSegment"}
                  data-filter={filter.id}
                  type="button"
                  onClick={() => setJobStatusFilter(filter.id)}
                >
                  {copy.statusFilters[filter.id]}
                </button>
              ))}
            </div>
            <input
              id="jobSearch"
              type="search"
              aria-label={copy.searchPromptsAria}
              placeholder={copy.searchPrompts}
              value={jobPromptFilter}
              onChange={(event) => setJobPromptFilter(event.target.value)}
            />
            <div className="filterSegments timeFilterSegments" aria-label={copy.jobTimeFilter}>
              {jobTimeFilters.map((filter) => (
                <button
                  key={filter.id}
                  className={filter.id === jobTimeFilter ? "filterSegment active" : "filterSegment"}
                  data-time-filter={filter.id}
                  type="button"
                  onClick={() => setJobTimeFilter(filter.id)}
                >
                  {copy.timeFilters[filter.id]}
                </button>
              ))}
            </div>
            {jobTimeFilter === "custom" ? (
              <div className="customTimeFilters">
                <label htmlFor="jobSince">{copy.since}</label>
                <input
                  id="jobSince"
                  type="datetime-local"
                  value={customSince}
                  onChange={(event) => {
                    setJobTimeFilter("custom");
                    setCustomSince(event.target.value);
                  }}
                />
                <label htmlFor="jobUntil">{copy.until}</label>
                <input
                  id="jobUntil"
                  type="datetime-local"
                  value={customUntil}
                  onChange={(event) => {
                    setJobTimeFilter("custom");
                    setCustomUntil(event.target.value);
                  }}
                />
              </div>
            ) : null}
          </div>
          <ol>
            {jobs.map((job) => (
              <li key={job.id}>
                <button
                  className={job.id === selectedJobId ? "jobRow selected" : "jobRow"}
                  type="button"
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <span className={`dot ${statusTone(job.status)}`} />
                  <span className="jobMeta">
                    <strong>{job.id}</strong>
                    <span>{job.routingMode}</span>
                  </span>
                  <span className="jobStatus">{copy.statuses[job.status]}</span>
                  <span className="jobTime">{formatTime(job.createdAt, language)}</span>
                </button>
              </li>
            ))}
            {jobs.length === 0 ? <li className="emptyState">{copy.noJobsMatch}</li> : null}
          </ol>
          {jobListPage?.hasMore ? (
            <div className="loadMoreRow">
              <button className="secondaryButton" type="button" onClick={loadMoreJobs} disabled={busy}>
                {copy.loadMore}
              </button>
            </div>
          ) : null}
        </aside>

        <section className="jobDetail">
          <div className="sectionHeader detailHeader">
            <div>
              <h2>{selectedFromList?.id ?? copy.noJobSelected}</h2>
              <p>{selectedFromList ? `${selectedFromList.ingressOrigin} / ${selectedFromList.routingMode}` : "-"}</p>
            </div>
            <button
              className="dangerButton"
              type="button"
              onClick={cancelSelectedJob}
              disabled={!isCancellable(selectedFromList) || busy}
            >
              {selectedFromList?.status === "cancelled" ? copy.cancelled : copy.cancel}
            </button>
          </div>

          {selectedFromList ? (
            <dl className="stats">
              <div>
                <dt>{copy.status}</dt>
                <dd>{copy.statuses[selectedFromList.status]}</dd>
              </div>
              <div>
                <dt>{copy.created}</dt>
                <dd>{formatTime(selectedFromList.createdAt, language)}</dd>
              </div>
              <div>
                <dt>{copy.budget}</dt>
                <dd>{selectedFromList.maxModelCalls}</dd>
              </div>
              <div>
                <dt>{copy.timeline}</dt>
                <dd>{timeline?.summary.totalTimelineItems ?? 0}</dd>
              </div>
            </dl>
          ) : (
            <p className="emptyState">{copy.noJobLoaded}</p>
          )}

          <div className="timelineHeader">
            <h3>{copy.timeline}</h3>
            <span>{timeline?.summary.truncated ? copy.latestItems : copy.complete}</span>
          </div>
          <ol className="timeline">
            {timeline?.timeline.length ? (
              timeline.timeline.map((item) => (
                <li key={item.id} className="timelineItem">
                  <time>{formatTime(item.at, language)}</time>
                  <span className={`source source-${item.source}`}>{copy.sources[item.source]}</span>
                  <div>
                    <strong>{compactEventType(item.eventType)}</strong>
                    <p>{item.title}</p>
                    {item.actor ? <small>{item.actor}</small> : null}
                  </div>
                </li>
              ))
            ) : (
              <li className="emptyState">{copy.noTimelineEvents}</li>
            )}
          </ol>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
