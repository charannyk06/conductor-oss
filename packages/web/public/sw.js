/*
 * Conductor service worker.
 *
 * Deliberately minimal: it exists so the dashboard can be installed and can
 * receive Web Push notifications. It registers no fetch handler and caches
 * nothing, so it can never serve a stale app shell or stale API data.
 */

const DEFAULT_URL = "/bots?view=inbox";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPushPayload(event) {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

// Only same-origin targets are honoured so a push payload cannot send the
// user to an arbitrary site.
function resolveTargetUrl(candidate) {
  try {
    const url = new URL(typeof candidate === "string" && candidate ? candidate : DEFAULT_URL, self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL(DEFAULT_URL, self.location.origin).href;
  } catch {
    return new URL(DEFAULT_URL, self.location.origin).href;
  }
}

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title : "Conductor";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    icon: "/pwa/icon-192.png",
    badge: "/pwa/icon-192.png",
    data: { url: resolveTargetUrl(payload.url) },
  };
  if (typeof payload.tag === "string" && payload.tag) {
    options.tag = payload.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = resolveTargetUrl(event.notification.data && event.notification.data.url);

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windowClients) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        if ("navigate" in client && client.url !== targetUrl) {
          await client.navigate(targetUrl);
        }
        return await client.focus();
      } catch {
        // Fall through to opening a new window.
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});
