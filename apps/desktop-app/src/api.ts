const API_BASE = import.meta.env.VITE_ORCHESTRATOR_URL ?? "http://localhost:3000";

export type JobRecord = {
  id: string;
  status: string;
  ingressOrigin: string;
  routingMode: string;
  finalOutput: string | null;
};

export type GroupMessage = {
  id: string;
  senderAgentId: string;
  mentionAgentId: string | null;
  messageType: string;
  content: string;
  createdAt: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function getHealth() {
  return request<{ ok: boolean }>("/health");
}

export async function createJob(prompt: string) {
  return request<{ jobId: string; status: string; routingMode: string; ingressOrigin: string }>("/jobs", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      requesterId: "desktop-app"
    })
  });
}

export async function getJob(jobId: string) {
  return request<JobRecord>(`/jobs/${jobId}`);
}

export async function getMessages(jobId: string) {
  return request<{ jobId: string; ingressOrigin: string; messages: GroupMessage[] }>(`/jobs/${jobId}/messages`);
}
