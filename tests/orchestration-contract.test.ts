import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDeterministicPanelResult,
  buildDeterministicTaskPlan,
  panelOrchestrationJsonInstruction,
  parsePanelOrchestrationOutput,
  parseStoredTaskOrchestrationPlan
} from "../packages/shared/src/orchestration-contract";

test("panel planning instructions define all four routing behaviors", () => {
  const instruction = panelOrchestrationJsonInstruction();
  assert.match(instruction, /supervisor_pipeline is for quality-sensitive dependent work/);
  assert.match(instruction, /pipeline is for a clear strict sequence/);
  assert.match(instruction, /classic_master_slave is for independent work that should run in parallel/);
  assert.match(instruction, /master_slave_discussion is for ambiguity/);
  assert.match(instruction, /Do not reuse a previous mode mechanically/);
});

test("tea poster fallback selects image only and preserves delivery requirements", () => {
  const plan = buildDeterministicTaskPlan({
    rawPrompt: "帮我做一个宣传海报可以吗？主题是茶道，海报放在桌面上就行了，1080×1920，古典华美，海报上不用有字，PNG格式输出就行"
  });

  assert.equal(plan.title, "茶道宣传海报");
  assert.equal(plan.routingMode, "supervisor_pipeline");
  assert.deepEqual(plan.selectedAgents, ["image-agent"]);
  assert.equal(plan.qualityGate.agentId, "test-agent");
  assert.equal(plan.skippedAgents.some((entry) => entry.agentId === "research-agent"), true);
  assert.equal(plan.skippedAgents.some((entry) => entry.agentId === "writer-agent"), true);
  assert.equal(plan.skippedAgents.some((entry) => entry.agentId === "video-agent"), true);
  assert.deepEqual(plan.deliverables[0], {
    kind: "image",
    description: "Requested image or poster artifact",
    required: true,
    format: "png",
    width: 1080,
    height: 1920,
    target: "desktop",
    targetPath: null
  });
});

test("video fallback adds writing and image help only when the request needs them", () => {
  const plan = buildDeterministicTaskPlan({
    rawPrompt: "生成一个五秒产品宣传视频，先写旁白脚本，再做封面和关键帧，最后输出 MP4 视频"
  });

  assert.equal(plan.routingMode, "pipeline");
  assert.deepEqual(plan.selectedAgents, ["writer-agent", "image-agent", "video-agent"]);
  assert.equal(plan.deliverables.some((entry) => entry.kind === "image"), true);
  assert.equal(plan.deliverables.find((entry) => entry.kind === "video")?.format, "mp4");
});

test("research report fallback selects research then writing", () => {
  const plan = buildDeterministicTaskPlan({
    rawPrompt: "帮我调研 2026 年本地 AI Agent 市场现状和可靠来源，然后写一份总结报告"
  });

  assert.equal(plan.routingMode, "supervisor_pipeline");
  assert.deepEqual(plan.selectedAgents, ["research-agent", "writer-agent"]);
  assert.deepEqual(plan.stages.map((stage) => stage.stageType), ["research", "write"]);
});

test("explicit DOCX desktop work selects writing and preserves the real file requirement", () => {
  const plan = buildDeterministicTaskPlan({
    rawPrompt: "写一份茶道活动总结报告，DOCX 格式，完成后放到桌面"
  });

  assert.deepEqual(plan.selectedAgents, ["writer-agent"]);
  assert.deepEqual(plan.deliverables, [{
    kind: "text",
    description: "Requested task result",
    required: true,
    format: "docx",
    width: null,
    height: null,
    target: "desktop",
    targetPath: null
  }]);
});

test("decision discussion fallback uses discussion mode and multiple viewpoints", () => {
  const plan = buildDeterministicTaskPlan({
    rawPrompt: "请比较本地部署和云部署，组织多方讨论各自取舍后给出方案选择"
  });

  assert.equal(plan.routingMode, "master_slave_discussion");
  assert.deepEqual(plan.selectedAgents, ["research-agent", "writer-agent"]);
});

test("ordinary conversation remains chat when deterministic fallback is used", () => {
  const result = buildDeterministicPanelResult({
    rawPrompt: "你好，为什么 Honeycomb 会使用 Docker？",
    language: "zh",
    warning: "panel_agent_api_key_missing"
  });

  assert.equal(result.intent, "chat");
  assert.equal(result.plan, null);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.warnings, ["panel_agent_api_key_missing"]);
});

test("model JSON output is validated and normalized into the shared contract", () => {
  const rawOutput = JSON.stringify({
    intent: "task",
    reply: "我会只安排图片 Agent 完成这张海报。",
    plan: {
      title: "茶道宣传海报",
      summary: "生成一张无文字的竖版茶道海报。",
      routingMode: "supervisor_pipeline",
      selectedAgents: ["image-agent", "test-agent"],
      skippedAgents: [
        { agentId: "research-agent", reason: "不需要外部资料" },
        { agentId: "video-agent", reason: "不是视频任务" }
      ],
      stages: [
        {
          stageType: "image",
          agentId: "image-agent",
          name: "生成海报",
          objective: "生成茶道宣传海报",
          acceptanceCriteria: ["1080x1920", "无文字", "PNG"],
          maxRetries: 2
        }
      ],
      qualityGate: {
        enabled: false,
        agentId: null,
        acceptanceCriteria: ["检查尺寸、文字和格式"]
      },
      deliverables: [
        {
          kind: "image",
          description: "茶道海报",
          required: true,
          format: "PNG",
          width: 1080,
          height: 1920,
          target: "desktop",
          targetPath: null
        }
      ],
      maxModelCalls: 8,
      blockingQuestions: [],
      rationale: "静态海报只需要图片 Agent，并由测试 Agent 验收。"
    }
  });

  const result = parsePanelOrchestrationOutput({
    rawOutput: `\`\`\`json\n${rawOutput}\n\`\`\``,
    rawPrompt: "帮我做茶道海报",
    allowedAgentIds: ["image-agent", "test-agent"]
  });

  assert.equal(result?.source, "panel-agent");
  assert.deepEqual(result?.plan?.selectedAgents, ["image-agent"]);
  assert.equal(result?.plan?.qualityGate.enabled, true);
  assert.equal(result?.plan?.qualityGate.agentId, "test-agent");
  assert.equal(result?.plan?.deliverables[0].format, "png");
  assert.equal(result?.plan?.maxModelCalls, 20);
  assert.ok(result?.plan && parseStoredTaskOrchestrationPlan(result.plan));

  const unknownAgentOutput = JSON.parse(rawOutput) as any;
  unknownAgentOutput.plan.stages[0].agentId = "invented-agent";
  assert.equal(
    parsePanelOrchestrationOutput({
      rawOutput: JSON.stringify(unknownAgentOutput),
      rawPrompt: "帮我做茶道海报",
      allowedAgentIds: ["image-agent", "test-agent"]
    }),
    null
  );
});

test("invalid model output is rejected instead of being trusted", () => {
  assert.equal(
    parsePanelOrchestrationOutput({
      rawOutput: "I think image-agent should do it.",
      rawPrompt: "生成海报"
    }),
    null
  );
});
