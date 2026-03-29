#!/usr/bin/env node
/**
 * End-to-end smoke test for the OpenClaw ↔ Conductor dispatcher HTTP contract.
 *
 * Usage:
 *   CONDUCTOR_BACKEND_URL=http://127.0.0.1:4749 CONDUCTOR_SMOKE_PROJECT_ID=demo bun scripts/openclaw-dispatcher-smoke.mjs
 *
 * Optional:
 *   CONDUCTOR_SMOKE_SKIP_CREATE=1     — do not POST /dispatcher if none exists
 *   CONDUCTOR_SMOKE_SKIP_TEARDOWN=1   — do not clear integration after test
 *   CONDUCTOR_SMOKE_DELETE_THREAD=1  — DELETE dispatcher thread after (destructive)
 */
const base = (process.env.CONDUCTOR_BACKEND_URL || "http://127.0.0.1:4748").replace(
  /\/+$/,
  "",
);
const projectId = process.env.CONDUCTOR_SMOKE_PROJECT_ID || "default";
const skipCreate = process.env.CONDUCTOR_SMOKE_SKIP_CREATE === "1";
const skipTeardown = process.env.CONDUCTOR_SMOKE_SKIP_TEARDOWN === "1";

function projectPath(suffix) {
  return `${base}/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}

function withScope(path, threadId, bridgeId, extra = {}) {
  const u = new URL(path);
  if (threadId) u.searchParams.set("threadId", threadId);
  if (bridgeId) u.searchParams.set("bridgeId", bridgeId);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function j(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  const health = await fetch(`${base}/api/health`);
  if (!health.ok) {
    throw new Error(`GET /api/health failed: ${health.status}`);
  }

  let threadId = null;
  let bridgeId = null;

  const list = await j(await fetch(projectPath("/dispatchers")));
  if (!list.ok) {
    throw new Error(`GET /dispatchers failed: ${list.status} ${JSON.stringify(list.data)}`);
  }
  const threads = list.data?.threads;
  if (Array.isArray(threads) && threads.length > 0) {
    threadId = threads[0]?.id ?? null;
    bridgeId = threads[0]?.bridgeId ?? null;
  }

  if (!threadId && !skipCreate) {
    const created = await j(
      await fetch(projectPath("/dispatcher"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceNew: true }),
      }),
    );
    if (!created.ok) {
      throw new Error(`POST /dispatcher failed: ${created.status} ${JSON.stringify(created.data)}`);
    }
    threadId = created.data?.thread?.id ?? null;
    bridgeId = created.data?.thread?.bridgeId ?? null;
    console.log("created dispatcher thread", threadId);
  }

  const feedUrl = withScope(projectPath("/dispatcher/feed"), threadId, bridgeId, { limit: 10 });
  const feed = await j(await fetch(feedUrl));
  if (!feed.ok) {
    console.log("GET /dispatcher/feed", feed.status, "(no dispatcher yet is OK if skip create)");
  } else {
    console.log(
      "GET /dispatcher/feed ok; integration?",
      feed.data?.integration != null,
      "entries",
      Array.isArray(feed.data?.entries) ? feed.data.entries.length : 0,
    );
  }

  if (threadId) {
    const intUrl = withScope(projectPath("/dispatcher/integration"), threadId, bridgeId);
    const patch = await j(
      await fetch(intUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openclawThreadId: "openclaw-smoke-thread",
          openclawSessionId: "openclaw-smoke-session",
        }),
      }),
    );
    if (!patch.ok) {
      throw new Error(`PATCH /dispatcher/integration failed: ${patch.status} ${JSON.stringify(patch.data)}`);
    }
    console.log("PATCH /dispatcher/integration ok");

    const feed2 = await j(await fetch(withScope(projectPath("/dispatcher/feed"), threadId, bridgeId, { limit: 10 })));
    const ocThread = feed2.data?.integration?.openclaw?.threadId;
    if (ocThread !== "openclaw-smoke-thread") {
      console.warn("expected openclawThreadId on feed after PATCH, got", ocThread);
    } else {
      console.log("feed.integration.openclaw.threadId matches PATCH");
    }

    const bindList = await j(
      await fetch(`${projectPath("/dispatcher/bindings")}?provider=openclaw`),
    );
    console.log("GET /dispatcher/bindings (openclaw) status", bindList.status);

    const streamUrl = withScope(projectPath("/dispatcher/feed/stream"), threadId, bridgeId, { limit: 5 });
    const es = await fetch(streamUrl);
    if (!es.ok || !es.body) {
      throw new Error(`GET /dispatcher/feed/stream failed: ${es.status}`);
    }
    const reader = es.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let gotData = false;
    for (let i = 0; i < 50; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("data:")) {
        gotData = true;
        break;
      }
    }
    reader.releaseLock();
    if (!gotData) {
      console.warn("SSE stream: no data line seen quickly (may still be OK)");
    } else {
      console.log("SSE /dispatcher/feed/stream first chunk received");
    }

    if (!skipTeardown) {
      const clear = await j(
        await fetch(intUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openclawThreadId: null, openclawSessionId: null }),
        }),
      );
      if (!clear.ok) {
        console.warn("PATCH clear integration failed", clear.status, clear.data);
      } else {
        console.log("cleared OpenClaw integration binding");
      }

      if (process.env.CONDUCTOR_SMOKE_DELETE_THREAD === "1") {
        const del = await j(
          await fetch(withScope(projectPath("/dispatcher"), threadId, bridgeId), { method: "DELETE" }),
        );
        console.log("DELETE /dispatcher", del.status, del.data?.deletedThreadId ?? "");
      }
    }
  }

  console.log("openclaw-dispatcher smoke OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
