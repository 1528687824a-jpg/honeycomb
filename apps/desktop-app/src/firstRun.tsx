import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import {
  personalizePanelAgentPrompts,
  type PanelAgentPromptFile,
  type RoutingMode
} from "./api";
import { HoneycombLogo } from "./brand";
import {
  buildQualityBar,
  buildAudienceOptions,
  buildPressureOptions,
  buildRolePlaceholder,
  buildWorkOptions,
  cleanSuggestionItems,
  emptyInterview,
  inferOutputStyle,
  mergeSelectedWithOther,
  outputStyleDisplayLabels,
  resolveAudienceOptions,
  resolvePressureOptions,
  resolveRolePlaceholder,
  resolveWorkOptions,
  snapshotInterviewSuggestions,
  splitList,
  type InterviewDraft,
  type InterviewSuggestionSnapshot,
  type InterviewSuggestions,
  type Language,
  type PanelOutputStyle
} from "./firstRunInterview";
import {
  buildPanelAgentPromptFiles,
  buildPersonalizedChildAgentPrompt,
  buildPersonalizedPanelSupervisorPrompt
} from "../../../packages/shared/src/panel-agent-prompt-designer";

type SetupStage =
  | "welcome"
  | "welcomeLeaving"
  | "provider"
  | "providerReturning"
  | "providerLeaving"
  | "interview"
  | "thinking"
  | "review"
  | "saving"
  | "openclawInvite";

type ProviderDraft = {
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

let runtimeProviderApiKey = "";

type ProviderConnectionResult = {
  ok: boolean;
  message?: string;
};

type GeneratedAgent = {
  id: string;
  displayName: string;
  role: string;
  prompt: string;
};

type Profile = {
  title: string;
  workPattern: string;
  recommendedRoutingMode: RoutingMode;
  stageAgents: string[];
  outputStyle: PanelOutputStyle;
  summary: string;
};

export type FirstRunFlow = "full" | "panelAgent" | "workProfile";

type FirstRunPanelProps = {
  language: Language;
  onComplete: (nextView?: "dashboard" | "agents" | "settings") => void;
  onCancel?: () => void;
  flow?: FirstRunFlow;
};

type SavedSetupPreview = {
  provider?: Partial<ProviderDraft> & { apiKeyConfigured?: boolean };
  interview?: Partial<InterviewDraft>;
  profile?: Partial<Profile> & { supervisorName?: string };
};

const routingModeDisplayLabels: Record<Language, Record<RoutingMode, string>> = {
  en: {
    supervisor_pipeline: "Supervisor pipeline",
    pipeline: "Sequential pipeline",
    classic_master_slave: "Classic lead-worker mode",
    master_slave_discussion: "Lead-worker discussion mode"
  },
  zh: {
    supervisor_pipeline: "主管流水线模式",
    pipeline: "顺序流水线模式",
    classic_master_slave: "经典主从模式",
    master_slave_discussion: "主从讨论模式"
  }
};

const copyByLanguage = {
  en: {
    heading: "First Run",
    welcomeTitle: "Start creating your first dedicated AI employee",
    supervisorQuestion: "Name your supervisor agent",
    supervisorPlaceholder: "For example: Honeycomb Supervisor",
    welcomeNext: "Next",
    providerEyebrow: "Private provider setup",
    providerTitle: "Start creating your first dedicated AI employee",
    providerIntro:
      "Honeycomb will use this Provider to understand your work, customize dedicated prompts for your Agent team, and later fit into your workflow as the supervisor. Your API key will not be written into generated prompt files. The model can be changed at any time.",
    provider: "Provider",
    baseUrl: "Base URL",
    model: "Model",
    modelPlaceholder: "For example: deepseek-chat",
    apiKey: "API key",
    back: "Back",
    cancelSetup: "Cancel setup",
    connect: "Connect and continue",
    providerMissing: "Add the model and API key to continue.",
    providerReuseHint: "A previous API key is already configured. Leave this blank to reuse it.",
    verifyingProvider: "Verifying connection...",
    providerVerified: "Connection verified.",
    providerVerifyFailed: "Could not verify the model connection. Check the model and API key, then try again.",
    interviewEyebrow: "Work interview",
    interviewTitle: "Tell Honeycomb how you work",
    interviewReason:
      "Your answers let the panel choose a practical routing mode and rewrite each agent prompt around your real work.",
    privacy: "These answers are used only to configure this local panel. They are never uploaded or disclosed.",
    thinking: "Agent is thinking",
    next: "Next",
    reviewTitle: "Your agent team is ready",
    reviewIntro:
      "Review the initial profile Honeycomb inferred. This tailored routing mode is only the starting default; each future task should still be analyzed before choosing the concrete orchestration mode.",
    profile: "Detected profile",
    routing: "Tailored routing mode",
    stages: "Recommended output style",
    write: "Create my agent team",
    saving: "Writing local setup",
    openclawInvite: "Then shall we start configuring multiple agents in OpenClaw to work for you?",
    openclawInviteNo: "No...",
    openclawInviteYes: "Yes!!!",
    openclawInviteSad: "But without multiple agents configured, I won't be able to work QAQ",
    browserSaved: "Setup preview saved locally.",
    q1: "What field do you work in?",
    q1Placeholder: "For example: technology, illustration, photography...",
    q2: "What is your profession or role in this field?",
    q3: "What do you usually work on?",
    q4: "Who do you mainly serve or face?",
    q5: "Which kind of work pressure do you most want Honeycomb to reduce?",
    other: "Other",
    selected: "Selected",
    providerReady: "Provider connected",
    fixedStep: "Question",
    of: "of",
    agents: {
      "panel-supervisor-agent": "Answers panel questions, coordinates planning, routes work, and synthesizes results",
      "research-agent": "Finds context, evidence, constraints, and risks",
      "writer-agent": "Turns upstream work into polished deliverables",
      "image-agent": "Builds visual briefs and image prompts",
      "video-agent": "Builds storyboards and video plans",
      "test-agent": "Checks work against your quality bar"
    }
  },
  zh: {
    heading: "首次启动",
    welcomeTitle: "开始创造您第一个专属AI员工",
    supervisorQuestion: "请给你的主管agent取个名字吧",
    supervisorPlaceholder: "例如：蜂巢主管",
    welcomeNext: "下一步",
    providerEyebrow: "私密大模型配置",
    providerTitle: "开始创造您第一个专属AI员工",
    providerIntro:
      "Honeycomb 会用这个模型服务理解你的工作，并为你的 Agent 团队定制专属提示词。并且之后会融入你的工作流程，充当主管的角色。API Key 不会写入生成的提示词文件。大模型之后可以随时更改",
    provider: "模型服务商",
    baseUrl: "接口地址",
    model: "模型",
    modelPlaceholder: "例如：deepseek-chat",
    apiKey: "API Key",
    back: "上一步",
    cancelSetup: "取消设置",
    connect: "连接并继续",
    providerMissing: "请填写模型和 API Key 后继续。",
    providerReuseHint: "已保存首次启动时配置过的 API Key，留空即可沿用。",
    verifyingProvider: "正在验证连接...",
    providerVerified: "连接验证通过",
    providerVerifyFailed: "无法验证模型连接，请检查模型和 API Key 后重试。",
    interviewEyebrow: "工作访谈",
    interviewTitle: "告诉 Honeycomb 你的工作方式",
    interviewReason:
      "这些回答会帮助面板选择合适的编排方式，并围绕你的真实工作改写每个 Agent 的提示词。",
    privacy: "问题仅供本地面板配置参考，绝不上传、泄露或用于其他用途。",
    thinking: "Agent 正在思考中",
    next: "下一步",
    reviewTitle: "你的 Agent 团队已经准备好",
    reviewIntro:
      "确认 Honeycomb 理解的初始工作画像。这里的编排模式只是为你定制的起步默认值，之后真正执行任务时仍然要根据具体任务再判断适合哪种编排模式。",
    profile: "识别出的工作画像",
    routing: "为你定制的编排模式",
    stages: "输出风格推荐",
    write: "创建我的 Agent 团队",
    saving: "正在写入本地配置",
    openclawInvite: "那我们开始在openclaw上配置多个agent来为你打工吧？",
    openclawInviteNo: "不好...",
    openclawInviteYes: "好的!!!",
    openclawInviteSad: "可是不配置多个agent的话就没办法工作了QAQ",
    browserSaved: "配置预览已保存在本地。",
    q1: "请问一下您工作的领域是？",
    q1Placeholder: "例如：科技领域、绘画领域、摄影领域……",
    q2: "那您是这个领域的什么职业/角色？",
    q3: "请问您平常工作的内容是？",
    q4: "你主要服务或面对的是谁/群体？",
    q5: "你最希望 Honeycomb 帮你减轻哪类工作压力？",
    other: "其他",
    selected: "已选择",
    providerReady: "Provider 已连接",
    fixedStep: "问题",
    of: "/",
    agents: {
      "panel-supervisor-agent": "回答面板问题、负责规划编排、分配工作和最终整合",
      "research-agent": "收集背景、证据、约束和风险",
      "writer-agent": "把上游内容整理成成熟产出",
      "image-agent": "生成视觉 brief 和图片提示词",
      "video-agent": "生成分镜和视频方案",
      "test-agent": "按照你的质量标准检查产出"
    }
  }
} as const;

function slug(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "owner-profile";
}

function loadSavedSetupPreview(): SavedSetupPreview | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("honeycomb.firstRunPreview") || "null") as SavedSetupPreview | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function loadSavedProviderApiKey() {
  if (runtimeProviderApiKey) {
    return runtimeProviderApiKey;
  }
  const legacyKey = window.localStorage.getItem("honeycomb.providerApiKey") || "";
  if (legacyKey) {
    window.localStorage.removeItem("honeycomb.providerApiKey");
    runtimeProviderApiKey = legacyKey;
  }
  return runtimeProviderApiKey;
}

async function loadSavedProviderApiKeyFromDesktop() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const value = await invoke<string | null>("load_provider_api_key");
    return value || "";
  } catch {
    return "";
  }
}

async function saveProviderApiKey(apiKey: string) {
  const trimmed = apiKey.trim();
  if (!trimmed) return;
  runtimeProviderApiKey = trimmed;
  window.localStorage.removeItem("honeycomb.providerApiKey");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_provider_api_key", { payload: trimmed });
  } catch {
    // Browser smoke keeps a runtime-only copy; the desktop build stores it through Tauri.
  }
}

function mergeInterview(saved: SavedSetupPreview | null): InterviewDraft {
  return {
    ...emptyInterview,
    ...(saved?.interview ?? {}),
    outputStyle: saved?.interview?.outputStyle ?? saved?.profile?.outputStyle ?? emptyInterview.outputStyle
  };
}

function inferProfile(interview: InterviewDraft, language: Language): Profile {
  const outputStyle = interview.outputStyle || inferOutputStyle(interview);
  const qualityBar = interview.qualityBar || buildQualityBar({ ...interview, outputStyle }, language);
  const combined = `${interview.role} ${interview.industry} ${interview.dailyWork} ${interview.audience} ${interview.workPressure} ${interview.outputs}`.toLowerCase();
  const outputs = splitList(interview.outputs || interview.dailyWork || interview.workPressure);
  const stageAgents = ["research-agent", "writer-agent"];
  if (/image|visual|poster|cover|photo|图片|视觉|绘画|摄影|海报|封面|修图|插画|设计/.test(combined)) stageAgents.push("image-agent");
  if (/video|short|reel|clip|视频|短视频|分镜/.test(combined)) stageAgents.push("video-agent");

  const recommendedRoutingMode: RoutingMode =
    /review|quality|test|approval|risk|compliance|审核|审查|检查|测试|质量|风险|合规|遗漏/.test(combined)
      ? "supervisor_pipeline"
      : outputs.length >= 3 || splitList(interview.workPressure).length >= 2
        ? "master_slave_discussion"
        : "classic_master_slave";

  return {
    title: `${interview.role || "Owner"} / ${interview.industry || "General work"}`,
    workPattern: interview.dailyWork || "General multi-agent work",
    recommendedRoutingMode,
    stageAgents,
    outputStyle,
    summary: [
      `Role: ${interview.role || "unknown"}`,
      `Domain: ${interview.industry || "unknown"}`,
      `Work: ${interview.dailyWork || "not specified"}`,
      `Audience: ${interview.audience || "not specified"}`,
      `Pressure: ${interview.workPressure || "not specified"}`,
      `Output style: ${outputStyle}`,
      `Quality: ${qualityBar || "not specified"}`
    ].join("\n")
  };
}

function buildAgentPrompt(agentId: string, interview: InterviewDraft, profile: Profile) {
  return buildPersonalizedChildAgentPrompt(agentId, interview, profile);
}

function buildPanelSupervisorPrompt(
  supervisorName: string,
  provider: ProviderDraft,
  interview: InterviewDraft,
  profile: Profile
) {
  return buildPersonalizedPanelSupervisorPrompt({ supervisorName, provider, interview, profile });
}

function buildAgents(interview: InterviewDraft, profile: Profile): GeneratedAgent[] {
  const orderedIds = ["research-agent", "writer-agent", "image-agent", "video-agent", "test-agent"];
  return orderedIds.map((id) => ({
    id,
    displayName: id.replace(/-/g, " "),
    role: id.replace("-agent", ""),
    prompt: buildAgentPrompt(id, interview, profile)
  }));
}

async function buildPanelConfiguredPromptFiles(input: {
  supervisorName: string;
  provider: ProviderDraft;
  interview: InterviewDraft;
  profile: Profile;
  panelAgentId: string;
  childAgentIds: string[];
}): Promise<PanelAgentPromptFile[]> {
  const fallback = buildPanelAgentPromptFiles(input);
  try {
    const response = await personalizePanelAgentPrompts(input);
    const requiredIds = new Set([input.panelAgentId, ...input.childAgentIds]);
    const receivedIds = new Set(response.agents.map((agent) => agent.id));
    if ([...requiredIds].every((id) => receivedIds.has(id))) {
      return response.agents;
    }
  } catch {
    // The first-run flow can run before the local API is online; use the same shared
    // panel-agent prompt designer locally so onboarding still completes offline.
  }
  return fallback;
}

async function saveDesktopSetup(payload: unknown) {
  const serialized = JSON.stringify(payload);
  window.localStorage.setItem("honeycomb.firstRunPreview", serialized);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("save_first_run_setup", { payload: serialized });
  } catch {
    return "";
  }
}

async function invokeDesktopCommand<T>(command: string, args: Record<string, unknown>) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return { available: true, value: await invoke<T>(command, args) };
  } catch (error) {
    return isTauriRuntime() ? { available: true, error } : { available: false, error };
  }
}

function isTauriRuntime() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function errorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function describeProviderError(error: unknown, language: Language, fallback: string) {
  const value = errorText(error);
  const zh = language === "zh";
  if (value.includes("provider_endpoint")) return zh ? "接口地址无效，请检查服务商地址。" : "The provider endpoint is invalid.";
  if (value.includes("provider_network")) return zh ? "无法连接到模型服务，请检查网络或服务商地址。" : "Could not reach the model provider.";
  if (value.includes("provider_status:400")) return zh ? "模型服务拒绝了请求，请检查模型名称是否支持当前接口。" : "The provider rejected the request. Check the model name.";
  if (value.includes("provider_status:401") || value.includes("provider_status:403")) return zh ? "API Key 未通过服务商认证，请检查 key 是否有效。" : "The API key was rejected by the provider.";
  if (value.includes("provider_status:402")) return zh ? "模型服务账户余额或额度不足，请检查服务商控制台。" : "The provider account appears to have insufficient balance or quota.";
  if (value.includes("provider_status:404")) return zh ? "模型服务接口不存在，请检查接口地址。" : "The provider endpoint was not found.";
  if (value.includes("provider_status:429")) return zh ? "模型服务限流了，请稍后重试。" : "The provider rate-limited the request.";
  if (value.includes("provider_empty") || value.includes("provider_response")) return zh ? "模型服务返回内容异常，请稍后重试。" : "The provider returned an invalid response.";
  if (value.includes("provider_json")) return zh ? "模型服务没有返回可解析的访谈建议，已保留本地兜底。" : "The provider did not return parseable suggestions.";
  return fallback;
}

function localInterviewSuggestions(industry: string, role: string, language: Language): InterviewSuggestions {
  const fallbackPlaceholder = buildRolePlaceholder(industry, language);
  const fallbackRoles = fallbackPlaceholder
    .replace(/^例如：|^For example:\s*/i, "")
    .replace(/[.…]+$/g, "")
    .split(/[、,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    roleExamples: cleanSuggestionItems(fallbackRoles, [], 4),
    workOptions: cleanSuggestionItems(buildWorkOptions(role, language), [], 4),
    qualityExamples: [],
    audienceOptions: cleanSuggestionItems(buildAudienceOptions({ ...emptyInterview, industry, role }, language), [], 4),
    pressureOptions: cleanSuggestionItems(buildPressureOptions({ ...emptyInterview, industry, role }, language), [], 4)
  };
}

function sanitizeSuggestions(value: Partial<InterviewSuggestions> | null | undefined, interview: InterviewDraft, language: Language): InterviewSuggestions {
  const { industry, role } = interview;
  const fallback = localInterviewSuggestions(industry, role, language);
  return {
    roleExamples: cleanSuggestionItems(value?.roleExamples, fallback.roleExamples, 4),
    workOptions: cleanSuggestionItems(value?.workOptions, fallback.workOptions, 4),
    qualityExamples: [],
    audienceOptions: cleanSuggestionItems(value?.audienceOptions, buildAudienceOptions(interview, language), 4),
    pressureOptions: cleanSuggestionItems(value?.pressureOptions, buildPressureOptions(interview, language), 4)
  };
}

async function verifyProviderConnection(provider: ProviderDraft) {
  const result = await invokeDesktopCommand<ProviderConnectionResult>("verify_provider_connection", { payload: provider });
  if (result.available) {
    if (result.error) throw new Error(errorText(result.error));
    return result.value;
  }
  await new Promise((resolve) => window.setTimeout(resolve, 260));
  return { ok: true, message: "Browser preview connection accepted." };
}

async function generateInterviewSuggestions(provider: ProviderDraft, interview: InterviewDraft, language: Language) {
  const payload = {
    provider,
    industry: interview.industry,
    role: interview.role,
    dailyWork: interview.dailyWork,
    language
  };
  const result = await invokeDesktopCommand<InterviewSuggestions>("generate_first_run_suggestions", { payload });
  if (result.available) {
    if (result.error) throw new Error(errorText(result.error));
    return sanitizeSuggestions(result.value, interview, language);
  }
  await new Promise((resolve) => window.setTimeout(resolve, 320));
  return sanitizeSuggestions(null, interview, language);
}

export function FirstRunPanel({ language, onComplete, onCancel, flow = "full" }: FirstRunPanelProps) {
  const copy = copyByLanguage[language];
  const savedSetup = useMemo(loadSavedSetupPreview, []);
  const savedProviderApiKey = useMemo(loadSavedProviderApiKey, []);
  const [stage, setStage] = useState<SetupStage>(flow === "workProfile" ? "interview" : "welcome");
  const welcomeTransitionTimer = useRef<number | null>(null);
  const [providerSettled, setProviderSettled] = useState(false);
  const [introTypedOnce, setIntroTypedOnce] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [providerVerifying, setProviderVerifying] = useState(false);
  const [providerVerified, setProviderVerified] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [supervisorName, setSupervisorName] = useState(flow === "full" ? "" : savedSetup?.profile?.supervisorName || "");
  const [typedIntroLength, setTypedIntroLength] = useState(0);
  const [provider, setProvider] = useState<ProviderDraft>({
    providerName: flow === "full" ? "DeepSeek" : savedSetup?.provider?.providerName || "DeepSeek",
    baseUrl: flow === "full" ? "https://api.deepseek.com" : savedSetup?.provider?.baseUrl || "https://api.deepseek.com",
    model: flow === "full" ? "" : savedSetup?.provider?.model || "",
    apiKey: flow === "full" ? "" : savedProviderApiKey
  });
  const [interview, setInterview] = useState<InterviewDraft>(() => (flow === "workProfile" ? mergeInterview(savedSetup) : { ...emptyInterview }));
  const [otherWork, setOtherWork] = useState("");
  const [otherAudience, setOtherAudience] = useState("");
  const [otherPressure, setOtherPressure] = useState("");
  const [interviewSuggestions, setInterviewSuggestions] = useState<InterviewSuggestionSnapshot | null>(null);
  const [error, setError] = useState("");
  const [inviteMood, setInviteMood] = useState<"asking" | "sad" | "happy">("asking");
  const [inviteTypedLength, setInviteTypedLength] = useState(0);

  const rolePlaceholder = useMemo(() => resolveRolePlaceholder(interview.industry, interviewSuggestions, language), [interview.industry, interviewSuggestions, language]);
  const workOptions = useMemo(() => resolveWorkOptions(interview, interviewSuggestions, language), [interview, interviewSuggestions, language]);
  const audienceOptions = useMemo(() => resolveAudienceOptions(interview, interviewSuggestions, language), [interview, interviewSuggestions, language]);
  const pressureOptions = useMemo(() => resolvePressureOptions(interview, interviewSuggestions, language), [interview, interviewSuggestions, language]);
  const profile = useMemo(() => inferProfile(interview, language), [interview, language]);
  const agents = useMemo(() => buildAgents(interview, profile), [interview, profile]);
  const panelSupervisorAgent = useMemo<GeneratedAgent>(() => ({
    id: "panel-supervisor-agent",
    displayName: supervisorName.trim() || copy.supervisorPlaceholder,
    role: "panel-supervisor",
    prompt: buildPanelSupervisorPrompt(supervisorName, provider, interview, profile)
  }), [copy.supervisorPlaceholder, interview, profile, provider, supervisorName]);
  const inviteSpeaker = supervisorName.trim() || copy.supervisorPlaceholder;
  const inviteText = inviteMood === "sad" ? copy.openclawInviteSad : `${inviteSpeaker}:${copy.openclawInvite}`;

  useEffect(() => {
    return () => {
      if (welcomeTransitionTimer.current) {
        window.clearTimeout(welcomeTransitionTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (stage !== "welcome") {
      setTypedIntroLength(copy.providerIntro.length);
      return;
    }

    if (introTypedOnce) {
      setTypedIntroLength(copy.providerIntro.length);
      return;
    }

    setTypedIntroLength(0);
    const interval = window.setInterval(() => {
      setTypedIntroLength((current) => {
        if (current >= copy.providerIntro.length) {
          window.clearInterval(interval);
          setIntroTypedOnce(true);
          return current;
        }
        return current + 1;
      });
    }, language === "zh" ? 34 : 22);
    return () => window.clearInterval(interval);
  }, [copy.providerIntro, introTypedOnce, language, stage]);

  useEffect(() => {
    if (stage !== "openclawInvite") return;
    setInviteTypedLength(0);
    const interval = window.setInterval(() => {
      setInviteTypedLength((current) => {
        if (current >= inviteText.length) {
          window.clearInterval(interval);
          return current;
        }
        return current + 1;
      });
    }, language === "zh" ? 34 : 22);
    return () => window.clearInterval(interval);
  }, [inviteText, language, stage]);

  useEffect(() => {
    if (provider.apiKey.trim()) return;
    loadSavedProviderApiKeyFromDesktop().then((apiKey) => {
      if (!apiKey) return;
      setProvider((current) => current.apiKey.trim() ? current : { ...current, apiKey });
    });
  }, [provider.apiKey]);

  function updateProvider(field: keyof ProviderDraft, value: string) {
    setProvider((current) => ({ ...current, [field]: value }));
    setProviderVerified(false);
  }

  function updateInterview(field: keyof InterviewDraft, value: string) {
    setInterview((current) => {
      const next = { ...current, [field]: value };
      if (field === "industry" || field === "role") {
        next.dailyWork = "";
        next.audience = "";
        next.workPressure = "";
        next.qualityBar = "";
        next.outputStyle = emptyInterview.outputStyle;
      } else if (field === "dailyWork") {
        next.audience = "";
        next.workPressure = "";
        next.qualityBar = "";
        next.outputStyle = emptyInterview.outputStyle;
      } else if (field === "audience") {
        next.workPressure = "";
        next.qualityBar = "";
        next.outputStyle = emptyInterview.outputStyle;
      } else if (field === "workPressure") {
        next.qualityBar = "";
        next.outputStyle = emptyInterview.outputStyle;
      }
      return next;
    });
    if (field === "industry" || field === "role") {
      setInterviewSuggestions(null);
      setOtherWork("");
      setOtherAudience("");
      setOtherPressure("");
    } else if (field === "dailyWork") {
      setOtherAudience("");
      setOtherPressure("");
    } else if (field === "audience") {
      setOtherPressure("");
    }
  }

  function continueWelcome() {
    if (!supervisorName.trim()) return;
    setError("");
    setIntroTypedOnce(true);
    setProviderSettled(false);
    if (welcomeTransitionTimer.current) {
      window.clearTimeout(welcomeTransitionTimer.current);
    }
    setStage("welcomeLeaving");
    welcomeTransitionTimer.current = window.setTimeout(() => {
      welcomeTransitionTimer.current = null;
      setProviderSettled(true);
      setStage((current) => (current === "welcomeLeaving" ? "provider" : current));
    }, 560);
  }

  function returnToWelcome() {
    if (welcomeTransitionTimer.current) {
      window.clearTimeout(welcomeTransitionTimer.current);
      welcomeTransitionTimer.current = null;
    }
    setError("");
    setIntroTypedOnce(true);
    setStage("providerReturning");
    welcomeTransitionTimer.current = window.setTimeout(() => {
      welcomeTransitionTimer.current = null;
      setProviderSettled(false);
      setStage((current) => (current === "providerReturning" ? "welcome" : current));
    }, 560);
  }

  function cancelSetup() {
    onCancel?.();
  }

  async function connectProvider() {
    const canReuseSavedKey = flow !== "full" && savedSetup?.provider?.apiKeyConfigured === true;
    if (!provider.model.trim() || (!provider.apiKey.trim() && !canReuseSavedKey)) {
      setError(copy.providerMissing);
      return;
    }
    if (providerVerifying) return;
    if (welcomeTransitionTimer.current) {
      window.clearTimeout(welcomeTransitionTimer.current);
      welcomeTransitionTimer.current = null;
    }
    setProviderVerifying(true);
    setProviderVerified(false);
    setError("");
    try {
      if (provider.apiKey.trim()) {
        const result = await verifyProviderConnection(provider);
        if (!result?.ok) {
          throw new Error(result?.message || copy.providerVerifyFailed);
        }
      }
      setProviderVerified(true);
      if (flow === "panelAgent") {
        await saveSetup();
        return;
      }
      setStage("providerLeaving");
      window.setTimeout(() => setStage("interview"), 560);
    } catch (caught) {
      setError(describeProviderError(caught, language, copy.providerVerifyFailed));
    } finally {
      setProviderVerifying(false);
    }
  }

  async function thinkThen(nextQuestion: number, refreshSuggestions = false, interviewOverride = interview) {
    setStage("thinking");
    const startedAt = Date.now();
    if (refreshSuggestions) {
      if (provider.apiKey.trim()) {
        try {
          const suggestions = await generateInterviewSuggestions(provider, interviewOverride, language);
          setInterviewSuggestions(snapshotInterviewSuggestions(suggestions, interviewOverride, language));
        } catch (caught) {
          setInterviewSuggestions(snapshotInterviewSuggestions(localInterviewSuggestions(interviewOverride.industry, interviewOverride.role, language), interviewOverride, language));
          setError(describeProviderError(caught, language, ""));
        }
      } else {
        setInterviewSuggestions(snapshotInterviewSuggestions(localInterviewSuggestions(interviewOverride.industry, interviewOverride.role, language), interviewOverride, language));
      }
    }
    const remaining = Math.max(180, 950 - (Date.now() - startedAt));
    window.setTimeout(() => {
      setQuestionIndex(nextQuestion);
      setStage("interview");
    }, remaining);
  }

  async function continueInterview() {
    setError("");
    if (questionIndex === 0) {
      if (!interview.industry.trim()) return;
      await thinkThen(1, true);
      return;
    }
    if (questionIndex === 1) {
      if (!interview.role.trim()) return;
      await thinkThen(2, true);
      return;
    }
    if (questionIndex === 2) {
      const work = mergeSelectedWithOther(interview.dailyWork, otherWork);
      if (!work.trim()) return;
      const nextInterview = { ...interview, dailyWork: work };
      setInterview(nextInterview);
      await thinkThen(3, false, nextInterview);
      return;
    }
    if (questionIndex === 3) {
      const audience = mergeSelectedWithOther(interview.audience, otherAudience);
      if (!audience.trim()) return;
      const nextInterview = { ...interview, audience };
      setInterview(nextInterview);
      await thinkThen(4, false, nextInterview);
      return;
    }
    const workPressure = mergeSelectedWithOther(interview.workPressure, otherPressure);
    if (!workPressure.trim()) return;
    const outputStyle = inferOutputStyle({ ...interview, workPressure });
    const nextInterview = {
      ...interview,
      workPressure,
      outputStyle,
      qualityBar: buildQualityBar({ ...interview, workPressure, outputStyle }, language)
    };
    setInterview(nextInterview);
    setStage("review");
  }

  function goBackInterview() {
    setError("");
    if (questionIndex === 0) {
      if (flow === "workProfile") {
        onComplete();
        return;
      }
      setProviderSettled(true);
      setStage("provider");
      return;
    }
    setQuestionIndex((current) => Math.max(0, current - 1));
  }

  function toggleWorkOption(option: string) {
    const selected = splitList(interview.dailyWork);
    const next = selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option];
    updateInterview("dailyWork", next.join("，"));
  }

  function toggleAudienceOption(option: string) {
    const selected = splitList(interview.audience);
    const next = selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option];
    updateInterview("audience", next.join("，"));
  }

  function togglePressureOption(option: string) {
    const selected = splitList(interview.workPressure);
    const next = selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option];
    updateInterview("workPressure", next.join("，"));
  }

  async function saveSetup() {
    setStage("saving");
    await saveProviderApiKey(provider.apiKey);
    const allAgents = [panelSupervisorAgent, ...agents];
    const personalizedPromptFiles = await buildPanelConfiguredPromptFiles({
      supervisorName: panelSupervisorAgent.displayName,
      provider,
      interview,
      profile,
      panelAgentId: panelSupervisorAgent.id,
      childAgentIds: agents.map((agent) => agent.id)
    });
    const clusterConfig = {
      schemaVersion: "agent-openclaw.cluster.v1",
      clusterId: slug(`${interview.role}-${interview.industry}`),
      name: `${interview.role || "Owner"} Agent Cluster`,
      description:
        interview.dailyWork.trim() ||
        interview.qualityBar.trim() ||
        interview.role.trim() ||
        "Honeycomb owner agent cluster",
      defaultRoutingMode: profile.recommendedRoutingMode,
      agents: allAgents.map((agent) => ({
        id: agent.id,
        role: agent.role,
        displayName: agent.displayName,
        promptPath: `agents/${agent.id}/AGENTS.md`,
        capabilities:
          agent.id === "panel-supervisor-agent"
            ? ["panel guidance", "provider setup help", "planning", "routing", "workflow supervision", "final synthesis", "guardrails"]
            : ["specialized work"]
      })),
      stages: profile.stageAgents.map((agentId) => ({
        stageType: agentId.replace("-agent", ""),
        agentId,
        name: agentId.replace(/-/g, " "),
        acceptanceCriteria: ["Use the user's work profile and quality bar."],
        maxRetries: 3
      })),
      generatedAt: new Date().toISOString(),
      source: { planner: "openai-compatible", model: provider.model },
      panelSupervisor: {
        id: panelSupervisorAgent.id,
        displayName: panelSupervisorAgent.displayName,
        promptPath: `agents/${panelSupervisorAgent.id}/AGENTS.md`,
        rules: [
          "answers Honeycomb panel questions only",
          "never includes API keys in prompts",
          "recommends agent-team changes through reviewed configuration steps"
        ]
      }
    };

    await saveDesktopSetup({
      provider: {
        providerName: provider.providerName,
        baseUrl: provider.baseUrl,
        model: provider.model,
        apiKeyConfigured: Boolean(provider.apiKey.trim()) || (flow !== "full" && savedSetup?.provider?.apiKeyConfigured === true)
      },
      interview,
      profile: {
        ...profile,
        supervisorName: panelSupervisorAgent.displayName
      },
      clusterConfig,
      agents: personalizedPromptFiles.map((agent) => ({ path: agent.path, contents: agent.contents }))
    });
    window.localStorage.setItem("honeycomb.panelOutputStyle", profile.outputStyle);
    window.localStorage.setItem("honeycomb.setupCompleted", "true");
    if (flow === "full") {
      window.setTimeout(() => setStage("openclawInvite"), 520);
      return;
    }
    window.setTimeout(onComplete, 520);
  }

  function rejectOpenClawInvite() {
    setInviteMood("sad");
  }

  function acceptOpenClawInvite() {
    setInviteMood("happy");
    window.setTimeout(() => onComplete("agents"), 980);
  }

  function renderSetupHeader() {
    const introText = stage === "welcome" ? copy.providerIntro.slice(0, typedIntroLength) : copy.providerIntro;
    return (
      <div className="setupSharedIntro">
        <div className="welcomeLogoScene">
          <div className="confettiBurst" aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => <span key={index} />)}
          </div>
          <HoneycombLogo size={190} mode="talking" className="welcomeLogo" alt="honeycomb" />
        </div>
        <h1>{copy.welcomeTitle}</h1>
        <p className="typingLead" aria-label={copy.providerIntro}>
          {introText}
          <span className="typingCursor" aria-hidden="true" />
        </p>
      </div>
    );
  }

  function renderSupervisorForm(variant: "settled" | "leaving" | "entering") {
    const canContinue = Boolean(supervisorName.trim());
    const className = [
      "supervisorForm",
      variant === "leaving" ? "slidingOut" : "",
      variant === "entering" ? "entering" : ""
    ].filter(Boolean).join(" ");
    return (
      <div className={className}>
        <label className="supervisorNameField">
          <strong>{copy.supervisorQuestion}</strong>
          <input
            autoFocus
            value={supervisorName}
            placeholder={copy.supervisorPlaceholder}
            onChange={(event) => setSupervisorName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canContinue) {
                continueWelcome();
              }
            }}
          />
        </label>
        <div className="setupInlineActions">
          {flow !== "full" && onCancel ? (
            <button className="secondaryButton setupBack" type="button" onClick={cancelSetup}>
              {copy.cancelSetup}
            </button>
          ) : null}
          <button
            className="primaryButton setupPrimary supervisorNext"
            type="button"
            onClick={continueWelcome}
            disabled={!canContinue}
          >
            {copy.welcomeNext}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  function renderProviderCard(variant: "entering" | "settled" | "returning" | "leaving") {
    const className = ["setupFormCard", "providerFocus", variant].filter(Boolean).join(" ");
    return (
      <div className={className}>
        <div className="providerFields">
          <label>
            {copy.model}
            <input
              value={provider.model}
              placeholder={copy.modelPlaceholder}
              onChange={(event) => updateProvider("model", event.target.value)}
            />
          </label>
          <label>
            {copy.apiKey}
            <span className="apiKeyInputShell">
              <input
                type={showApiKey ? "text" : "password"}
                value={provider.apiKey}
                placeholder={flow !== "full" && savedSetup?.provider?.apiKeyConfigured ? "••••••••" : ""}
                onChange={(event) => updateProvider("apiKey", event.target.value)}
                autoComplete="off"
              />
              <button
                className="apiKeyToggle"
                type="button"
                aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                onClick={() => setShowApiKey((current) => !current)}
              >
                {showApiKey ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </span>
            {flow !== "full" && savedSetup?.provider?.apiKeyConfigured && !provider.apiKey ? <small className="providerReuseHint">{copy.providerReuseHint}</small> : null}
          </label>
        </div>
        {error ? <p className="error">{error}</p> : null}
        {providerVerified && !error ? <p className="providerStatus">{copy.providerVerified}</p> : null}
        <div className="providerActions">
          <div className="setupInlineActions">
            <button className="secondaryButton setupBack" type="button" onClick={returnToWelcome}>
              <ArrowLeft size={16} aria-hidden="true" />
              {copy.back}
            </button>
            {flow !== "full" && onCancel ? (
              <button className="secondaryButton setupBack" type="button" onClick={cancelSetup}>
                {copy.cancelSetup}
              </button>
            ) : null}
          </div>
          <button className="primaryButton setupPrimary" type="button" onClick={() => void connectProvider()} disabled={providerVerifying}>
            <KeyRound size={16} aria-hidden="true" />
            {providerVerifying ? copy.verifyingProvider : copy.connect}
          </button>
        </div>
      </div>
    );
  }

  if (stage === "welcome" || stage === "welcomeLeaving" || stage === "providerReturning") {
    return (
      <section className={`firstRun focusSetup onboardingWelcome ${stage === "welcomeLeaving" ? "transitioning" : ""}`}>
        <div className="setupSharedStage">
          {renderSetupHeader()}
          <div className="setupFormViewport">
            {renderSupervisorForm(stage === "welcomeLeaving" ? "leaving" : stage === "providerReturning" ? "entering" : "settled")}
            {stage === "welcomeLeaving" ? renderProviderCard("entering") : null}
            {stage === "providerReturning" ? renderProviderCard("returning") : null}
          </div>
        </div>
      </section>
    );
  }

  if (stage === "provider" || stage === "providerLeaving") {
    return (
      <section className="firstRun focusSetup onboardingWelcome">
        <div className="setupSharedStage">
          {renderSetupHeader()}
          <div className="setupFormViewport">
            {renderProviderCard(stage === "providerLeaving" ? "leaving" : providerSettled ? "settled" : "entering")}
          </div>
        </div>
      </section>
    );
  }

  if (stage === "thinking") {
    return (
      <section className="firstRun focusSetup">
        <div className="thinkingStage">
          <HoneycombLogo size={104} mode="thinking" />
          <h1>{copy.thinking}</h1>
          <span className="thinkingDots"><i /><i /><i /></span>
        </div>
      </section>
    );
  }

  if (stage === "openclawInvite") {
    return (
      <section className={`firstRun openclawInviteStage ${inviteMood}`}>
        <div className="logoLineField" aria-hidden="true">
          {Array.from({ length: 64 }, (_, index) => <span key={index} />)}
        </div>
        <div className="inviteLightOrb" aria-hidden="true" />
        <div className="openclawLogoScene">
          <div className="inviteConfetti" aria-hidden="true">
            {Array.from({ length: 30 }, (_, index) => <span key={index} />)}
          </div>
          <div className="inviteLogoWrap">
            <HoneycombLogo size={172} mode={inviteMood === "sad" ? "thinking" : "talking"} className="inviteLogo" alt="honeycomb" />
            <span className="inviteTears" aria-hidden="true"><i /><i /></span>
          </div>
          <p className="inviteDialogue" aria-label={inviteText}>
            {inviteText.slice(0, inviteTypedLength)}
            <span className="typingCursor" aria-hidden="true" />
          </p>
          <div className="inviteActions">
            <button className="secondaryButton inviteNo" type="button" onClick={rejectOpenClawInvite}>
              {copy.openclawInviteNo}
            </button>
            <button className="primaryButton inviteYes" type="button" onClick={acceptOpenClawInvite}>
              {copy.openclawInviteYes}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (stage === "review" || stage === "saving") {
    return (
      <section className="firstRun focusSetup">
        <div className={`reviewStage ${stage === "saving" ? "saving" : ""}`}>
          <div className="reviewHeading">
            <HoneycombLogo size={58} mode={stage === "saving" ? "thinking" : "idle"} />
            <div>
              <p className="eyebrow">{flow === "workProfile" ? copy.interviewEyebrow : copy.providerReady}</p>
              <h1>{stage === "saving" ? copy.saving : copy.reviewTitle}</h1>
              <p>{copy.reviewIntro}</p>
            </div>
          </div>
          <dl className="profileSummary">
            <div><dt>{copy.profile}</dt><dd>{profile.title}</dd></div>
            <div><dt>{copy.routing}</dt><dd>{routingModeDisplayLabels[language][profile.recommendedRoutingMode]}</dd></div>
            <div><dt>{copy.stages}</dt><dd>{outputStyleDisplayLabels[language][profile.outputStyle]}</dd></div>
          </dl>
          <div className="agentReviewGrid">
            {[panelSupervisorAgent, ...agents].map((agent) => (
              <article key={agent.id}>
                <Check size={16} aria-hidden="true" />
                <strong>{agent.id}</strong>
                <span>{copy.agents[agent.id as keyof typeof copy.agents]}</span>
              </article>
            ))}
          </div>
          <div className="reviewActions">
            <button className="secondaryButton setupBack" type="button" onClick={() => {
              setStage("interview");
              setQuestionIndex(4);
            }} disabled={stage === "saving"}>
              <ArrowLeft size={16} aria-hidden="true" />
              {copy.back}
            </button>
            <button className="primaryButton setupPrimary" type="button" onClick={saveSetup} disabled={stage === "saving"}>
              <Sparkles size={16} aria-hidden="true" />
              {stage === "saving" ? copy.saving : copy.write}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="firstRun focusSetup">
      <div className="interviewStage">
        <div className="interviewHeader">
          <HoneycombLogo size={74} mode="talking" />
          <div>
            <p className="eyebrow">{copy.interviewEyebrow}</p>
            <h1>{copy.interviewTitle}</h1>
            <p>{copy.interviewReason}</p>
          </div>
        </div>
        <div className="questionProgress">
          <span>{copy.fixedStep} {questionIndex + 1} {copy.of} 5</span>
          <div><i style={{ width: `${((questionIndex + 1) / 5) * 100}%` }} /></div>
        </div>
        <div className="questionCard" key={questionIndex}>
          {questionIndex === 0 ? (
            <label>
              <strong>{copy.q1}</strong>
              <input autoFocus value={interview.industry} placeholder={copy.q1Placeholder} onChange={(event) => updateInterview("industry", event.target.value)} />
            </label>
          ) : null}
          {questionIndex === 1 ? (
            <label>
              <strong>{copy.q2}</strong>
              <input autoFocus value={interview.role} placeholder={rolePlaceholder} onChange={(event) => updateInterview("role", event.target.value)} />
            </label>
          ) : null}
          {questionIndex === 2 ? (
            <div className="workQuestion">
              <strong>{copy.q3}</strong>
              <div className="workOptions">
                {workOptions.map((option) => {
                  const selected = splitList(interview.dailyWork).includes(option);
                  return (
                    <button className={selected ? "workOption selected" : "workOption"} key={option} type="button" onClick={() => toggleWorkOption(option)}>
                      {selected ? <Check size={15} aria-hidden="true" /> : null}
                      {option}
                    </button>
                  );
                })}
              </div>
              <label>
                {copy.other}
                <input value={otherWork} onChange={(event) => setOtherWork(event.target.value)} />
              </label>
            </div>
          ) : null}
          {questionIndex === 3 ? (
            <div className="workQuestion">
              <strong>{copy.q4}</strong>
              <div className="workOptions">
                {audienceOptions.map((option) => {
                  const selected = splitList(interview.audience).includes(option);
                  return (
                    <button className={selected ? "workOption selected" : "workOption"} key={option} type="button" onClick={() => toggleAudienceOption(option)}>
                      {selected ? <Check size={15} aria-hidden="true" /> : null}
                      {option}
                    </button>
                  );
                })}
              </div>
              <label>
                {copy.other}
                <input value={otherAudience} onChange={(event) => setOtherAudience(event.target.value)} />
              </label>
            </div>
          ) : null}
          {questionIndex === 4 ? (
            <div className="workQuestion">
              <strong>{copy.q5}</strong>
              <div className="workOptions">
                {pressureOptions.map((option) => {
                  const selected = splitList(interview.workPressure).includes(option);
                  return (
                    <button className={selected ? "workOption selected" : "workOption"} key={option} type="button" onClick={() => togglePressureOption(option)}>
                      {selected ? <Check size={15} aria-hidden="true" /> : null}
                      {option}
                    </button>
                  );
                })}
              </div>
              <label>
                {copy.other}
                <input value={otherPressure} onChange={(event) => setOtherPressure(event.target.value)} />
              </label>
            </div>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
          <div className="questionActions">
            <div className="setupInlineActions">
              <button className="secondaryButton setupBack interviewBack" type="button" onClick={goBackInterview}>
                <ArrowLeft size={16} aria-hidden="true" />
                {copy.back}
              </button>
              {flow !== "full" && onCancel ? (
                <button className="secondaryButton setupBack" type="button" onClick={cancelSetup}>
                  {copy.cancelSetup}
                </button>
              ) : null}
            </div>
            <button className="primaryButton setupPrimary interviewNext" type="button" onClick={() => void continueInterview()}>
              {copy.next}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
        <p className="privacyNote"><ShieldCheck size={15} aria-hidden="true" />{copy.privacy}</p>
      </div>
    </section>
  );
}
