# 飞书 + OpenClaw + Temporal + Postgres 高级版实施路线图

目标：在飞书群内实现一个单一 `main-agent` 作为用户任务入口、任务拆解者、子 Agent 调度者、结果汇总者和最终负责人。子 Agent 只负责专业阶段产物；每个阶段完成后必须交给 `test-agent` 测试，通过后再进入下一阶段，失败则退回原子 Agent 修复，连续失败 3 次后等待用户决策。

## 1. 当前 Agent 清单

只需要这 6 个 Agent：

```text
main-agent：唯一入口、任务拆解、流程调度、状态维护、最终汇总和用户汇报。
research-agent：根据任务搜索资料、事实、来源、竞品、背景、风险和约束。
writer-agent：写文案、文章、脚本、故事、标题、总结等文字产物。
image-agent：生成图片 brief、图片提示词或图片产物路径。
video-agent：生成视频 brief、分镜、视频提示词或视频产物路径。
test-agent：每阶段质量闸门，只测试，不修改业务产物。
```

明确不需要：

```text
planner-agent：任务拆解归 main-agent。
executor-agent：通用执行角色暂时不要，避免职责模糊。
copy-agent：文案职责归 writer-agent。
```

## 2. 核心工作流

```text
用户在飞书群下任务
  -> main-agent 创建 job 并拆解阶段
  -> research-agent / writer-agent / image-agent / video-agent 按需执行
  -> 子 Agent 完成后由编排服务把 artifact 交给 test-agent
  -> test-agent PASS：编排服务把上一阶段 artifact 交给下一个子 Agent
  -> test-agent FAIL：编排服务把测试报告交回原子 Agent 修复
  -> 连续 FAIL 3 次：编排服务停止本任务并等待用户决策
  -> 所有阶段 PASS：test-agent 总结测试情况并交给 main-agent
  -> main-agent 汇总最终结果并回复用户
```

飞书群只作为显示屏：群里看到的 `@main-agent`、`@writer-agent`、`@test-agent` 等开头，是编排服务发给用户看的状态更新；真正的接力、输入输出传递、测试闸门和重试逻辑全部由 Temporal + Postgres 决定，不依赖飞书群里的 @ 触发，也不需要每个 agent 一个飞书应用身份。

## 3. 动态拆解原则

`main-agent` 不套固定模板，而是根据用户任务动态决定阶段：

```text
需要网上资料、最新信息、事实来源、竞品或背景：加入 research-agent。
需要文字内容、文案、脚本、文章、总结：加入 writer-agent。
需要图片、海报、封面、插画、配图或图片提示词：加入 image-agent。
需要视频、短片、动画、分镜或视频提示词：加入 video-agent。
需要多个产物时，前一阶段输出必须成为后一阶段输入。
```

示例只是示例，不是固定流程：

```text
用户要“写宣传文案再生成配图”
  -> writer-agent
  -> test-agent
  -> image-agent
  -> test-agent
  -> main-agent 汇总
```

如果用户要“查行业资料并写一篇文章”：

```text
research-agent
  -> test-agent
  -> writer-agent
  -> test-agent
  -> main-agent 汇总
```

如果用户只要“查一下某主题资料”：

```text
research-agent
  -> test-agent
  -> main-agent 汇总
```

## 4. 基础设施职责

```text
飞书群：真人任务入口、可见显示屏、状态通知、人工确认；不作为 agent-to-agent 控制总线。
OpenClaw：真实 Agent 运行时。
Temporal：无状态 Harness，负责任务排队、可靠编排、系统失败重试、等待人工决策。
Postgres：append-only Session ledger + 任务状态、阶段、尝试、测试报告、artifact、群消息记录、归档/保留期。
Tool Gateway：外部工具边界，密钥不进入 prompt。
```

## 5. 数据契约

阶段输出必须写 artifact，而不是把正文全刷到群里：

```text
stages/<stage>/output.md
state/stage-{N}-{type}-output.json
state/stage-{N}-{type}-test.json
agent-work-log.md
```

`output.json` 至少包含：

```json
{
  "summary": "...",
  "handoff": {
    "nextStageInput": "...",
    "notes": "..."
  }
}
```

测试报告第一行必须机器可读：

```markdown
### 判定：PASS
```

或：

```markdown
### 判定：FAIL
```

## 6. 失败策略

系统失败：

```text
网络超时、OpenClaw 调用失败、飞书 API 失败、数据库短暂错误
  -> Temporal Activity 自动重试
```

业务失败：

```text
test-agent 判定 FAIL
  -> 不让 Temporal 盲目重跑
  -> 编排服务把测试报告路由回原子 Agent
  -> 原子 Agent 根据测试报告修复
  -> 原 test-agent 复测
  -> 最多 3 次
```

## 6.1 任务日志与经验库生命周期

每次新任务创建独立 session ledger，作为本任务中枢。任务结束后不立刻删除，而是：

```text
1. 写入 archived_at
2. 写入 retention_until
3. cleanup_status=retained
4. 追加 job.archived 事件
```

保留期后可运行维护脚本清理重型中间目录：

```text
npm run maintenance:cleanup-sessions          # dry-run
npm run maintenance:cleanup-sessions -- --apply
```

长期经验库不属于任务日志，不能随任务清理：

```text
经验库-资料.md
经验库-文案.md
经验库-图片.md
经验库-视频.md
```

## 7. 创建真实 Agent 前的当前状态

本地流水线已经具备：

```text
POST /jobs
POST /webhooks/feishu/events
GET /jobs/:jobId
GET /jobs/:jobId/details
JobPipelineWorkflow
Postgres schema
agent.agent_events append-only session ledger
job archived_at / retention_until / cleanup_status lifecycle
group_messages 可见消息总线记录
main-agent 动态规划 research/writer/image/video 阶段
test-agent PASS/FAIL/三次失败等待人工
Feishu adapter：未配置凭证时 dry-run；配置单个飞书机器人后统一发送显示消息
OpenClaw adapter：默认 mock，OPENCLAW_AGENT_MODE=real 后调用 WSL OpenClaw CLI
```

OpenClaw 中保留 6 个 Agent：

```text
main-agent
research-agent
writer-agent
image-agent
video-agent
test-agent
```

配置单个飞书 app 凭证和群 `chat_id` 后，同一条 `group_messages` 路径会发送到真实飞书群；消息里的 `@下一个agent` 是展示文本，本地 `senderAgentId` / `mentionAgentId` 才是编排记录。

## 8. 验收标准

```text
1. 飞书新任务只进入 main-agent。
2. main-agent 能动态拆阶段，不依赖 planner-agent。
3. 子 Agent 完成后，编排服务把产物交给 test-agent，并在群里显示状态。
4. test-agent PASS 后，编排服务把 artifact 交给下一个子 Agent。
5. test-agent FAIL 后，编排服务把测试报告交回原子 Agent 返工。
6. 连续失败 3 次后进入 waiting_for_human。
7. 最终结果由 main-agent 汇总并回复用户。
8. Postgres 能查完整 job/stage/attempt/review/group_message。
9. Temporal UI 能看到 workflow 状态、失败和重试。
10. 大产物只保存为 artifact，群里只发摘要和路径。
```
