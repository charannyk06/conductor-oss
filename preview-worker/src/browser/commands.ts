import type { KeyInput } from "puppeteer-core";
import type { BrowserManager } from "./BrowserManager.js";
import type { PreviewSession, WorkerCommandRequest, WorkerCommandResponse } from "../lib/types.js";
import { snapshotElement } from "./dom.js";

export async function handleWorkerCommand(
  manager: BrowserManager,
  session: PreviewSession,
  command: WorkerCommandRequest,
): Promise<WorkerCommandResponse> {
  switch (command.command) {
    case "status":
      return {
        kind: "status",
        ...(await manager.buildStatus(session, command.candidateUrls)),
      };
    case "dom": {
      const dom = await manager.inspectDom(session, command.frameId ?? null, command.interactiveOnly ?? false);
      return { kind: "dom", ...dom };
    }
    case "screenshot": {
      const screenshot = await manager.takeScreenshot(session);
      if (!screenshot) {
        throw manager.error(404, "Preview is not connected");
      }
      return {
        kind: "screenshot",
        imageBase64: Buffer.from(screenshot).toString("base64"),
      };
    }
    case "connect":
    case "navigate":
      await manager.connect(session, command.url);
      return {
        kind: "status",
        ...(await manager.buildStatus(session, [])),
      };
    case "reload":
      try {
        await session.page.reload({ waitUntil: "domcontentloaded" });
        session.lastError = null;
      } catch (error) {
        session.lastError = error instanceof Error ? error.message : "Failed to reload preview";
        throw error;
      }
      return {
        kind: "status",
        ...(await manager.buildStatus(session, [])),
      };
    case "selectFrame": {
      const frame = manager.resolveFrame(session, command.frameId);
      session.activeFrameId = manager.ensureFrameId(session, frame);
      session.selectedElement = null;
      session.lastError = null;
      return {
        kind: "status",
        ...(await manager.buildStatus(session, [])),
      };
    }
    case "clickAtPoint": {
      session.selectedElement = null;
      session.lastError = null;

      const navigation = session.page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 1_500 })
        .catch(() => null);

      await session.page.mouse.click(command.x, command.y);
      await navigation;
      await session.page.waitForNetworkIdle({ idleTime: 250, timeout: 1_000 }).catch(() => null);
      return {
        kind: "status",
        ...(await manager.buildStatus(session, [])),
      };
    }
    case "typeText":
      if (command.text) {
        await session.page.keyboard.type(command.text);
      }
      session.lastError = null;
      return {
        kind: "status",
        ...(await manager.buildStatus(session, [])),
      };
    case "pressKey": {
      session.lastError = null;

      const navigation = session.page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 1_500 })
        .catch(() => null);

      await session.page.keyboard.press(command.key as KeyInput);
      await navigation;
      await session.page.waitForNetworkIdle({ idleTime: 250, timeout: 1_000 }).catch(() => null);
      return {
        kind: "status",
        ...(await manager.buildStatus(session, [])),
      };
    }
    case "selectAtPoint": {
      const frame = manager.resolveFrame(session, session.activeFrameId);
      if (frame !== session.page.mainFrame()) {
        throw manager.error(
          400,
          "Point selection is only available for the main frame. Pick nested frame elements from the DOM list.",
        );
      }
      const snapshot = await snapshotElement(frame, undefined, { x: command.x, y: command.y });
      if (!snapshot) {
        throw manager.error(404, "No element found at the selected point");
      }
      session.selectedElement = {
        ...snapshot,
        frameId: manager.ensureFrameId(session, frame),
        frameName: frame.name() || "Main frame",
        frameUrl: frame.url(),
      };
      session.lastError = null;
      return {
        kind: "status",
        ...(await manager.buildStatus(session, [])),
      };
    }
    case "selectBySelector": {
      const frame = manager.resolveFrame(session, command.frameId ?? null);
      const snapshot = await snapshotElement(frame, command.selector);
      if (!snapshot) {
        throw manager.error(404, `Element not found for selector: ${command.selector}`);
      }
      session.selectedElement = {
        ...snapshot,
        frameId: manager.ensureFrameId(session, frame),
        frameName: frame.name() || (frame === session.page.mainFrame() ? "Main frame" : "Frame"),
        frameUrl: frame.url(),
      };
      session.activeFrameId = manager.ensureFrameId(session, frame);
      session.lastError = null;
      return {
        kind: "status",
        ...(await manager.buildStatus(session, [])),
      };
    }
  }
}
