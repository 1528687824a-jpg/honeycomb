import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildOpenClawAgentArgs,
  collectMediaCandidates,
  extractOpenClawText,
  extractOpenClawUsage,
  extractProviderDirectChatText,
  persistMediaCandidates,
  selectProviderDirectKind
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

test("selectProviderDirectKind routes specialist agents to media endpoints", () => {
  assert.equal(selectProviderDirectKind({ providerId: "p", baseUrl: "https://example.com", model: "deepseek-chat", apiKey: "k", agentRole: "research" }), "chat");
  assert.equal(selectProviderDirectKind({ providerId: "p", baseUrl: "https://example.com", model: "deepseek-chat", apiKey: "k", agentRole: "image" }), "image");
  assert.equal(selectProviderDirectKind({ providerId: "p", baseUrl: "https://example.com", model: "doubao-seedream-5-0", apiKey: "k" }), "image");
  assert.equal(selectProviderDirectKind({ providerId: "p", baseUrl: "https://example.com", model: "doubao-seedance-2-0", apiKey: "k" }), "video");
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
