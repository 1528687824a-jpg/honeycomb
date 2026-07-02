const CONTEXT_MARKERS = [
  "\n\n[Honeycomb ",
  "\n\n[Honeycomb",
  "\n\n\u3010Honeycomb",
  "\n[Honeycomb "
];

const TITLE_FALLBACK = "\u4efb\u52a1";

function compactPrompt(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function stripSoftRequestPrefix(value: string) {
  return value
    .replace(/^(?:\u5e2e\u6211|\u8bf7|\u9ebb\u70e6|\u7ed9\u6211|\u6211\u60f3\u8981|\u6211\u8981|\u9700\u8981|please|can you|could you)\s*/i, "")
    .replace(/^(?:\u505a|\u5236\u4f5c|\u8bbe\u8ba1|\u751f\u6210|\u5199|\u64b0\u5199|\u6574\u7406|\u521b\u5efa|\u5efa\u7acb)\s*/i, "")
    .replace(/^(?:\u4e00\u4e2a|\u4e00\u4efd|\u4e00\u5f20|\u4e2a|\u4efd|\u5f20)\s*/i, "")
    .trim();
}

function cleanTitle(value: string) {
  return compactPrompt(value)
    .replace(/^[\s"'`\u201c\u201d\u300c\u300d\u300e\u300f]+|[\s"'`\u201c\u201d\u300c\u300d\u300e\u300f]+$/g, "")
    .replace(/(?:\u53ef\u4ee5\u5417|\u884c\u5417|\u597d\u5417|\u5c31\u884c\u4e86|\u5c31\u884c|please)$/i, "")
    .trim();
}

function limitedTitle(value: string) {
  const cleaned = cleanTitle(stripSoftRequestPrefix(value));
  return cleaned.length > 24 ? cleaned.slice(0, 24) : cleaned;
}

function isGenericTheme(value: string) {
  return /^(?:\u4e3b\u9898|\u98ce\u683c|\u6d77\u62a5|\u56fe\u7247|\u89c6\u9891|\u6587\u6848|\u4efb\u52a1)$/i.test(value);
}

function themeFromPrompt(prompt: string) {
  const themeMatch = prompt.match(
    /(?:\u4e3b\u9898|\u4e3b\u9898\u662f|\u4e3b\u9898\u4e3a|\u4e3b\u9898\u70ba|theme)\s*(?:\u662f|\u4e3a|\u70ba|:|\uff1a)?\s*([^,\uff0c\u3002\uff1b;\n.!?\uff01\uff1f\u3001]{1,18})/i
  );
  const theme = themeMatch ? cleanTitle(themeMatch[1]) : "";
  return theme && !isGenericTheme(theme) ? theme : "";
}

export function userTaskPrompt(rawPrompt: string) {
  const prompt = rawPrompt.trim();
  const markerIndex = CONTEXT_MARKERS.reduce<number | null>((earliest, marker) => {
    const index = prompt.indexOf(marker);
    if (index < 0) {
      return earliest;
    }
    return earliest === null ? index : Math.min(earliest, index);
  }, null);

  return (markerIndex === null ? prompt : prompt.slice(0, markerIndex)).trim();
}

export function inferJobDisplayTitle(rawPrompt: string) {
  const prompt = compactPrompt(userTaskPrompt(rawPrompt));
  if (!prompt) {
    return TITLE_FALLBACK;
  }

  const theme = themeFromPrompt(prompt);
  const asksPoster = /\u6d77\u62a5|\u6d77\u5831|poster/i.test(prompt);
  const asksPromotion = /\u5ba3\u4f20|\u5ba3\u50b3|\u63a8\u5e7f|\u63a8\u5ee3|promo/i.test(prompt);

  if (theme && asksPoster) {
    if (/\u6d77\u62a5|\u6d77\u5831|poster/i.test(theme)) {
      return limitedTitle(theme);
    }
    return `${limitedTitle(theme)}${asksPromotion ? "\u5ba3\u4f20\u6d77\u62a5" : "\u6d77\u62a5"}`;
  }

  const chineseTask = prompt.match(
    /(?:\u5e2e\u6211|\u8bf7|\u9ebb\u70e6|\u7ed9\u6211|\u6211\u60f3\u8981|\u6211\u8981|\u9700\u8981)?\s*(?:\u505a|\u5236\u4f5c|\u8bbe\u8ba1|\u751f\u6210|\u5199|\u64b0\u5199|\u6574\u7406|\u521b\u5efa|\u5efa\u7acb)?\s*(?:\u4e00\u4e2a|\u4e00\u4efd|\u4e00\u5f20)?\s*([^,\uff0c\u3002\uff1b;\n.!?\uff01\uff1f]{2,24}?(?:\u5ba3\u4f20\u6d77\u62a5|\u5ba3\u50b3\u6d77\u5831|\u6d77\u62a5|\u6d77\u5831|\u5ba3\u4f20\u56fe|\u5ba3\u50b3\u5716|\u56fe\u7247|\u5716\u7247|\u89c6\u9891|\u8996\u983b|\u6587\u6848|\u62a5\u544a|\u5831\u544a|\u65b9\u6848|PPT|ppt))/i
  );
  if (chineseTask) {
    return limitedTitle(chineseTask[1]);
  }

  const englishTask = prompt.match(/([a-z][a-z0-9\s-]{1,40}?(?:poster|image|video|copy|report|plan|deck|presentation))/i);
  if (englishTask) {
    return limitedTitle(englishTask[1]).replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  return limitedTitle(prompt.slice(0, 24)) || TITLE_FALLBACK;
}
