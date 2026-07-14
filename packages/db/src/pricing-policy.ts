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

export type ProviderSpendPricingBasis = {
  billing: "fixed_request" | "request_cap" | "token_bound";
  reservationUsd: number;
  perRequestUsd: number | null;
  inputPerMillionUsd: number | null;
  outputPerMillionUsd: number | null;
  inputTokenCeiling: number | null;
  outputTokenCeiling: number | null;
  source: string;
};

export type ProviderSpendEstimate = {
  amountUsd: number;
  source: string;
  basis: ProviderSpendPricingBasis;
};

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pricingRecordForModel(
  metadata: Record<string, unknown> | null | undefined,
  model: string | null | undefined
) {
  const pricing = recordValue(metadata?.pricing);
  if (!pricing) {
    return null;
  }
  const modelName = model?.trim();
  const models = recordValue(pricing.models);
  if (modelName && models) {
    const exact = recordValue(models[modelName]);
    if (exact) {
      return { record: exact, fallback: pricing, source: `metadata.pricing.models.${modelName}` };
    }
    const lowerModelName = modelName.toLowerCase();
    const matched = Object.entries(models).find(([key]) => key.toLowerCase() === lowerModelName);
    if (matched) {
      return {
        record: recordValue(matched[1]) ?? {},
        fallback: pricing,
        source: `metadata.pricing.models.${matched[0]}`
      };
    }
  }
  return { record: pricing, fallback: pricing, source: "metadata.pricing" };
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function maxNumber(...values: unknown[]) {
  const parsed = values
    .map(numberValue)
    .filter((value): value is number => value !== null);
  return parsed.length ? Math.max(...parsed) : null;
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

function ceilReservationUsd(value: number) {
  return Math.ceil(value * 1_000_000) / 1_000_000;
}

export function getProviderSpendEstimate(input: {
  metadata: Record<string, unknown> | null | undefined;
  model: string | null | undefined;
  kind: "chat" | "image" | "video" | "openclaw";
  inputTokenCeiling?: number | null;
  outputTokenCeiling?: number | null;
}): ProviderSpendEstimate | null {
  const resolved = pricingRecordForModel(input.metadata, input.model);
  if (!resolved) {
    return null;
  }
  const maxPerRequestUsd = firstNumber(
    resolved.record.maxPerRequestUsd,
    resolved.record.reservationUsd,
    resolved.fallback.maxPerRequestUsd,
    resolved.fallback.reservationUsd
  );
  const perRequestUsd = firstNumber(
    resolved.record.perRequestUsd,
    resolved.record.requestUsd,
    resolved.fallback.perRequestUsd,
    resolved.fallback.requestUsd
  );
  const rate = getProviderPricingRate(input.metadata, input.model);

  if (maxPerRequestUsd !== null) {
    const amountUsd = ceilReservationUsd(maxPerRequestUsd);
    return {
      amountUsd,
      source: `${resolved.source}.maxPerRequestUsd`,
      basis: {
        billing: "request_cap",
        reservationUsd: amountUsd,
        perRequestUsd: null,
        inputPerMillionUsd: rate?.inputPerMillionUsd ?? null,
        outputPerMillionUsd: rate?.outputPerMillionUsd ?? null,
        inputTokenCeiling: input.inputTokenCeiling ?? null,
        outputTokenCeiling: input.outputTokenCeiling ?? null,
        source: `${resolved.source}.maxPerRequestUsd`
      }
    };
  }

  if (perRequestUsd !== null) {
    const amountUsd = ceilReservationUsd(perRequestUsd);
    return {
      amountUsd,
      source: `${resolved.source}.perRequestUsd`,
      basis: {
        billing: "fixed_request",
        reservationUsd: amountUsd,
        perRequestUsd: amountUsd,
        inputPerMillionUsd: null,
        outputPerMillionUsd: null,
        inputTokenCeiling: null,
        outputTokenCeiling: null,
        source: `${resolved.source}.perRequestUsd`
      }
    };
  }

  if (input.kind === "image" || input.kind === "video" || !rate) {
    return null;
  }
  const inputTokenCeiling = maxNumber(
    input.inputTokenCeiling,
    resolved.record.maxInputTokens,
    resolved.record.inputTokenCeiling,
    resolved.fallback.maxInputTokens,
    resolved.fallback.inputTokenCeiling
  );
  const outputTokenCeiling = maxNumber(
    input.outputTokenCeiling,
    resolved.record.maxOutputTokens,
    resolved.record.outputTokenCeiling,
    resolved.fallback.maxOutputTokens,
    resolved.fallback.outputTokenCeiling
  );
  if (inputTokenCeiling === null || outputTokenCeiling === null) {
    return null;
  }
  const amountUsd = ceilReservationUsd(estimateUsageCostUsd({
    promptTokens: inputTokenCeiling,
    completionTokens: outputTokenCeiling
  }, rate));
  return {
    amountUsd,
    source: `${rate.source}.tokenBound`,
    basis: {
      billing: "token_bound",
      reservationUsd: amountUsd,
      perRequestUsd: null,
      inputPerMillionUsd: rate.inputPerMillionUsd,
      outputPerMillionUsd: rate.outputPerMillionUsd,
      inputTokenCeiling,
      outputTokenCeiling,
      source: `${rate.source}.tokenBound`
    }
  };
}

export function settleProviderSpendUsd(
  basis: ProviderSpendPricingBasis,
  usage: TokenUsageForPricing | null | undefined
) {
  if (basis.billing === "fixed_request") {
    return roundEstimatedUsd(basis.perRequestUsd ?? basis.reservationUsd);
  }
  if (
    usage &&
    basis.inputPerMillionUsd !== null &&
    basis.outputPerMillionUsd !== null
  ) {
    const actual = estimateUsageCostUsd(usage, {
      currency: "USD",
      inputPerMillionUsd: basis.inputPerMillionUsd,
      outputPerMillionUsd: basis.outputPerMillionUsd,
      source: basis.source
    });
    return roundEstimatedUsd(
      basis.billing === "request_cap" ? Math.min(actual, basis.reservationUsd) : actual
    );
  }
  return roundEstimatedUsd(basis.reservationUsd);
}
