export type InferredModelProvider = {
  id: string;
  displayName: string;
  baseUrl: string;
  source: "preset" | "existing";
  presetKey?: string;
};

type ProviderPreset = Omit<InferredModelProvider, "source"> & {
  pattern: RegExp;
};

export const openAiCompatibleProviderPresets: ProviderPreset[] = [
  {
    id: "provider-deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    presetKey: "deepseek",
    pattern: /^deepseek[-_]?/i
  },
  {
    id: "provider-openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    presetKey: "openai",
    pattern: /^(gpt-|o[134]|chatgpt|dall-e|gpt-image-)/i
  },
  {
    id: "provider-alibaba-cloud-bailian",
    displayName: "Alibaba Cloud Bailian",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    presetKey: "alibaba-bailian",
    pattern: /^(qwen|qwq|wanx|通义)/i
  },
  {
    id: "provider-zhipu-ai",
    displayName: "Zhipu AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    presetKey: "zhipu",
    pattern: /^(glm|cogview|cogvideo|zhipu|智谱)/i
  },
  {
    id: "provider-volcengine-ark",
    displayName: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    presetKey: "volcengine-ark",
    pattern: /^(doubao|豆包|volc|ark|ep-)/i
  },
  {
    id: "provider-siliconflow",
    displayName: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    presetKey: "siliconflow",
    pattern: /^(siliconflow|deepseek-ai\/|qwen\/|meta-llama\/|stabilityai\/|black-forest-labs\/)/i
  },
  {
    id: "provider-openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    presetKey: "openrouter",
    pattern: /^(openrouter|anthropic\/|google\/|openai\/|x-ai\/|mistralai\/|meta-llama\/)/i
  },
  {
    id: "provider-moonshot",
    displayName: "Moonshot AI",
    baseUrl: "https://api.moonshot.cn/v1",
    presetKey: "moonshot",
    pattern: /^(moonshot|kimi|moonshot-v1)/i
  },
  {
    id: "provider-minimax",
    displayName: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    presetKey: "minimax",
    pattern: /^(minimax|abab)/i
  },
  {
    id: "provider-xai",
    displayName: "xAI",
    baseUrl: "https://api.x.ai/v1",
    presetKey: "xai",
    pattern: /^(grok-|xai|x-ai)/i
  },
  {
    id: "provider-groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    presetKey: "groq",
    pattern: /^(groq|llama-3|llama3|mixtral|gemma)/i
  }
];

export function inferOpenAiCompatibleProviderForModel(
  model: string,
  existing?: Pick<InferredModelProvider, "id" | "displayName" | "baseUrl"> | null
): InferredModelProvider | null {
  const trimmedModel = model.trim();
  const preset = openAiCompatibleProviderPresets.find((candidate) =>
    candidate.pattern.test(trimmedModel)
  );
  if (preset) {
    return {
      id: preset.id,
      displayName: preset.displayName,
      baseUrl: presetBaseUrl(preset),
      presetKey: preset.presetKey,
      source: "preset"
    };
  }

  if (existing?.baseUrl.trim()) {
    return {
      id: existing.id,
      displayName: existing.displayName,
      baseUrl: existing.baseUrl,
      source: "existing"
    };
  }

  return null;
}

function presetBaseUrl(preset: ProviderPreset) {
  const envKey = `HONEYCOMB_PROVIDER_PRESET_${String(preset.presetKey ?? preset.id)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`;
  const override = process.env[envKey]?.trim();
  return override || preset.baseUrl;
}

export function isLikelyImageGenerationModel(model: string) {
  return /^(dall-e|gpt-image-|imagen|cogview|wanx|seedream|doubao.*image|flux|stable-diffusion)/i.test(
    model.trim()
  );
}
