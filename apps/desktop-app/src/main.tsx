import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createJob, getHealth, getJob, getMessages, type GroupMessage, type JobRecord } from "./api";
import "./styles.css";

type ApiState = "checking" | "online" | "offline";

function App() {
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [prompt, setPrompt] = useState("Draft a short launch note for a tiny multi-agent product.");
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState<JobRecord | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const statusText = useMemo(() => {
    if (apiState === "online") return "API online";
    if (apiState === "offline") return "API offline";
    return "Checking API";
  }, [apiState]);

  async function refresh(targetJobId = jobId) {
    if (!targetJobId.trim()) return;
    const [nextJob, nextMessages] = await Promise.all([getJob(targetJobId.trim()), getMessages(targetJobId.trim())]);
    setJob(nextJob);
    setMessages(nextMessages.messages);
  }

  async function submitJob() {
    setError(null);
    const created = await createJob(prompt);
    setJobId(created.jobId);
    await refresh(created.jobId);
  }

  useEffect(() => {
    getHealth()
      .then(() => setApiState("online"))
      .catch(() => setApiState("offline"));
  }, []);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Agent OpenClaw</h1>
          <p>Local multi-agent control console</p>
        </div>
        <span className={`status ${apiState}`}>{statusText}</span>
      </header>

      <section className="workspace">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            submitJob().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
          }}
        >
          <label htmlFor="prompt">New Job</label>
          <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <button type="submit" disabled={apiState !== "online" || !prompt.trim()}>
            Start Job
          </button>
        </form>

        <section className="jobTools">
          <label htmlFor="jobId">Job Lookup</label>
          <div className="lookup">
            <input id="jobId" value={jobId} onChange={(event) => setJobId(event.target.value)} />
            <button
              type="button"
              onClick={() => refresh().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))}
              disabled={!jobId.trim()}
            >
              Refresh
            </button>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </section>
      </section>

      <section className="results">
        <div className="summary">
          <h2>Current Job</h2>
          {job ? (
            <dl>
              <dt>ID</dt>
              <dd>{job.id}</dd>
              <dt>Status</dt>
              <dd>{job.status}</dd>
              <dt>Ingress</dt>
              <dd>{job.ingressOrigin}</dd>
              <dt>Routing</dt>
              <dd>{job.routingMode}</dd>
            </dl>
          ) : (
            <p>No job selected.</p>
          )}
        </div>

        <div className="timeline">
          <h2>Messages</h2>
          {messages.length ? (
            <ol>
              {messages.map((message) => (
                <li key={message.id}>
                  <span>{message.senderAgentId}</span>
                  <strong>{message.messageType}</strong>
                  <p>{message.content}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p>No messages loaded.</p>
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
