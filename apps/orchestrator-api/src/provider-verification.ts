export type ProviderVerificationResult = {
  ok: boolean;
  status: "succeeded" | "failed";
  checkedAt: string;
  latencyMs: number;
  statusCode: number | null;
  message: string | null;
};

function chatCompletionsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/chat/completions`;
}

function imageGenerationsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/images/generations`;
}

function videoTasksUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return `${normalized}/contents/generations/tasks`;
}

async function responseErrorMessage(response: Response) {
  let message = `${response.status} ${response.statusText}`.trim();
  try {
    const body = await response.json() as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
      code?: unknown;
    };
    const remoteMessage =
      typeof body.error?.message === "string"
        ? body.error.message
        : typeof body.message === "string"
          ? body.message
          : null;
    if (remoteMessage) {
      message = `${message}: ${remoteMessage}`.slice(0, 500);
    }
  } catch {
    // Keep the status-only message. Do not echo raw provider bodies.
  }
  return message;
}

function isModelRejectedMessage(message: string) {
  return /model.*(not valid|invalid|not found|not exist|not support|does not support|unsupported|specified)|requested model|parameter `model`/i.test(
    message
  );
}

function isExpectedMediaProbeRejection(message: string) {
  return /(prompt|content|input|image|video|resolution|size|duration|required|missing|parameter)/i.test(message) &&
    !isModelRejectedMessage(message);
}

async function verifyMediaGenerationEndpoint(input: {
  url: string;
  model: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  probeSucceededMessage: string;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify(input.body),
      signal: controller.signal
    });

    if (response.ok) {
      return {
        ok: true,
        status: "succeeded",
        checkedAt,
        latencyMs: Date.now() - startedAt,
        statusCode: response.status,
        message: null
      } satisfies ProviderVerificationResult;
    }

    const message = await responseErrorMessage(response);
    if (response.status === 401 || response.status === 403 || isModelRejectedMessage(message)) {
      return {
        ok: false,
        status: "failed",
        checkedAt,
        latencyMs: Date.now() - startedAt,
        statusCode: response.status,
        message
      } satisfies ProviderVerificationResult;
    }

    if (response.status === 400 && isExpectedMediaProbeRejection(message)) {
      return {
        ok: true,
        status: "succeeded",
        checkedAt,
        latencyMs: Date.now() - startedAt,
        statusCode: response.status,
        message: input.probeSucceededMessage
      } satisfies ProviderVerificationResult;
    }

    return {
      ok: false,
      status: "failed",
      checkedAt,
      latencyMs: Date.now() - startedAt,
      statusCode: response.status,
      message
    } satisfies ProviderVerificationResult;
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      checkedAt,
      latencyMs: Date.now() - startedAt,
      statusCode: null,
      message: error instanceof Error ? error.message.slice(0, 500) : "provider_verification_failed"
    } satisfies ProviderVerificationResult;
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyOpenAiCompatibleProvider(input: {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<ProviderVerificationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const response = await fetch(chatCompletionsUrl(input.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: "user",
            content: "Return only OK."
          }
        ],
        max_tokens: 2,
        temperature: 0,
        stream: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const message = await responseErrorMessage(response);
      return {
        ok: false,
        status: "failed",
        checkedAt,
        latencyMs: Date.now() - startedAt,
        statusCode: response.status,
        message
      };
    }

    return {
      ok: true,
      status: "succeeded",
      checkedAt,
      latencyMs: Date.now() - startedAt,
      statusCode: response.status,
      message: null
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      checkedAt,
      latencyMs: Date.now() - startedAt,
      statusCode: null,
      message: error instanceof Error ? error.message.slice(0, 500) : "provider_verification_failed"
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyOpenAiCompatibleImageGenerationProvider(input: {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<ProviderVerificationResult> {
  return verifyMediaGenerationEndpoint({
    url: imageGenerationsUrl(input.baseUrl),
    model: input.model,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
    body: {
      model: input.model
    },
    probeSucceededMessage: "image_generation_endpoint_reachable"
  });
}

export async function verifyOpenAiCompatibleVideoGenerationProvider(input: {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<ProviderVerificationResult> {
  return verifyMediaGenerationEndpoint({
    url: videoTasksUrl(input.baseUrl),
    model: input.model,
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
    body: {
      model: input.model
    },
    probeSucceededMessage: "video_generation_endpoint_reachable"
  });
}
