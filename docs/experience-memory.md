# Experience Memory

Agent OpenClaw already records durable job history: job events, agent events,
messages, artifacts, reviews, final outputs, retention policy, and timeline
cursor pagination. Historical design notes also reserved long-term experience
files such as:

```text
经验库-资料.md
经验库-文案.md
经验库-图片.md
经验库-视频.md
```

This page captures the product direction for turning that raw history into a
usable "experience memory" layer.

## Why It Matters

The product should not only run one task. It should improve from prior tasks:

```text
what the maintainer prefers
which routing modes work for which job types
which generated prompts pass review
which failure patterns repeat
which artifacts became reusable examples
```

The goal is not to copy an external memory product. The goal is to make Agent
OpenClaw's own durable timeline and artifacts useful to future jobs.

## Inspiration To Absorb

Modern AI memory products make two ideas clear:

```text
1. Memory is more than logs. It should extract facts, preferences, and recent
   context from prior interactions.
2. Retrieval should combine knowledge-base search with personalized/job-specific
   memory, instead of making users know exactly what to ask for.
```

For Agent OpenClaw, that maps naturally onto:

```text
job timeline       -> what happened
artifacts          -> what was produced
test reviews       -> what quality gates caught
final summaries    -> what worked
experience files   -> what should be preserved across job cleanup
```

## V1 Shape

Start with a local-first implementation:

```text
1. Summarize each completed job into a compact experience record.
2. Store records under job/workspace/project scopes.
3. Preserve the four experience files outside per-job cleanup.
4. Surface relevant prior experience in M3 cluster generation.
5. Show retrieved experience in the desktop timeline or a dedicated memory tab.
```

No external memory API is required for v1. Later adapters can export or sync
experience memory to external systems if users want that.

## Non-Goals For Alpha

```text
Not required before v0.1.0-alpha.
Do not block owner tryout or first public release on this.
Do not send private job artifacts to an external provider without explicit
operator authorization.
Do not treat all logs as memory; extract only durable lessons and preferences.
```

## Open Questions

```text
Should experience records live in Postgres, workspace files, or both?
Should retrieval run through local full-text search first, then optional vector
search later?
Which agent owns memory extraction: main-agent, test-agent, or a future
memory-agent?
Should the desktop UI expose memory as a separate tab or as annotations inside
job detail?
```
