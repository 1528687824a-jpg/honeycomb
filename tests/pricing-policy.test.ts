import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateUsageCostUsd,
  getProviderPricingRate,
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
