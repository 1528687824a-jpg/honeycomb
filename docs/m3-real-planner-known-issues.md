# M3 Real Planner Known Issues

This note tracks expected failure modes when `m3:generate` uses a real
OpenAI-compatible chat-completions provider instead of the mock planner.

## Contract

The real planner must return one JSON object in
`choices[0].message.content`. Markdown fences and surrounding prose are tolerated
only when a JSON object can still be extracted.

Accepted stage roles are:

```text
research
writing
image
video
```

The generator validates roles and maps them to local Agent OpenClaw agent IDs.
Unsupported roles fail fast because otherwise the DBOS worker would create a
cluster that cannot run.

## Common Failure Modes

```text
non_json_response
  The provider returns prose, Markdown, or tool-call shaped data without an
  extractable JSON object.

unsupported_role
  The provider invents roles such as planner, editor, reviewer, seo, or social.
  Add those roles to the local catalog only when the runtime has matching agent
  prompts and stage semantics.

empty_stage_list
  The provider returns no stages or a top-level schema that does not contain
  stages[].

invalid_routing_mode
  The provider returns a routing mode outside the local ROUTING_MODES list.

over_planning
  The provider expands a small interview into too many stages. The system prompt
  asks for the smallest useful sequence, but real models may still over-plan.

provider_timeout
  The provider does not respond before M3_PLANNER_TIMEOUT_SECONDS.
```

## Existing Guardrails

```text
Role validation:
  scripts/generate-cluster-config.ts rejects unsupported stage roles.

Routing-mode validation:
  invalid defaultRoutingMode values are ignored and the interview/default value
  is used instead.

Secret handling:
  M3_PLANNER_API_KEY is read only from local environment. It is never written to
  generated cluster.config.json.

Real-provider E2E:
  npm run smoke:m3-real-provider requires M3_PLANNER_BASE_URL,
  M3_PLANNER_MODEL, and M3_PLANNER_API_KEY. It generates a real-planner cluster,
  starts the orchestrator in mock OpenClaw mode, posts a job, and verifies the
  generated stage sequence is what DBOS executed.
```

## Triage Rule

If `smoke:m3-real-provider` fails, keep the provider response local and inspect
only the structural reason. Do not paste API keys, authorization headers, or full
provider payloads into issues or context files.
