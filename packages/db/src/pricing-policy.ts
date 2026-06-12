export type ProviderPricingRate = {
  currency: "USD";
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  source: string;
};

export type TokenUsageForPricing = {
  promptTokens: number;
  completionTokens: number;
};

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rateFromRecord(record: Record<string, unknown>, source: string): ProviderPricingRate | null {
  const inputPerMillionUsd =
    numberValue(record.inputPerMillionUsd) ??
    numberValue(record.promptPerMillionUsd) ??
    (numberValue(record.inputPer1kUsd) !== null ? numberValue(record.inputPer1kUsd)! * 1000 : null) ??
    (numberValue(record.promptPer1kUsd) !== null ? numberValue(record.promptPer1kUsd)! * 1000 : null);
  const outputPerMillionUsd =
    numberValue(record.outputPerMillionUsd) ??
    numberValue(record.completionPerMillionUsd) ??
    (numberValue(record.outputPer1kUsd) !== null ? numberValue(record.outputPer1kUsd)! * 1000 : null) ??
    (numberValue(record.completionPer1kUsd) !== null ? numberValue(record.completionPer1kUsd)! * 1000 : null);

  if (inputPerMillionUsd === null || outputPerMillionUsd === null) {
    return null;
  }

  return {
    currency: "USD",
    inputPerMillionUsd,
    outputPerMillionUsd,
    source
  };
}

export function getProviderPricingRate(
  metadata: Record<string, unknown> | null | undefined,
  model: string | null | undefined
): ProviderPricingRate | null {
  const pricing = recordValue(metadata?.pricing);
  if (!pricing) {
    return null;
  }

  const modelName = model?.trim();
  const models = recordValue(pricing.models);
  if (modelName && models) {
    const exact = recordValue(models[modelName]);
    if (exact) {
      const rate = rateFromRecord(exact, `metadata.pricing.models.${modelName}`);
      if (rate) {
        return rate;
      }
    }

    const lowerModelName = modelName.toLowerCase();
    const matched = Object.entries(models).find(([key]) => key.toLowerCase() === lowerModelName);
    if (matched) {
      const rate = rateFromRecord(recordValue(matched[1]) ?? {}, `metadata.pricing.models.${matched[0]}`);
      if (rate) {
        return rate;
      }
    }
  }

  return rateFromRecord(pricing, "metadata.pricing");
}

export function estimateUsageCostUsd(usage: TokenUsageForPricing, rate: ProviderPricingRate) {
  return (usage.promptTokens / 1_000_000) * rate.inputPerMillionUsd +
    (usage.completionTokens / 1_000_000) * rate.outputPerMillionUsd;
}

export function roundEstimatedUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
