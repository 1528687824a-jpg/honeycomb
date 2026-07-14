# Artifact Destination Authorization

Honeycomb treats a task plan's destination as a request, not as permission to
write to the local machine. Permission is resolved and persisted separately.

## Target contract

| Target | `targetPath` meaning | Required authority |
| --- | --- | --- |
| `conversation` | Must be `null` | Implicit conversation delivery |
| `desktop` | Must be `null` | OS desktop directory selected by Tauri |
| `workspace` | Relative destination directory inside the job `workdir` | Exact enabled `registered_workspaces` root |
| `custom` | Absolute destination directory explicitly requested by the user | Active `artifact_destination_grants` root containing that directory |

The panel Agent may propose `targetPath`, but that value never creates or
extends authority.

## Persisted delivery snapshot

`agent.artifact_deliveries` stores:

- `authorization_status`: `authorized`, `required`, `revoked`, or `invalid`;
- `authorization_kind`: implicit conversation/desktop, registered workspace,
  or custom grant;
- authority ID, approved root, relative directory, resolved directory, and any
  authorization error.

Authorization is refreshed immediately before a delivery lease is claimed.
Retries use the same requested destination. An expired or revoked authority
blocks a delivery that has not been claimed.

A lease already issued while authority was active may complete until its short
lease expires. This avoids interrupting an atomic write halfway through. A new
claim after revocation is denied.

## Custom grant API

Custom grants use the existing tool-approval gateway:

1. Create a high-risk approval using tool `artifact.destination.grant`, action
   `artifact_destination_grant`, target
   `artifact-destination://<normalized-root-key>`, and command
   `Grant artifact delivery to <normalized-root>`.
2. Approve it through the normal approval API.
3. Call `POST /artifact-destination-grants` with that approval ID.

Available routes:

- `GET /artifact-destination-grants`
- `POST /artifact-destination-grants`
- `POST /artifact-destination-grants/:grantId/revoke`
- `POST /workspaces/:workspaceId/revoke`

Re-enabling a revoked root requires a fresh approval and registration/grant
request. Revocation itself needs no elevated approval because it only removes
authority.

## Write boundary

The API returns the approved root descriptor only in a successful claim. The
Tauri writer receives the approved root and root-relative directory, then:

1. rejects network/device roots and unsafe relative components;
2. canonicalizes the root and destination;
3. verifies links and directory junctions still resolve inside the root;
4. streams into a same-directory temporary file;
5. validates size and SHA-256, flushes, then atomically renames;
6. reports the actual path, size, and checksum.

For workspace/custom delivery, the backend also rejects completion receipts
whose parent directory or collision-safe file name does not match the persisted
destination snapshot.

Run `npm run smoke:artifact-destination-authorization` with PostgreSQL available
to verify registration, grant refresh, path boundaries, revocation, and leased
completion behavior.
