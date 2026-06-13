# Honeycomb Task Page Redesign

Status: local implementation complete; editable Figma canvas pending MCP quota.

Figma file:
https://www.figma.com/design/kKMnDmAbXBxQZT2SE7CgRm

## Problem

The task page is the core surface of Honeycomb. A user should be able to type a
task, understand how it will be dispatched to the agent team, start the job, and
immediately see whether the system accepted the request.

The reported task was:

```text
帮我去设计一个乒乓球的海报宣传图
```

The prior experience failed in two ways:

- The backend accepted the job but the workflow stalled in planning because an
  old desktop cluster config had an empty `description`.
- The task page did not make the dispatch path or launch state obvious, so the
  stalled workflow felt like the button did nothing.

## Implemented Product Shape

The redesigned page is a work surface, not a marketing page. It favors dense,
predictable controls and visible operational state.

Top command center:

- Left: task composer.
- Right: dispatch path.
- Below: job summary strip.
- Main body: job list and selected job timeline.

## Layout Map

Desktop width target: 1440 px.

```text
App shell
├─ Left navigation rail, 256 px
└─ Task workspace
   ├─ Task command center
   │  ├─ Task composer
   │  │  ├─ Eyebrow: New Job
   │  │  ├─ Title: Send Work To The Agent Team
   │  │  ├─ Backend status pill
   │  │  ├─ Large task textarea
   │  │  ├─ Smart routing badge
   │  │  ├─ Budget input
   │  │  ├─ Start Job button
   │  │  └─ Launch state text
   │  └─ Dispatch path panel
   │     ├─ Task Intake
   │     ├─ Routing Choice
   │     ├─ Specialist Agents
   │     └─ Timeline Return
   ├─ Summary strip
   │  ├─ Running jobs
   │  ├─ Total jobs
   │  └─ Latest job
   └─ Job workspace
      ├─ Job list
      │  ├─ Status filters
      │  ├─ Prompt search
      │  ├─ Time filters
      │  └─ Job rows
      └─ Job detail
         ├─ Selected job header
         ├─ Stats: status, created, budget, timeline count
         └─ Timeline events
```

## Copy

English:

- Title: Send Work To The Agent Team
- Subtitle: The panel supervisor reads the task, chooses a routing mode, then
  dispatches specialist agents.
- Dispatch path: Task Intake, Routing Choice, Specialist Agents, Timeline Return
- Empty prompt guard: Describe the task before launching it.
- Offline guard: OpenClaw is not ready yet. Wait until it is online, then launch
  the task.

Chinese:

- Title: 把任务交给 Agent 团队
- Subtitle: 任务会先进入主控 Agent，再按目标派给研究、写作、图像、视频或质检 Agent。
- Dispatch path: 读取任务, 选择编排, 专业 Agent 执行, 时间线回传
- Empty prompt guard: 请先写下要交给 Agent 团队的任务。
- Offline guard: 后端还未就绪，请先等 OpenClaw 变为在线。

## Visual Tokens

The current implementation keeps Honeycomb's existing dark operational palette:

```text
Page background       #0F131A
Panel background      #151922
Inset surface         #11151C
Border                #252A32
Text primary          #FFFFFF
Text secondary        #AEB8C7
Text muted            #8C97A7
Accent blue           #76D0FF
Accent green          #66D196
Accent amber          #F5C96C
Danger                #E46D6D
Radius                6 px
```

## Code Mapping

Implemented in:

- `apps/desktop-app/src/main.tsx`
- `apps/desktop-app/src/styles.css`

Backend dispatch fixes:

- `apps/dbos-worker/src/config/cluster.ts`
- `apps/dbos-worker/src/activities.ts`
- `apps/dbos-worker/src/workflows.ts`
- `apps/desktop-app/src/firstRun.tsx`
- `tests/cluster-config.test.ts`

## Verification Evidence

Validated locally:

```text
npm run test:unit -- cluster-config.test.ts
npm run check
npm --prefix apps/desktop-app run build
npm run smoke:desktop-ui
git diff --check
npm run check:no-secrets
```

Formal Docker verification:

```text
Prompt: 帮我去设计一个乒乓球的海报宣传图
Job: JOB-20260613-2458165D
Status: succeeded
Stages: research-agent, writer-agent, image-agent
```

## Figma Handoff

The Figma file exists, but `use_figma` writes are currently blocked by the
authenticated team's Starter-plan MCP tool-call limit. When quota is available,
create one editable desktop frame named:

```text
Honeycomb Task Page - Redesigned
```

Recommended Figma frame structure:

```text
Frame 1440 x 980
├─ Navigation rail
├─ Task workspace
│  ├─ Task command center
│  │  ├─ Task composer
│  │  └─ Dispatch path
│  ├─ Job summary strip
│  └─ Job list and timeline
```

Use auto layout for every structural container. Use text nodes, frames, and
simple pills rather than a flattened screenshot so the design remains editable.
