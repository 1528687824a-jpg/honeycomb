# HONEYC~3 Phase Plan Notes

Date: 2026-06-12

Source context: external review file `HONEYC~3.MD`.

## Confirmed State

The review confirmed that the HONEYC~2 Windows-local security baseline is closed
for S1 through S6 at commit `e07a9ce`. It also noted that per-agent MCP policy,
MCP discovery, worker/API dependency cleanup, and an initial unit-test entry are
already ahead of the earlier plan.

## Next Recommendations

1. Do not let `server.ts` and `main.tsx` keep growing while adding search,
   browser, and schedule features. Add a dedicated architecture cleanup window.
2. Expand unit coverage beyond `web-tools`:
   - approval expiry and consume boundaries
   - workspace registration target/path validation
   - API auth token parsing and public route rules
   - MCP policy matching
3. Before remote/iOS exposure:
   - Replace SSE query tokens with short-lived tickets or cookie-based auth.
   - Add per-device token issuance/revocation instead of copying the local admin
     token to phones.
   - Cache DPAPI reads in-process with a TTL and avoid plaintext fallback on
     recognized encrypted envelopes.
4. Move external review notes into the repository under `docs/reviews/`.
5. Treat real OpenClaw provider end-to-end validation as the largest remaining
   risk and schedule it before investing heavily in Schedule UI.
6. Add a retrying GitHub push helper because network failures have happened
   repeatedly.

## Proposed Roadmap

- Phase 17E: MCP long-lived session reuse and Phase 17 closeout.
- Phase 18: approval-gated web search and browser automation minimum slice with
  per-agent network/domain policy.
- Phase 18.5: architecture cleanup, route/view extraction, second unit-test
  batch, and CI.
- Phase 19: packaged OpenClaw launch/restart defaults and real provider E2E.
- Phase 20: schedule workspace/model/reasoning policy binding and UI.
- Phase 21.5: first iOS path through hosted API, PWA/mobile UI, per-device
  token, and SSE ticketing.
- Phase 22: Feishu/IM background agent model.
- Phase 23: cross-platform release work, keychain support, installer diagnostics,
  and GitHub Release v0.1.

## Work Started From This Review

- Added in-process TTL caching for local provider secrets.
- Prevented recognized encrypted secret envelopes from falling back to legacy
  plaintext migration when decrypt fails.
- Added second unit-test coverage for approval policy, API auth, workspace
  registration targets, MCP policy checks, and secret cache behavior.
- Added `test:unit` to CI.
- Updated Docker quickstart CI to use the local API token.
- Added `scripts/git-push.ps1` with retries.
