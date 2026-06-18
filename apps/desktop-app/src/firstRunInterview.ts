export type Language = "en" | "zh";
export type PanelOutputStyle = "concise" | "detailed" | "warm" | "formal";

export type InterviewSuggestions = {
  roleExamples: string[];
  workOptions: string[];
  qualityExamples: string[];
  audienceOptions?: string[];
  pressureOptions?: string[];
};

export type InterviewSuggestionSnapshot = InterviewSuggestions & {
  industryKey: string;
  roleKey: string;
  dailyWorkKey: string;
  audienceKey: string;
  language: Language;
};

export type InterviewDraft = {
  industry: string;
  role: string;
  dailyWork: string;
  outputs: string;
  audience: string;
  qualityBar: string;
  workPressure: string;
  outputStyle: PanelOutputStyle;
  constraints: string;
};

export const emptyInterview: InterviewDraft = {
  industry: "",
  role: "",
  dailyWork: "",
  outputs: "",
  audience: "",
  qualityBar: "",
  workPressure: "",
  outputStyle: "concise",
  constraints: ""
};

export const outputStyleDisplayLabels: Record<Language, Record<PanelOutputStyle, string>> = {
  en: {
    concise: "Concise and direct",
    detailed: "Detailed explanation",
    warm: "Warm and natural",
    formal: "Formal and professional"
  },
  zh: {
    concise: "简洁直接",
    detailed: "详细解释",
    warm: "温柔自然",
    formal: "正式专业"
  }
};

export function splitList(input: string) {
  return input
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function mergeSelectedWithOther(selectedText: string, otherText: string) {
  const seen = new Set<string>();
  return [...splitList(selectedText), otherText.trim()]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .join("，");
}

function suggestionKey(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function snapshotInterviewSuggestions(
  suggestions: InterviewSuggestions,
  interview: InterviewDraft,
  language: Language
): InterviewSuggestionSnapshot {
  return {
    ...suggestions,
    industryKey: suggestionKey(interview.industry),
    roleKey: suggestionKey(interview.role),
    dailyWorkKey: suggestionKey(interview.dailyWork),
    audienceKey: suggestionKey(interview.audience),
    language
  };
}

function suggestionsMatch(
  suggestions: InterviewSuggestionSnapshot | null,
  language: Language,
  source: Partial<Pick<InterviewDraft, "industry" | "role" | "dailyWork" | "audience">>
) {
  if (!suggestions || suggestions.language !== language) return false;
  if (source.industry !== undefined && suggestions.industryKey !== suggestionKey(source.industry)) return false;
  if (source.role !== undefined && suggestions.roleKey !== suggestionKey(source.role)) return false;
  if (source.dailyWork !== undefined && suggestions.dailyWorkKey !== suggestionKey(source.dailyWork)) return false;
  if (source.audience !== undefined && suggestions.audienceKey !== suggestionKey(source.audience)) return false;
  return true;
}

export function cleanSuggestionItems(items: string[] | undefined, fallback: string[], limit: number) {
  const seen = new Set<string>();
  const cleaned = [...(items ?? []), ...fallback]
    .map((item) => item.trim().replace(/[.。…]+$/g, ""))
    .filter((item) => item.length > 0 && item.length <= 28)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  return cleaned.slice(0, limit);
}

export function rolePlaceholderFromExamples(examples: string[], industry: string, language: Language) {
  const fallback = language === "zh" ? [`${industry || "该领域"}从业者`, "业务负责人", "一线执行人员"] : [`${industry || "this field"} specialist`, "team lead", "operator"];
  const items = cleanSuggestionItems(examples, fallback, 4);
  return language === "zh" ? `例如：${items.join("、")}……` : `For example: ${items.join(", ")}...`;
}

export function buildRolePlaceholder(industry: string, language: Language) {
  const value = industry.toLowerCase();
  if (/tech|software|ai|科技|软件|人工智能/.test(value)) {
    return language === "zh" ? "例如：产品经理、软件工程师、AI 创业者……" : "For example: product manager, software engineer, AI founder...";
  }
  if (/photo|摄影/.test(value)) {
    return language === "zh" ? "例如：商业摄影师、摄影导演、修图师……" : "For example: commercial photographer, photo director, retoucher...";
  }
  if (/art|paint|illustr|绘画|插画|艺术/.test(value)) {
    return language === "zh" ? "例如：插画师、概念设计师、艺术指导……" : "For example: illustrator, concept artist, art director...";
  }
  if (/agri|farm|crop|农业|农场|种植|养殖|农产品/.test(value)) {
    return language === "zh" ? "例如：种植户、农场主、农业技术员、农产品运营负责人……" : "For example: grower, farm owner, agronomist, produce operations lead...";
  }
  return rolePlaceholderFromExamples([], industry, language);
}

export function buildWorkOptions(role: string, language: Language) {
  const value = role.toLowerCase();
  if (/clean|housekeep|housekeeper|maid|janitor|保洁|清洁|家政|客房|阿姨|卫生/.test(value)) {
    return language === "zh"
      ? ["安排清洁顺序和路线", "检查卫生死角和遗漏", "记录耗材补充和损耗", "和客户确认服务要求"]
      : ["Plan cleaning order and route", "Check missed spots and hygiene", "Track supplies and usage", "Confirm service requirements"];
  }
  if (/front.?end|frontend|ui|ux|interface|web|网页|前端|界面|交互|美化|视觉优化|组件样式/.test(value)) {
    return language === "zh"
      ? ["调整界面布局和间距", "统一颜色字体和组件风格", "修复移动端显示问题", "整理交互动效和视觉反馈"]
      : ["Tune layout and spacing", "Unify color, type, and components", "Fix responsive display issues", "Refine motion and visual feedback"];
  }
  if (/运营|平台|商家|店铺|内容|活动|operation|operator|platform|merchant|content|growth/.test(value)) {
    return language === "zh"
      ? ["规划内容和活动节奏", "跟进用户或商家反馈", "复盘数据和转化问题", "优化规则、流程和话术"]
      : ["Plan content and campaigns", "Follow user or merchant feedback", "Review data and conversion issues", "Improve rules, workflows, and scripts"];
  }
  if (/photo|photographer|retouch|摄影|修图|拍摄/.test(value)) {
    return language === "zh"
      ? ["拍摄策划与脚本", "现场拍摄与灯光", "选片、修图与交付", "客户沟通与报价"]
      : ["Shoot planning and scripts", "On-set shooting and lighting", "Selection, retouching, and delivery", "Client communication and quoting"];
  }
  if (/art|paint|illustr|design|artist|designer|绘画|插画|设计|艺术|美术/.test(value)) {
    return language === "zh"
      ? ["概念探索与参考研究", "草图与视觉方案", "成稿与版本迭代", "作品发布与客户沟通"]
      : ["Concept exploration and research", "Sketches and visual directions", "Final art and iterations", "Publishing and client communication"];
  }
  if (/tech|software|ai|product|engineer|developer|pm|科技|软件|人工智能|产品|工程师|开发|程序员/.test(value)) {
    return language === "zh"
      ? ["需求研究与产品规划", "开发与代码评审", "测试、排错与上线", "文档、发布与用户反馈"]
      : ["Research and product planning", "Development and code review", "Testing, debugging, and release", "Docs, launch, and user feedback"];
  }
  if (/agri|farm|crop|grower|farmer|农业|农场|种植|养殖|农产品|农艺|植保/.test(value)) {
    return language === "zh"
      ? ["种植计划与农事记录", "病虫害巡查与处理", "产量、成本与销售分析", "农资采购与设备维护"]
      : ["Crop planning and field records", "Pest and disease checks", "Yield, cost, and sales analysis", "Input purchasing and equipment upkeep"];
  }
  return language === "zh"
    ? ["资料整理与判断", "方案执行与跟进", "问题记录与复盘", "沟通、交付与汇报"]
    : ["Research and judgment", "Execution and follow-up", "Issue tracking and review", "Communication, delivery, and reporting"];
}

export function buildAudienceOptions(interview: InterviewDraft, language: Language) {
  const roleWork = `${interview.role} ${interview.dailyWork}`.toLowerCase();
  const combined = `${interview.industry} ${roleWork}`.toLowerCase();
  if (/clean|housekeep|housekeeper|maid|janitor|保洁|清洁|家政|客房|阿姨|卫生/.test(roleWork)) {
    return language === "zh"
      ? ["住户/业主", "客户或雇主", "物业/门店负责人", "同班同事"]
      : ["Residents or owners", "Clients or employers", "Property or store leads", "Shift teammates"];
  }
  if (/front.?end|frontend|ui|ux|interface|web|网页|前端|界面|交互|美化|视觉优化|组件样式/.test(roleWork)) {
    return language === "zh"
      ? ["终端用户", "产品/设计团队", "开发团队", "客户或业务方"]
      : ["End users", "Product or design teams", "Development teams", "Clients or business owners"];
  }
  if (/运营|平台|商家|店铺|内容|活动|operation|operator|platform|merchant|content|growth/.test(roleWork)) {
    return language === "zh"
      ? ["平台用户", "商家/合作方", "运营团队", "管理者/决策者"]
      : ["Platform users", "Merchants or partners", "Operations teams", "Managers or decision makers"];
  }
  if (/photo|photographer|摄影|修图|拍摄/.test(combined)) {
    return language === "zh"
      ? ["商业客户", "个人客户", "品牌/运营团队", "平台观众"]
      : ["Commercial clients", "Personal clients", "Brand or operations teams", "Platform audiences"];
  }
  if (/art|paint|illustr|design|artist|designer|绘画|插画|设计|艺术|美术/.test(combined)) {
    return language === "zh"
      ? ["甲方/客户", "粉丝或观众", "产品/品牌团队", "出版或平台方"]
      : ["Clients", "Fans or audiences", "Product or brand teams", "Publishers or platforms"];
  }
  if (/tech|software|ai|product|engineer|developer|pm|科技|软件|人工智能|产品|工程师|开发|程序员/.test(combined)) {
    return language === "zh"
      ? ["终端用户", "团队成员", "客户或业务方", "投资人/管理层"]
      : ["End users", "Team members", "Clients or business owners", "Leaders or investors"];
  }
  if (/agri|farm|crop|grower|farmer|农业|农场|种植|养殖|农产品|农艺|植保/.test(combined)) {
    return language === "zh"
      ? ["农场/基地团队", "客户或采购方", "一线执行人员", "合作社/管理方"]
      : ["Farm or base teams", "Clients or buyers", "Field operators", "Co-ops or managers"];
  }
  return language === "zh"
    ? ["客户", "团队成员", "一线执行人员", "管理者/决策者"]
    : ["Clients", "Team members", "Frontline operators", "Managers or decision makers"];
}

export function buildPressureOptions(interview: InterviewDraft, language: Language) {
  const roleWorkAudience = `${interview.role} ${interview.dailyWork} ${interview.audience}`.toLowerCase();
  const combined = `${interview.industry} ${roleWorkAudience}`.toLowerCase();
  const commonZh = ["重复整理资料", "沟通解释成本", "检查质量和遗漏", "把想法变成交付物"];
  const commonEn = ["Repeating research and cleanup", "Communication overhead", "Quality checks and omissions", "Turning ideas into deliverables"];
  if (/clean|housekeep|housekeeper|maid|janitor|保洁|清洁|家政|客房|阿姨|卫生/.test(roleWorkAudience)) {
    return language === "zh"
      ? ["安排清洁顺序", "检查遗漏死角", "记录客户特殊要求", "整理耗材和补充清单"]
      : ["Planning cleaning order", "Checking missed spots", "Recording special requests", "Organizing supply lists"];
  }
  if (/front.?end|frontend|ui|ux|interface|web|网页|前端|界面|交互|美化|视觉优化|组件样式/.test(roleWorkAudience)) {
    return language === "zh"
      ? ["发现界面不协调", "整理修改优先级", "生成美化建议", "检查响应式和细节"]
      : ["Spotting visual inconsistencies", "Prioritizing improvements", "Generating UI polish suggestions", "Checking responsive details"];
  }
  if (/运营|平台|商家|店铺|内容|活动|operation|operator|platform|merchant|content|growth/.test(roleWorkAudience)) {
    return language === "zh"
      ? ["整理反馈和需求", "生成运营方案", "复盘数据异常", "统一沟通话术"]
      : ["Organizing feedback and needs", "Creating operations plans", "Reviewing data anomalies", "Unifying communication scripts"];
  }
  if (/photo|photographer|摄影|修图|拍摄/.test(combined)) {
    return language === "zh"
      ? ["整理客户需求", "生成拍摄方案", "选片修图说明", "交付前质量检查"]
      : ["Organizing client briefs", "Creating shoot plans", "Selection and retouch notes", "Pre-delivery quality checks"];
  }
  if (/art|paint|illustr|design|artist|designer|绘画|插画|设计|艺术|美术/.test(combined)) {
    return language === "zh"
      ? ["找参考和方向", "整理版本反馈", "写清楚创作说明", "检查风格一致性"]
      : ["Finding references and direction", "Managing iteration feedback", "Writing creative rationale", "Checking style consistency"];
  }
  if (/tech|software|ai|product|engineer|developer|pm|科技|软件|人工智能|产品|工程师|开发|程序员/.test(combined)) {
    return language === "zh"
      ? ["梳理需求和边界", "排查问题", "写文档和说明", "评审质量风险"]
      : ["Clarifying requirements and scope", "Debugging issues", "Writing docs and explanations", "Reviewing quality risks"];
  }
  if (/agri|farm|crop|grower|farmer|农业|农场|种植|养殖|农产品|农艺|植保/.test(combined)) {
    return language === "zh"
      ? ["整理农事记录", "判断病虫害风险", "生成执行方案", "复盘成本和产量"]
      : ["Organizing field records", "Assessing pest and disease risk", "Creating action plans", "Reviewing cost and yield"];
  }
  return language === "zh" ? commonZh : commonEn;
}

export function inferOutputStyle(interview: InterviewDraft): PanelOutputStyle {
  const combined = `${interview.industry} ${interview.role} ${interview.dailyWork} ${interview.audience} ${interview.workPressure}`.toLowerCase();
  if (/政府|政务|企业|管理层|投资人|法务|金融|医疗|合规|正式|汇报|leader|investor|legal|finance|medical|compliance|executive|government/.test(combined)) {
    return "formal";
  }
  if (/教学|培训|研究|分析|方案|技术|开发|排查|复杂|解释|文档|research|analysis|technical|debug|docs|training|explain/.test(combined)) {
    return "detailed";
  }
  if (/客户沟通|粉丝|社群|学生|儿童|患者|个人客户|用户陪伴|community|student|fans|patient|personal client|customer care/.test(combined)) {
    return "warm";
  }
  return "concise";
}

export function buildQualityBar(interview: InterviewDraft, language: Language) {
  const outputStyle = outputStyleDisplayLabels[language][interview.outputStyle || inferOutputStyle(interview)];
  const parts = [
    language === "zh" ? `面向对象：${interview.audience || "未指定"}` : `Audience: ${interview.audience || "not specified"}`,
    language === "zh" ? `减压重点：${interview.workPressure || "未指定"}` : `Pressure relief: ${interview.workPressure || "not specified"}`,
    language === "zh" ? `输出风格：${outputStyle}` : `Output style: ${outputStyle}`
  ];
  return parts.join("；");
}

export function resolveRolePlaceholder(
  industry: string,
  suggestions: InterviewSuggestionSnapshot | null,
  language: Language
) {
  if (suggestionsMatch(suggestions, language, { industry }) && suggestions?.roleExamples.length) {
    return rolePlaceholderFromExamples(suggestions.roleExamples, industry, language);
  }
  return buildRolePlaceholder(industry, language);
}

export function resolveWorkOptions(
  interview: InterviewDraft,
  suggestions: InterviewSuggestionSnapshot | null,
  language: Language
) {
  const scopedSuggestions = suggestionsMatch(suggestions, language, { role: interview.role }) && suggestions?.roleKey
    ? suggestions.workOptions
    : undefined;
  return cleanSuggestionItems(scopedSuggestions, buildWorkOptions(interview.role, language), 4);
}

export function resolveAudienceOptions(
  interview: InterviewDraft,
  suggestions: InterviewSuggestionSnapshot | null,
  language: Language
) {
  const scopedSuggestions = suggestionsMatch(suggestions, language, {
    role: interview.role,
    dailyWork: interview.dailyWork
  })
    ? suggestions?.audienceOptions
    : undefined;
  return cleanSuggestionItems(scopedSuggestions, buildAudienceOptions(interview, language), 4);
}

export function resolvePressureOptions(
  interview: InterviewDraft,
  suggestions: InterviewSuggestionSnapshot | null,
  language: Language
) {
  const scopedSuggestions = suggestionsMatch(suggestions, language, {
    role: interview.role,
    dailyWork: interview.dailyWork,
    audience: interview.audience
  })
    ? suggestions?.pressureOptions
    : undefined;
  return cleanSuggestionItems(scopedSuggestions, buildPressureOptions(interview, language), 4);
}

export const firstRunInterviewTesting = {
  buildAudienceOptions,
  buildPressureOptions,
  buildWorkOptions,
  emptyInterview,
  resolveAudienceOptions,
  resolvePressureOptions,
  resolveWorkOptions,
  snapshotInterviewSuggestions
};
