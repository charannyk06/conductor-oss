"use client";

import { useEffect } from "react";

export const SERVICE_WORKER_URL = "/sw.js";

/** Registers the push/installability service worker once per page load. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      return;
    }
    navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" }).catch(() => {
      // Installability and push are optional enhancements.
    });
  }, []);

  return null;
}
