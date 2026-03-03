#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer";

const cliBaseUrlArg = process.argv.find((arg) => arg.startsWith("--base-url="));
const envBaseUrl = process.env.UI_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL;
const cliBaseUrl = cliBaseUrlArg?.split("=")[1];
const BASE_URL = (cliBaseUrl ?? envBaseUrl ?? "http://localhost:4747").replace(/\/+$/, "");

const OUTPUT_DIR = path.resolve(process.cwd(), "docs", "screenshots");
const VIEWPORT = { width: 1680, height: 1200 };
const TIMEOUT_MS = 45_000;

const STEPS = [
  { file: "01-dashboard-overview.png", label: "overview", run: captureDashboard },
  { file: "02-dashboard-chat.png", label: "chat", run: openChatTab },
  { file: "03-dashboard-review.png", label: "review", run: openReviewTab },
  { file: "04-dashboard-agents.png", label: "agents", run: openAgentsTab },
  { file: "05-launch-session.png", label: "launch", run: openLaunchFlow },
  { file: "06-command-palette.png", label: "command-palette", run: openCommandPalette },
  { file: "07-session-detail.png", label: "session-detail", run: openSessionDetail },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickByText(page, text, selectors = ["button", "a"]) {
  const target = String(text).trim();
  for (const selector of selectors) {
    const handles = await page.$$(selector);
    for (const handle of handles) {
      const label = (await handle.evaluate((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()))
        .trim();
      if (label === target) {
        await handle.click();
        return;
      }
    }
  }
  throw new Error(`Unable to find ${target}`);
}

async function clearOverlays(page) {
  await page.keyboard.press("Escape");
  await sleep(150);
}

async function safeGoto(page, pathname = "/", waitUntil = "networkidle2") {
  await page.goto(`${BASE_URL}${pathname}`, {
    waitUntil,
    timeout: TIMEOUT_MS,
  });
}

async function waitForDashboardReady(page) {
  await page.waitForFunction(() => {
    return Boolean(document.querySelector("button[title='Open command bar']") || document.querySelector("h1"));
  }, { timeout: TIMEOUT_MS });
}

async function snapshot(page, fileName, label) {
  const out = path.join(OUTPUT_DIR, fileName);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`  saved: ${path.relative(process.cwd(), out)}${label ? ` (${label})` : ""}`);
}

async function getSampleSessionId(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/sessions`);
    if (!response.ok) return null;

    const data = (await response.json()) ?? {};
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return sessions[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function openTab(page, tabName) {
  await clearOverlays(page);
  await clickByText(page, tabName, ["button", "a"]);
  await sleep(450);
}

async function openCommandPalette(page, fileName = "06-command-palette.png") {
  await clearOverlays(page);
  const button = await page.$('button[title="Open command bar"]');
  if (button) {
    await button.click();
    await sleep(450);
  } else {
    const modifierKey = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifierKey);
    await page.keyboard.press("KeyK");
    await page.keyboard.up(modifierKey);
    await sleep(450);
  }

  const input = await page.$('input[placeholder="Run command..."]');
  if (!input) {
    throw new Error("Unable to open command palette");
  }
  await snapshot(page, fileName, "command-palette");
}

async function captureDashboard(page, fileName = "01-dashboard-overview.png") {
  await safeGoto(page, "/");
  await waitForDashboardReady(page);
  await snapshot(page, fileName, "overview");
}

async function openChatTab(page, fileName = "02-dashboard-chat.png") {
  await openTab(page, "Chat");
  await snapshot(page, fileName, "chat");
}

async function openReviewTab(page, fileName = "03-dashboard-review.png") {
  await openTab(page, "Review");
  await snapshot(page, fileName, "review");
}

async function openAgentsTab(page, fileName = "04-dashboard-agents.png") {
  await openTab(page, "Agents");
  await snapshot(page, fileName, "agents");
}

async function openLaunchFlow(page, fileName = "05-launch-session.png") {
  await openTab(page, "Overview");
  await clickByText(page, "Launch Session");
  await sleep(450);
  await snapshot(page, fileName, "launch");
}

async function openSessionDetail(page, fileName = "07-session-detail.png") {
  const sessionId = await getSampleSessionId(BASE_URL);
  const pathname = sessionId
    ? `/sessions/${encodeURIComponent(sessionId)}`
    : "/sessions/does-not-exist";

  await clearOverlays(page);
  await safeGoto(page, pathname);
  await snapshot(page, fileName, sessionId ? "session-detail" : "session-not-found");
}

async function run() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  await page.setViewport(VIEWPORT);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  await page.setBypassCSP(true);

  let success = 0;
  for (const step of STEPS) {
    try {
      await step.run(page, step.file);
      success += 1;
    } catch (error) {
      console.warn(`  skipped: ${step.file} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await browser.close();
  console.log(`\\nDone. Screenshots written to ${path.relative(process.cwd(), OUTPUT_DIR)}`);
  console.log(`Generated: ${success} / ${STEPS.length} flows`);
  if (success === 0) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(`Screenshot automation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
