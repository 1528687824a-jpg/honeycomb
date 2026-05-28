# OpenClaw 主/子 Agent 创建清单

当前系统已经能用 mock agent 跑通：

```text
main-agent 拆阶段 -> child agent -> test-agent -> fail repair -> retest -> main-agent final
```

下一步需要在 OpenClaw/ClawPanel 里创建真实 Agent。创建完成后，orchestrator 才能把 mock activities 替换成真实 OpenClaw 调用。

## 必须创建的 Agent

请先创建这 6 个 Agent，名称必须保持一致：

```text
main-agent
research-agent
writer-agent
image-agent
video-agent
test-agent
```

不再创建：

```text
planner-agent
executor-agent
copy-agent
```

原因：

```text
main-agent 负责拆解任务和最终汇总。
writer-agent 负责文案/文章/脚本等文字产物。
research-agent 负责资料搜索和事实整理。
image-agent 负责图片 brief、图片提示词或图片产物。
video-agent 负责视频 brief、分镜、视频提示词或视频产物。
test-agent 负责每阶段测试和返工闸门。
```

## 飞书绑定规则

飞书群现在是可见消息总线。所有 Agent 可以在群里发消息和被 @，但用户只应该把新任务交给：

```text
main-agent
```

子 Agent 只响应工作流里的 @mention，不主动接用户的新任务。

## Agent 工作目录建议

```text
main-agent      -> openclaw-work/main
research-agent  -> openclaw-work/research
writer-agent    -> openclaw-work/writer
image-agent     -> openclaw-work/image
video-agent     -> openclaw-work/video
test-agent      -> openclaw-work/test
```

每个 Agent 必须独立 workspace，避免上下文和产物互相污染。

## 模型建议

如果现在只用 DeepSeek，可以先这样配：

```text
main-agent      deepseek/deepseek-v4-pro 或 deepseek/deepseek-reasoner
research-agent  deepseek-research/deepseek-v4-pro
writer-agent    deepseek-writer/deepseek-v4-pro
image-agent     deepseek-writer/deepseek-v4-pro（实际图片生成走 doubao-seedream-5-0-260128）
video-agent     deepseek-writer/deepseek-v4-pro（实际视频生成走 doubao-seedance-2-0-260128）
test-agent      zai/glm-5.1
```

`deepseek-writer` 是独立 provider，使用自己的 `apiKey`，不要复用 main-agent 的 `deepseek` provider key。

## Prompt 模板位置

把下面这些文件里的内容分别复制到对应 Agent 的系统提示词里：

```text
platform-assets/openclaw-agent-templates/agents/main-agent.md
platform-assets/openclaw-agent-templates/agents/research-agent.md
platform-assets/openclaw-agent-templates/agents/writer-agent.md
platform-assets/openclaw-agent-templates/agents/image-agent.md
platform-assets/openclaw-agent-templates/agents/video-agent.md
platform-assets/openclaw-agent-templates/agents/test-agent.md
```

## 配置参考

多 Agent 配置参考：

```text
platform-assets/openclaw-agent-templates/config/openclaw.multi-agent.example.json
```

这只是参考模板，不要直接覆盖 ClawPanel 当前运行配置。先在 UI 或实际配置入口里创建 Agent，确认能看到 6 个 Agent 后再接 orchestrator。

## 创建完成后的验收

创建完成后请确认：

```text
1. OpenClaw/ClawPanel 里能看到 6 个 Agent。
2. 飞书新任务只交给 main-agent。
3. 子 Agent 只响应流程里的 @mention。
4. 每个 Agent 有独立 workspace。
5. 每个 Agent 的 prompt 已复制对应模板。
6. 每个 Agent 能使用需要的基础工具。
```

完成后回来告诉我：“Agent 已创建”。我会继续接真实 OpenClaw 调用，把 mock agent 替换掉。

## 当前创建进度

已在 WSL OpenClaw 里创建：

```text
writer-agent    model: deepseek-writer/deepseek-v4-pro
research-agent  model: deepseek-research/deepseek-v4-pro
video-agent     model: deepseek-writer/deepseek-v4-pro
image-agent     model: deepseek-writer/deepseek-v4-pro
```

最新命名调整：

```text
旧 image-agent 已改名为 video-agent，专门负责生成视频。
新的 image-agent 专门负责生成图片，图片 endpoint 为 doubao-seedream-5-0-260128。
```

已写入 prompt：

```text
/home/administrator/.openclaw/workspace/writer-agent/AGENTS.md
/home/administrator/.openclaw/workspace/video-agent/AGENTS.md
/home/administrator/.openclaw/workspace/image-agent/AGENTS.md
/home/administrator/.openclaw/agents/writer-agent/agent/AGENTS.md
/home/administrator/.openclaw/agents/video-agent/agent/AGENTS.md
/home/administrator/.openclaw/agents/image-agent/agent/AGENTS.md
```

图片生成 provider 已配置，模型为 `openai/doubao-seedream-5-0-260128`。本机 WSL 的 OpenClaw openai 图片 provider 已加火山方舟 b64 兼容补丁，API key 已写入本机 WSL 的 OpenClaw 配置，不要打印或写入文档。

Seedance 2.0 视频生成是异步任务，标准版可能超过 OpenClaw BytePlus provider 原本的 120 秒默认等待时间。本机已把 BytePlus 视频 provider 默认超时补到 600000ms；以后升级 OpenClaw 后如补丁丢失，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\platform-assets\vendor-workarounds\openclaw\patch-ark-media.ps1
```

test-agent 已接入智谱 GLM-5.1：

```text
provider：models.providers.zai
baseUrl：https://api.z.ai/api/paas/v4
model：zai/glm-5.1
API key：已写入本机 WSL 的 OpenClaw 配置，不要打印或写入文档。
```

research-agent 已接入独立 DeepSeek provider：

```text
provider：models.providers.deepseek-research
baseUrl：https://api.deepseek.com
model：deepseek-research/deepseek-v4-pro
API key：已写入本机 WSL 的 OpenClaw 配置，不要打印或写入文档。
```
