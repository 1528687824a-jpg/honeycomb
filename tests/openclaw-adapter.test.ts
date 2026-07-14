import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildOpenClawAgentArgs,
  buildOpenClawCancelArgs,
  buildOpenClawHostCommand,
  buildNativeOpenClawAgentArgs,
  collectMediaCandidates,
  extractOpenClawText,
  extractOpenClawUsage,
  extractProviderDirectChatText,
  persistMediaCandidates,
  ProviderDirectResponseError,
  ProviderVideoPendingError,
  resolveOpenClawAgentRunner,
  runOpenClawAgent,
  selectProviderDirectKind,
  shouldUseProviderDirectRunner
} from "../apps/dbos-worker/src/adapters/openclaw";

test("extractOpenClawText accepts every recognized output shape", () => {
  assert.deepEqual(extractOpenClawText("plain reply"), {
    text: "plain reply",
    source: "string"
  });
  assert.deepEqual(extractOpenClawText({ text: "from text" }), {
    text: "from text",
    source: "field:text"
  });
  assert.deepEqual(extractOpenClawText({ reply: "from reply" }), {
    text: "from reply",
    source: "field:reply"
  });
  assert.deepEqual(extractOpenClawText({ payloads: [{ text: "from payloads" }] }), {
    text: "from payloads",
    source: "payloads"
  });
  assert.deepEqual(extractOpenClawText({ finalAssistantVisibleText: "from visible" }), {
    text: "from visible",
    source: "finalAssistantVisibleText"
  });
  assert.deepEqual(extractOpenClawText({ finalAssistantRawText: "from raw" }), {
    text: "from raw",
    source: "finalAssistantRawText"
  });
});

test("extractOpenClawText prefers direct fields over payloads", () => {
  assert.deepEqual(
    extractOpenClawText({ text: "direct", payloads: [{ text: "nested" }] }),
    { text: "direct", source: "field:text" }
  );
});

test("extractOpenClawText rejects empty and unrecognized output", () => {
  assert.equal(extractOpenClawText(""), null);
  assert.equal(extractOpenClawText("   "), null);
  assert.equal(extractOpenClawText(null), null);
  assert.equal(extractOpenClawText(42), null);
  assert.equal(extractOpenClawText({ status: "done" }), null);
  assert.equal(extractOpenClawText({ text: "   " }), null);
  assert.equal(extractOpenClawText({ payloads: [{ note: "no text" }] }), null);
});

test("extractOpenClawUsage normalizes every recognized usage shape", () => {
  assert.deepEqual(
    extractOpenClawUsage({ usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }),
    { promptTokens: 100, completionTokens: 40, totalTokens: 140 }
  );
  assert.deepEqual(
    extractOpenClawUsage({ usage: { promptTokens: 5, completionTokens: 7 } }),
    { promptTokens: 5, completionTokens: 7, totalTokens: 12 }
  );
  assert.deepEqual(
    extractOpenClawUsage({ usage: { input_tokens: 30, output_tokens: 12 } }),
    { promptTokens: 30, completionTokens: 12, totalTokens: 42 }
  );
  assert.deepEqual(
    extractOpenClawUsage({ tokenUsage: { promptTokens: 9, completionTokens: 1 } }),
    { promptTokens: 9, completionTokens: 1, totalTokens: 10 }
  );
  assert.deepEqual(
    extractOpenClawUsage({ meta: { usage: { prompt_tokens: 3, completion_tokens: 4 } } }),
    { promptTokens: 3, completionTokens: 4, totalTokens: 7 }
  );
});

test("extractOpenClawUsage rejects missing or invalid usage", () => {
  assert.equal(extractOpenClawUsage("plain text"), null);
  assert.equal(extractOpenClawUsage(null), null);
  assert.equal(extractOpenClawUsage({ text: "no usage here" }), null);
  assert.equal(extractOpenClawUsage({ usage: {} }), null);
  assert.equal(extractOpenClawUsage({ usage: { prompt_tokens: "not-a-number" } }), null);
  assert.equal(extractOpenClawUsage({ usage: { prompt_tokens: -5 } }), null);
});

test("buildOpenClawAgentArgs wraps the CLI in a Linux-side timeout", () => {
  const args = buildOpenClawAgentArgs({
    agentId: "research-agent",
    sessionId: "job:123/stage 4",
    message: "hello",
    timeoutSeconds: 600
  });

  const timeoutIndex = args.indexOf("timeout");
  assert.ok(timeoutIndex > args.indexOf("--"), "timeout wrapper runs inside the distro");
  assert.equal(args[timeoutIndex + 1], "--kill-after=5");
  assert.equal(args[timeoutIndex + 2], "605");

  assert.equal(args[args.indexOf("--session-id") + 1], "job-123-stage-4");
  assert.equal(args[args.indexOf("--timeout") + 1], "600");
  assert.equal(args[args.indexOf("--agent") + 1], "research-agent");
});

test("buildOpenClawCancelArgs targets only the normalized WSL session", () => {
  const args = buildOpenClawCancelArgs("job:123/stage 4");
  assert.deepEqual(args.slice(0, 7), [
    "-d",
    process.env.OPENCLAW_WSL_DISTRO ?? "Ubuntu-24.04",
    "--",
    "pkill",
    "-TERM",
    "-f",
    "--"
  ]);
  assert.equal(args[7], "--session-id job-123-stage-4( |$)");
  assert.equal(
    buildOpenClawCancelArgs("job.123/stage")[7],
    "--session-id job\\.123-stage( |$)"
  );
});

test("resolveOpenClawAgentRunner maps auto to WSL on Windows and native elsewhere", () => {
  assert.equal(resolveOpenClawAgentRunner({ runner: "auto", platform: "win32" }), "wsl");
  assert.equal(resolveOpenClawAgentRunner({ runner: "auto", platform: "darwin" }), "native");
  assert.equal(resolveOpenClawAgentRunner({ runner: "auto", platform: "linux" }), "native");
  assert.equal(resolveOpenClawAgentRunner({ runner: "provider-direct", platform: "darwin" }), "provider-direct");
  assert.equal(resolveOpenClawAgentRunner({ runner: "wsl", platform: "darwin" }), "wsl");
  assert.equal(resolveOpenClawAgentRunner({ runner: "native", platform: "win32" }), "native");
});

test("buildOpenClawHostCommand uses WSL for Windows and local openclaw for macOS", () => {
  const previousCli = process.env.OPENCLAW_CLI;
  try {
    delete process.env.OPENCLAW_CLI;
    const windows = buildOpenClawHostCommand({
      agentId: "research-agent",
      sessionId: "job:123/stage 4",
      message: "hello",
      timeoutSeconds: 600,
      platform: "win32",
      runner: "auto"
    });
    assert.equal(windows.runner, "wsl");
    assert.equal(windows.command, "wsl");
    assert.equal(windows.args[0], "-d");
    assert.ok(windows.args.includes("/home/administrator/.npm-global/bin/openclaw"));

    const mac = buildOpenClawHostCommand({
      agentId: "research-agent",
      sessionId: "job:123/stage 4",
      message: "hello",
      timeoutSeconds: 600,
      platform: "darwin",
      runner: "auto"
    });
    assert.equal(mac.runner, "native");
    assert.equal(mac.command, "openclaw");
    assert.deepEqual(mac.args, buildNativeOpenClawAgentArgs({
      agentId: "research-agent",
      sessionId: "job:123/stage 4",
      message: "hello",
      timeoutSeconds: 600
    }));
  } finally {
    if (previousCli === undefined) {
      delete process.env.OPENCLAW_CLI;
    } else {
      process.env.OPENCLAW_CLI = previousCli;
    }
  }
});

test("shouldUseProviderDirectRunner honors OPENCLAW_AGENT_RUNNER", () => {
  const previousRunner = process.env.OPENCLAW_AGENT_RUNNER;
  try {
    process.env.OPENCLAW_AGENT_RUNNER = "provider-direct";
    assert.equal(shouldUseProviderDirectRunner(), true);

    process.env.OPENCLAW_AGENT_RUNNER = "native";
    assert.equal(shouldUseProviderDirectRunner(), false);
  } finally {
    if (previousRunner === undefined) {
      delete process.env.OPENCLAW_AGENT_RUNNER;
    } else {
      process.env.OPENCLAW_AGENT_RUNNER = previousRunner;
    }
  }
});

test("selectProviderDirectKind routes specialist agents to media endpoints", () => {
  assert.equal(selectProviderDirectKind({ providerId: "p", baseUrl: "https://example.com", model: "deepseek-chat", apiKey: "k", agentRole: "research" }), "chat");
  assert.equal(selectProviderDirectKind({ providerId: "p", baseUrl: "https://example.com", model: "deepseek-chat", apiKey: "k", agentRole: "image" }), "image");
  assert.equal(selectProviderDirectKind({ providerId: "p", baseUrl: "https://example.com", model: "doubao-seedream-5-0", apiKey: "k" }), "image");
  assert.equal(selectProviderDirectKind({ providerId: "p", baseUrl: "https://example.com", model: "doubao-seedance-2-0", apiKey: "k" }), "video");
});

test("provider-direct video requests use Volcengine content payloads", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const providerRequestIds: string[] = [];
  const providerTaskIds: string[] = [];
  const taskUpdates: Array<{ phase: string; status: string }> = [];
  let baseUrl = "";
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST") {
      assert.equal(request.url, "/contents/generations/tasks");
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "provider-http-request-1"
      });
      response.end(JSON.stringify({ id: "video-task-1", status: "queued" }));
      return;
    }
    if (request.method === "GET" && request.url === "/contents/generations/tasks/video-task-1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "video-task-1",
        status: "succeeded",
        content: { video_url: `${baseUrl}/result.mp4` },
        usage: { completion_tokens: 12, total_tokens: 12 }
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/result.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(Buffer.from("test-mp4-result"));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const previousMode = process.env.OPENCLAW_AGENT_MODE;
  const previousRunner = process.env.OPENCLAW_AGENT_RUNNER;
  const previousPollInterval = process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS;
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "honeycomb-video-provider-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.OPENCLAW_AGENT_MODE = "real";
    process.env.OPENCLAW_AGENT_RUNNER = "provider-direct";
    process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS = "10";

    const result = await runOpenClawAgent({
      agentId: "video-agent",
      sessionId: "job:video/stage",
      message: "Generate a five-second product teaser video.",
      provider: {
        providerId: "volcengine",
        baseUrl,
        model: "doubao-seedance-2-0",
        apiKey: "test-key",
        agentRole: "video"
      },
      outputDir,
      timeoutSeconds: 5,
      onProviderRequestId: async (providerRequestId) => {
        providerRequestIds.push(providerRequestId);
      },
      onProviderTaskId: async (providerTaskId) => {
        providerTaskIds.push(providerTaskId);
      },
      onProviderTaskUpdate: async (update) => {
        taskUpdates.push({ phase: update.phase, status: update.status });
      }
    });

    assert.equal(result?.textSource, "provider:video");
    assert.deepEqual(capturedBody?.content, [
      {
        type: "text",
        text: "Generate a five-second product teaser video."
      }
    ]);
    assert.equal("prompt" in (capturedBody ?? {}), false);
    assert.deepEqual(providerRequestIds, ["provider-http-request-1"]);
    assert.deepEqual(providerTaskIds, ["video-task-1"]);
    assert.deepEqual(taskUpdates.map((update) => update.phase), [
      "submitted",
      "polling",
      "downloading",
      "completed"
    ]);
    assert.equal(result?.artifacts?.length, 1);
    assert.equal(
      await readFile(result?.artifacts?.[0]?.filePath ?? "", "utf8"),
      "test-mp4-result"
    );
  } finally {
    if (previousMode === undefined) {
      delete process.env.OPENCLAW_AGENT_MODE;
    } else {
      process.env.OPENCLAW_AGENT_MODE = previousMode;
    }
    if (previousRunner === undefined) {
      delete process.env.OPENCLAW_AGENT_RUNNER;
    } else {
      process.env.OPENCLAW_AGENT_RUNNER = previousRunner;
    }
    if (previousPollInterval === undefined) {
      delete process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS;
    } else {
      process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS = previousPollInterval;
    }
    await rm(outputDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("provider-direct video polling resumes a persisted task without another POST", async () => {
  let postCount = 0;
  let getCount = 0;
  let returnSuccess = false;
  let baseUrl = "";
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/contents/generations/tasks") {
      postCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "video-task-resume", status: "queued" }));
      return;
    }
    if (request.method === "GET" && request.url === "/contents/generations/tasks/video-task-resume") {
      getCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(returnSuccess
        ? {
            id: "video-task-resume",
            status: "succeeded",
            content: { video_url: `${baseUrl}/resume.mp4` }
          }
        : { id: "video-task-resume", status: "running" }));
      return;
    }
    if (request.method === "GET" && request.url === "/resume.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(Buffer.from("resumed-video"));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const previousMode = process.env.OPENCLAW_AGENT_MODE;
  const previousRunner = process.env.OPENCLAW_AGENT_RUNNER;
  const previousPollInterval = process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS;
  const previousPollWindow = process.env.OPENCLAW_VIDEO_POLL_WINDOW_MS;
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "honeycomb-video-resume-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.OPENCLAW_AGENT_MODE = "real";
    process.env.OPENCLAW_AGENT_RUNNER = "provider-direct";
    process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS = "10";
    process.env.OPENCLAW_VIDEO_POLL_WINDOW_MS = "60";
    const providerTaskIds: string[] = [];
    const common = {
      agentId: "video-agent",
      sessionId: "job:video-resume/stage",
      message: "Generate a short video.",
      provider: {
        providerId: "volcengine",
        baseUrl,
        model: "doubao-seedance-2-0",
        apiKey: "test-key",
        agentRole: "video"
      },
      outputDir,
      timeoutSeconds: 5
    } as const;

    await assert.rejects(runOpenClawAgent({
      ...common,
      onProviderTaskId: async (providerTaskId) => {
        providerTaskIds.push(providerTaskId);
      }
    }), (error: unknown) => {
      assert.ok(error instanceof ProviderVideoPendingError);
      assert.equal(error.taskId, "video-task-resume");
      return true;
    });
    assert.equal(postCount, 1);
    assert.deepEqual(providerTaskIds, ["video-task-resume"]);

    returnSuccess = true;
    const resumed = await runOpenClawAgent({
      ...common,
      resumeProviderTaskId: "video-task-resume"
    });
    assert.equal(postCount, 1, "resume must never submit a second provider task");
    assert.ok(getCount > 0);
    assert.equal(await readFile(resumed?.artifacts?.[0]?.filePath ?? "", "utf8"), "resumed-video");
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_AGENT_MODE;
    else process.env.OPENCLAW_AGENT_MODE = previousMode;
    if (previousRunner === undefined) delete process.env.OPENCLAW_AGENT_RUNNER;
    else process.env.OPENCLAW_AGENT_RUNNER = previousRunner;
    if (previousPollInterval === undefined) delete process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS;
    else process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS = previousPollInterval;
    if (previousPollWindow === undefined) delete process.env.OPENCLAW_VIDEO_POLL_WINDOW_MS;
    else process.env.OPENCLAW_VIDEO_POLL_WINDOW_MS = previousPollWindow;
    await rm(outputDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("provider-direct video cancellation requests remote task cancellation", async () => {
  let deleteCount = 0;
  const server = http.createServer((request, response) => {
    if (request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "video-task-cancel", status: "queued" }));
      return;
    }
    if (request.method === "DELETE" && request.url === "/contents/generations/tasks/video-task-cancel") {
      deleteCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "video-task-cancel", status: "running" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const previousMode = process.env.OPENCLAW_AGENT_MODE;
  const previousRunner = process.env.OPENCLAW_AGENT_RUNNER;
  const previousPollInterval = process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS;
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "honeycomb-video-cancel-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.OPENCLAW_AGENT_MODE = "real";
    process.env.OPENCLAW_AGENT_RUNNER = "provider-direct";
    process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS = "1000";
    const controller = new AbortController();
    const pending = runOpenClawAgent({
      agentId: "video-agent",
      sessionId: "job:video-cancel/stage",
      message: "Generate a video that will be cancelled.",
      provider: {
        providerId: "volcengine",
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: "doubao-seedance-2-0",
        apiKey: "test-key",
        agentRole: "video"
      },
      outputDir,
      timeoutSeconds: 5,
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, { message: "job_cancelled" });
    assert.equal(deleteCount, 1);
  } finally {
    if (previousMode === undefined) delete process.env.OPENCLAW_AGENT_MODE;
    else process.env.OPENCLAW_AGENT_MODE = previousMode;
    if (previousRunner === undefined) delete process.env.OPENCLAW_AGENT_RUNNER;
    else process.env.OPENCLAW_AGENT_RUNNER = previousRunner;
    if (previousPollInterval === undefined) delete process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS;
    else process.env.OPENCLAW_VIDEO_POLL_INTERVAL_MS = previousPollInterval;
    await rm(outputDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("provider-direct requests stop when the job cancellation signal aborts", async () => {
  let responseTimer: NodeJS.Timeout | null = null;
  const server = http.createServer((_request, response) => {
    responseTimer = setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "too late" } }] }));
      }
    }, 1_000);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const previousMode = process.env.OPENCLAW_AGENT_MODE;
  const previousRunner = process.env.OPENCLAW_AGENT_RUNNER;
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.OPENCLAW_AGENT_MODE = "real";
    process.env.OPENCLAW_AGENT_RUNNER = "provider-direct";
    const controller = new AbortController();
    const pending = runOpenClawAgent({
      agentId: "research-agent",
      sessionId: "job:cancel/stage",
      message: "Wait for the provider.",
      provider: {
        providerId: "test-provider",
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: "test-chat-model",
        apiKey: "test-key",
        agentRole: "research"
      },
      timeoutSeconds: 5,
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, { message: "job_cancelled" });
  } finally {
    if (responseTimer) clearTimeout(responseTimer);
    if (previousMode === undefined) {
      delete process.env.OPENCLAW_AGENT_MODE;
    } else {
      process.env.OPENCLAW_AGENT_MODE = previousMode;
    }
    if (previousRunner === undefined) {
      delete process.env.OPENCLAW_AGENT_RUNNER;
    } else {
      process.env.OPENCLAW_AGENT_RUNNER = previousRunner;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("provider-direct errors preserve status, provider code, and Retry-After", async () => {
  let idempotencyKey: string | string[] | undefined;
  const providerRequestIds: string[] = [];
  const server = http.createServer((request, response) => {
    idempotencyKey = request.headers["idempotency-key"];
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "2",
      "x-request-id": "provider-request-429"
    });
    response.end(JSON.stringify({
      error: {
        message: "Please slow down",
        code: "rate_limit_exceeded"
      }
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const previousMode = process.env.OPENCLAW_AGENT_MODE;
  const previousRunner = process.env.OPENCLAW_AGENT_RUNNER;
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.OPENCLAW_AGENT_MODE = "real";
    process.env.OPENCLAW_AGENT_RUNNER = "provider-direct";

    await assert.rejects(runOpenClawAgent({
      agentId: "research-agent",
      sessionId: "job:retry-after/stage",
      message: "Test rate limiting.",
      requestId: "job-retry-after:route:0",
      provider: {
        providerId: "test-provider",
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: "test-chat-model",
        apiKey: "test-key",
        agentRole: "research"
      },
      timeoutSeconds: 5,
      onProviderRequestId: async (providerRequestId) => {
        providerRequestIds.push(providerRequestId);
      }
    }), (error: unknown) => {
      assert.ok(error instanceof ProviderDirectResponseError);
      assert.equal(error.statusCode, 429);
      assert.equal(error.providerCode, "rate_limit_exceeded");
      assert.equal(error.retryAfterMs, 2_000);
      assert.equal(error.providerRequestId, "provider-request-429");
      assert.equal(error.failureSource, "provider_http");
      return true;
    });
    assert.equal(idempotencyKey, "job-retry-after:route:0");
    assert.deepEqual(providerRequestIds, ["provider-request-429"]);

    await assert.rejects(runOpenClawAgent({
      agentId: "research-agent",
      sessionId: "job:request-reference-failure/stage",
      message: "Test request reference persistence failure.",
      requestId: "job-request-reference-failure:route:0",
      provider: {
        providerId: "test-provider",
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: "test-chat-model",
        apiKey: "test-key",
        agentRole: "research"
      },
      timeoutSeconds: 5,
      onProviderRequestId: async () => {
        throw new Error("database temporarily unavailable");
      }
    }), (error: unknown) => {
      assert.ok(error instanceof ProviderDirectResponseError);
      assert.equal(error.failureSource, "provider_network");
      assert.equal(error.networkCode, "REFERENCE_PERSIST_FAILED");
      assert.equal(error.providerRequestId, "provider-request-429");
      return true;
    });
  } finally {
    if (previousMode === undefined) {
      delete process.env.OPENCLAW_AGENT_MODE;
    } else {
      process.env.OPENCLAW_AGENT_MODE = previousMode;
    }
    if (previousRunner === undefined) {
      delete process.env.OPENCLAW_AGENT_RUNNER;
    } else {
      process.env.OPENCLAW_AGENT_RUNNER = previousRunner;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("extractProviderDirectChatText reads OpenAI-compatible choices", () => {
  assert.equal(
    extractProviderDirectChatText({
      choices: [
        {
          message: {
            content: "hello from provider"
          }
        }
      ]
    }),
    "hello from provider"
  );
  assert.equal(
    extractProviderDirectChatText({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "part one" },
              { type: "text", text: "part two" }
            ]
          }
        }
      ]
    }),
    "part one\npart two"
  );
  assert.equal(
    extractProviderDirectChatText({
      choices: [
        {
          message: {
            reasoning_content: "reasoning-only provider text"
          }
        }
      ]
    }),
    "reasoning-only provider text"
  );
  assert.equal(
    extractProviderDirectChatText({
      output_text: "responses-api provider text"
    }),
    "responses-api provider text"
  );
  assert.equal(
    extractProviderDirectChatText({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: "nested output item"
            }
          ]
        }
      ]
    }),
    "nested output item"
  );
});

test("persistMediaCandidates downloads URL media into the output directory", async () => {
  const body = Buffer.from("fake-image-bytes");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": String(body.byteLength)
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "honeycomb-media-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/poster.jpg`;
    const candidates = collectMediaCandidates({ data: [{ url, revised_prompt: "poster" }] }, "image");
    const artifacts = await persistMediaCandidates({
      candidates,
      outputDir: tempDir,
      sessionId: "job:stage/image"
    });

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].url, url);
    assert.equal(artifacts[0].mimeType, "image/jpeg");
    assert.equal(artifacts[0].source, "url");
    assert.equal(artifacts[0].sizeBytes, body.byteLength);
    assert.equal(artifacts[0].downloadError, null);
    assert.match(artifacts[0].filePath ?? "", /\.jpg$/);
    assert.deepEqual(await readFile(artifacts[0].filePath ?? ""), body);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("persistMediaCandidates does not swallow job cancellation during download", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/jpeg" });
    response.write(Buffer.from("partial-image"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "honeycomb-media-cancel-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const controller = new AbortController();
    const pending = persistMediaCandidates({
      candidates: collectMediaCandidates({
        data: [{ url: `http://127.0.0.1:${address.port}/poster.jpg` }]
      }, "image"),
      outputDir: tempDir,
      sessionId: "job:cancel/image",
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, { message: "job_cancelled" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});
