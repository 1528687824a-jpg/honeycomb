import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateUsageCostUsd,
  getProviderPricingRate,
  getProviderSpendEstimate,
  settleProviderSpendUsd,
  roundEstimatedUsd
} from "../packages/db/src/pricing-policy";

test("provider pricing supports default per-million rates", () => {
  const rate = getProviderPricingRate(
    {
      pricing: {
        inputPerMillionUsd: 0.14,
        outputPerMillionUsd: 0.28
      }
    },
    "deepseek-chat"
  );

  assert.deepEqual(rate, {
    currency: "USD",
    inputPerMillionUsd: 0.14,
    outputPerMillionUsd: 0.28,
    source: "metadata.pricing"
  });
  assert.equal(
    roundEstimatedUsd(estimateUsageCostUsd({ promptTokens: 1_000_000, completionTokens: 500_000 }, rate!)),
    0.28
  );
});

test("provider pricing prefers model-specific rates case-insensitively", () => {
  const rate = getProviderPricingRate(
    {
      pricing: {
        inputPerMillionUsd: 1,
        outputPerMillionUsd: 2,
        models: {
          "GPT-4.1-Mini": {
            promptPer1kUsd: 0.0004,
            completionPer1kUsd: 0.0016
          }
        }
      }
    },
    "gpt-4.1-mini"
  );

  assert.deepEqual(rate, {
    currency: "USD",
    inputPerMillionUsd: 0.4,
    outputPerMillionUsd: 1.6,
    source: "metadata.pricing.models.GPT-4.1-Mini"
  });
});

test("provider pricing returns null when pricing metadata is incomplete", () => {
  assert.equal(getProviderPricingRate({}, "model"), null);
  assert.equal(getProviderPricingRate({ pricing: { inputPerMillionUsd: 1 } }, "model"), null);
});

test("spend reservation uses model-specific per-request caps for media", () => {
  const estimate = getProviderSpendEstimate({
    metadata: {
      pricing: {
        models: {
          "image-model": { maxPerRequestUsd: 0.08 }
        }
      }
    },
    model: "IMAGE-MODEL",
    kind: "image"
  });
  assert.equal(estimate?.amountUsd, 0.08);
  assert.equal(estimate?.basis.billing, "request_cap");
  assert.equal(settleProviderSpendUsd(estimate!.basis, null), 0.08);
});

test("token-priced calls reserve a bounded maximum then settle actual usage", () => {
  const estimate = getProviderSpendEstimate({
    metadata: {
      pricing: {
        inputPerMillionUsd: 1,
        outputPerMillionUsd: 2
      }
    },
    model: "chat-model",
    kind: "chat",
    inputTokenCeiling: 10_000,
    outputTokenCeiling: 2_000
  });
  assert.equal(estimate?.amountUsd, 0.014);
  assert.equal(estimate?.basis.billing, "token_bound");
  assert.equal(settleProviderSpendUsd(estimate!.basis, {
    promptTokens: 1_000,
    completionTokens: 500
  }), 0.002);
});

test("hard spend reservation fails closed when a charge bound is unavailable", () => {
  assert.equal(getProviderSpendEstimate({
    metadata: { pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } },
    model: "chat-model",
    kind: "openclaw"
  }), null);
  assert.equal(getProviderSpendEstimate({
    metadata: { pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } },
    model: "image-model",
    kind: "image",
    inputTokenCeiling: 1_000,
    outputTokenCeiling: 1_000
  }), null);
});
