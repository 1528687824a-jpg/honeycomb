import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inferOpenAiCompatibleProviderForModel,
  isLikelyImageGenerationModel
} from "../apps/orchestrator-api/src/provider-inference";

test("provider inference recognizes common OpenAI-compatible model names", () => {
  assert.equal(inferOpenAiCompatibleProviderForModel("deepseek-chat")?.id, "provider-deepseek");
  assert.equal(inferOpenAiCompatibleProviderForModel("gpt-4o")?.id, "provider-openai");
  assert.equal(
    inferOpenAiCompatibleProviderForModel("qwen-plus")?.id,
    "provider-alibaba-cloud-bailian"
  );
  assert.equal(inferOpenAiCompatibleProviderForModel("glm-4-plus")?.id, "provider-zhipu-ai");
  assert.equal(inferOpenAiCompatibleProviderForModel("doubao-pro-32k")?.id, "provider-volcengine-ark");
  assert.equal(inferOpenAiCompatibleProviderForModel("anthropic/claude-3.5-sonnet")?.id, "provider-openrouter");
});

test("provider inference refuses unknown first-time model names instead of falling back to DeepSeek", () => {
  assert.equal(inferOpenAiCompatibleProviderForModel("my-private-model"), null);
  assert.deepEqual(
    inferOpenAiCompatibleProviderForModel("my-private-model", {
      id: "provider-private",
      displayName: "Private Provider",
      baseUrl: "https://models.example.test/v1"
    }),
    {
      id: "provider-private",
      displayName: "Private Provider",
      baseUrl: "https://models.example.test/v1",
      source: "existing"
    }
  );
});

test("provider inference supports preset base URL overrides for offline smoke tests", () => {
  const previous = process.env.HONEYCOMB_PROVIDER_PRESET_DEEPSEEK_BASE_URL;
  process.env.HONEYCOMB_PROVIDER_PRESET_DEEPSEEK_BASE_URL = "http://127.0.0.1:39999/v1";
  try {
    assert.equal(
      inferOpenAiCompatibleProviderForModel("deepseek-chat")?.baseUrl,
      "http://127.0.0.1:39999/v1"
    );
  } finally {
    if (previous === undefined) {
      delete process.env.HONEYCOMB_PROVIDER_PRESET_DEEPSEEK_BASE_URL;
    } else {
      process.env.HONEYCOMB_PROVIDER_PRESET_DEEPSEEK_BASE_URL = previous;
    }
  }
});

test("image generation model names are detected for clearer chat verification errors", () => {
  assert.equal(isLikelyImageGenerationModel("gpt-image-1"), true);
  assert.equal(isLikelyImageGenerationModel("wanx2.1-t2i-turbo"), true);
  assert.equal(isLikelyImageGenerationModel("deepseek-chat"), false);
});
