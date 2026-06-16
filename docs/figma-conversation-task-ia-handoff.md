# Figma Handoff: Conversation + Task IA

Status: waiting on Figma MCP quota.

Target file:
https://www.figma.com/design/kKMnDmAbXBxQZT2SE7CgRm

Latest retry:

```text
2026-06-14: use_figma read-only inspection of file kKMnDmAbXBxQZT2SE7CgRm
failed with:
"You've reached the Figma MCP tool call limit on the Starter plan."
```

## Frame To Create

Create one editable desktop frame:

```text
Honeycomb Conversation + Task IA
1440 x 980
```

Use two adjacent screens inside the frame:

- Left screen: Conversations, using a Codex-like project/conversation structure
  inside Honeycomb's dark operations theme.
- Right screen: Tasks.

The point of the Figma design is to make the product split obvious:

- Conversations = user intake, pinned items, projects, project actions,
  per-project conversation summaries, dark chat pane, message composer.
- Tasks = progress, sub-agent state, task list, selected timeline.

## Conversations Screen

Structure:

```text
App shell
- Left rail
- Section sidebar
  - Pinned
  - Project header dropdown
  - Collapse / more / add project actions
  - Add-project menu
    - New blank project
    - Use existing folder
  - Overflow menu
    - New conversation
    - Pin / unpin current conversation
  - Project rows
  - Conversation summary rows under each project
- Conversation canvas
  - Top bar: current project path / more / task monitor shortcut
  - Assistant message
  - Bottom rounded composer
    - Plus button
    - Access status
    - Smart routing badge
    - Model/call-limit control
    - Send button
```

Recommended labels:

- Pinned
- Projects
- New blank project
- Use existing folder
- Panel agent
- Type a task or message
- Full access
- Send
- Smart routing

## Tasks Screen

Structure:

```text
App shell
- Left rail
- Task monitor
  - Header: Task Runs
  - CTA back to Conversations
  - Selected job progress bar
  - Sub-agent status cards
- Summary strip
  - Running jobs
  - Total jobs
  - Latest job
- Main workspace
  - Task list and filters
  - Selected task timeline
```

Recommended sub-agent cards:

- main-agent
- research-agent
- writer-agent
- image-agent
- video-agent
- test-agent

## Visual Direction

Use the current Honeycomb dark operational palette. The reference screenshots
are for structure and density only; do not copy Codex's light theme or attempt
a one-to-one replica. Keep the result simple and scan-friendly:

```text
Canvas background  #0F131A
Panel background   #151922
Inset surface      #11151C
Border             #252A32
Primary text       #FFFFFF
Secondary text     #AEB8C7
Muted text         #8C97A7
Accent blue        #76D0FF
Success green      #66D196
Warning amber      #F5C96C
Danger red         #E46D6D
Radius             6 px
```

Avoid a landing-page feel. This is a local operations tool: dense, clear, and
calm.

## Resume Steps When Figma Quota Returns

1. Use `figma-use` before every `use_figma` call.
2. Inspect the existing file before writing.
3. Search for design system components if the file contains any existing
   published components or variables.
4. Create the wrapper frame away from existing nodes.
5. Build the Conversations screen first.
6. Build the Tasks screen second.
7. Take a screenshot of the wrapper frame and check for clipped text,
   overlapping panels, or blank placeholders.
8. Update `docs/task-page-redesign.md`, `docs/conversation-task-ia.md`, and the
   external context files with the final Figma node ID.
