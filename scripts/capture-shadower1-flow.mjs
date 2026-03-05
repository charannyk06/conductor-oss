#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer";

const BASE_URL = (process.env.UI_BASE_URL ?? "http://localhost:4747").replace(/\/+$/, "");
const OUTPUT_DIR = path.resolve(process.cwd(), "docs", "screenshots", "shadower-1");
const VIEWPORT = { width: 1720, height: 1180 };
const TIMEOUT_MS = 45_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeGoto(page, pathname = "/") {
  await page.goto(`${BASE_URL}${pathname}`, {
    waitUntil: "networkidle2",
    timeout: TIMEOUT_MS,
  });
}

async function waitForReady(page) {
  await page.waitForFunction(
    () => {
      const bodyText = document.body?.textContent ?? "";
      return bodyText.includes("Projects") && bodyText.includes("Chat");
    },
    { timeout: TIMEOUT_MS },
  );
}

async function clickButtonByText(page, text, exact = true) {
  const target = String(text).trim().toLowerCase();
  const buttons = await page.$$("button");
  for (const button of buttons) {
    const value = await button.evaluate((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
    const normalized = value.toLowerCase();
    const match = exact ? normalized === target : normalized.includes(target);
    if (match) {
      await button.click();
      return true;
    }
  }
  return false;
}

async function getLatestShadowerSessionId() {
  const response = await fetch(`${BASE_URL}/api/sessions`);
  if (!response.ok) return null;

  const payload = (await response.json()) ?? {};
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const shadowerSessions = sessions.filter((session) => session?.projectId === "shadower");
  if (shadowerSessions.length === 0) return null;

  shadowerSessions.sort((a, b) => {
    const ta = new Date(a.createdAt ?? 0).getTime();
    const tb = new Date(b.createdAt ?? 0).getTime();
    return tb - ta;
  });

  return shadowerSessions[0]?.id ?? null;
}

async function snapshot(page, fileName, label) {
  const out = path.join(OUTPUT_DIR, fileName);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`  saved: ${path.relative(process.cwd(), out)}${label ? ` (${label})` : ""}`);
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

  await safeGoto(page, "/");
  await waitForReady(page);

  // Ensure shadower project is active in sidebar
  await clickButtonByText(page, "shadower", true);
  await sleep(650);
  await snapshot(page, "01-shadower-chat-home.png", "chat-home");

  // Board view for real task/column state
  await clickButtonByText(page, "Board", true);
  await sleep(900);
  await snapshot(page, "02-shadower-board.png", "board");

  // Return to chat panel
  await clickButtonByText(page, "Chat", true);
  await sleep(650);
  await snapshot(page, "03-shadower-chat-panel.png", "chat-panel");

  // Open latest real shadower session directly
  const sessionId = await getLatestShadowerSessionId();
  if (!sessionId) {
    throw new Error("Unable to locate a shadower session from /api/sessions");
  }
  await safeGoto(page, `/sessions/${encodeURIComponent(sessionId)}`);
  await sleep(1000);
  await snapshot(page, "04-shadower-session-overview.png", "session-overview");

  // Session Chat tab
  await clickButtonByText(page, "Chat", true);
  await sleep(800);
  await snapshot(page, "05-shadower-session-chat.png", "session-chat");

  // Session Diff tab
  await clickButtonByText(page, "Diff", true);
  await sleep(900);
  await snapshot(page, "06-shadower-session-diff.png", "session-diff");

  // New workspace modal from sidebar
  await safeGoto(page, "/");
  await waitForReady(page);
  await clickButtonByText(page, "New", true);
  await sleep(700);
  await snapshot(page, "07-new-workspace-dialog.png", "new-workspace-dialog");

  await browser.close();
  console.log(`\nDone. Screenshots written to ${path.relative(process.cwd(), OUTPUT_DIR)}`);
}

run().catch((error) => {
  console.error(`Capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
