export type DesktopNotificationPayload = {
  id: string;
  title: string;
  body: string;
  tag?: string;
};

export type DesktopNotificationResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "default" | "denied" };

const seenStorageKey = "honeycomb.desktopNotifications.seen.v1";
const maxSeenIds = 500;

export function loadSeenNotificationIds() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(seenStorageKey) || "[]");
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set<string>();
  }
}

export function saveSeenNotificationIds(ids: Set<string>) {
  try {
    window.localStorage.setItem(
      seenStorageKey,
      JSON.stringify([...ids].slice(-maxSeenIds))
    );
  } catch {
    // Notification de-duping is best-effort; never break the app on storage errors.
  }
}

export function canUseDesktopNotifications() {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function showDesktopNotification(
  payload: DesktopNotificationPayload
): Promise<DesktopNotificationResult> {
  if (!canUseDesktopNotifications()) {
    return { ok: false, reason: "unsupported" };
  }

  let permission = window.Notification.permission;
  if (permission === "default") {
    permission = await window.Notification.requestPermission();
  }

  if (permission !== "granted") {
    return { ok: false, reason: permission };
  }

  const notification = new window.Notification(payload.title, {
    body: payload.body,
    tag: payload.tag ?? payload.id,
    silent: false
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };

  return { ok: true };
}
