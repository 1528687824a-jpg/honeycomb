# Honeycomb Mobile Device Access

## Current Slice

Honeycomb now has a first backend slice for mobile device tokens.

Implemented:

- `agent.mobile_devices` database table.
- Mobile device token issuance.
- Mobile device token verification through the normal bearer-token path.
- Device revocation.
- `last_seen_at` update when a mobile token is used.
- Admin-only device management endpoints.

## Endpoints

All endpoints except `/health` still require authentication.

### List Devices

```http
GET /mobile/devices
GET /mobile/devices?includeRevoked=true
```

Requires the desktop/admin Honeycomb API token.

### Issue Device Token

```http
POST /mobile/devices
Content-Type: application/json

{
  "displayName": "Alice iPhone",
  "platform": "ios",
  "metadata": {}
}
```

Requires the desktop/admin Honeycomb API token.

The returned token is shown once. The database stores only a SHA-256 hash and a
short prefix for display.

### Current Actor

```http
GET /mobile/me
Authorization: Bearer <token>
```

Returns whether the caller is using the admin token or a mobile device token.

### Revoke Device

```http
POST /mobile/devices/:deviceId/revoke
```

Requires the desktop/admin Honeycomb API token. Once revoked, the mobile token
returns `401 invalid_api_token`.

## Verified Locally

Smoke result on 2026-07-03:

```text
issued device: MD-20260703-C883C4E6
mobile token actor: mobile_device
mobile token could read /jobs
after revoke: /mobile/me returned 401
```

## Not Done Yet

This is not a full iOS pairing experience yet. Next backend/UI work:

1. Add short-lived pairing codes or QR codes.
2. Add desktop UI to approve a pairing request.
3. Add per-device scopes/capabilities, so mobile clients cannot call
   desktop-only or high-risk actions.
4. Add short-lived SSE/timeline tickets.
5. Add HTTPS/public ingress deployment guidance.
