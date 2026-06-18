import assert from "node:assert/strict";
import test from "node:test";

import { firstRunInterviewTesting } from "../apps/desktop-app/src/firstRunInterview";

test("first-run work options ignore stale suggestions after role changes", () => {
  const {
    emptyInterview,
    resolveWorkOptions,
    snapshotInterviewSuggestions
  } = firstRunInterviewTesting;
  const staleSuggestions = snapshotInterviewSuggestions(
    {
      roleExamples: [],
      workOptions: [
        "编辑房源美图并添加动态标签引流",
        "实时美化预订回复界面的聊天样式",
        "制作短视频的封面与转场动效",
        "为社交媒体帖子设计统一的视觉模板"
      ],
      qualityExamples: []
    },
    { ...emptyInterview, industry: "民宿领域", role: "民宿平台运营师" },
    "zh"
  );

  const options = resolveWorkOptions(
    { ...emptyInterview, industry: "民宿领域", role: "软件前端美化师" },
    staleSuggestions,
    "zh"
  );

  assert.equal(options.some((option) => /房源|民宿|预订/.test(option)), false, options.join(" / "));
  assert.equal(options.some((option) => /界面|布局|组件|移动端|交互/.test(option)), true, options.join(" / "));
});

test("first-run audience and pressure options prefer revised role over stale industry context", () => {
  const {
    emptyInterview,
    resolveAudienceOptions,
    resolvePressureOptions,
    snapshotInterviewSuggestions
  } = firstRunInterviewTesting;
  const staleSuggestions = snapshotInterviewSuggestions(
    {
      roleExamples: [],
      workOptions: ["调整界面布局和间距"],
      audienceOptions: ["终端用户", "团队成员", "客户或业务方", "投资人/管理层"],
      pressureOptions: ["梳理需求和边界", "排查问题", "写文档和说明", "评审质量风险"],
      qualityExamples: []
    },
    { ...emptyInterview, industry: "软件前端", role: "软件前端美化师", dailyWork: "调整界面布局和间距" },
    "zh"
  );

  const revisedInterview = {
    ...emptyInterview,
    industry: "软件前端",
    role: "保洁阿姨",
    dailyWork: "安排清洁顺序和路线",
    audience: "住户/业主"
  };
  const audienceOptions = resolveAudienceOptions(revisedInterview, staleSuggestions, "zh");
  const pressureOptions = resolvePressureOptions(revisedInterview, staleSuggestions, "zh");

  assert.equal(audienceOptions.includes("终端用户"), false, audienceOptions.join(" / "));
  assert.equal(audienceOptions.includes("住户/业主"), true, audienceOptions.join(" / "));
  assert.equal(pressureOptions.some((option) => /清洁|遗漏|耗材|特殊要求/.test(option)), true, pressureOptions.join(" / "));
});
