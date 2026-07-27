import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDispatcherSendBody,
  canSendDispatcherDraft,
  filterDispatcherContextFiles,
  normalizeDispatcherAttachmentPaths,
  resolveDispatcherAttachmentLabel,
  shouldSendDispatcherComposerOnEnter,
  type DispatcherContextFile,
} from "./dispatcherComposerState";

const FILES: DispatcherContextFile[] = [
  { path: "docs/spec.md", displayPath: "docs/spec.md", name: "spec.md", kind: "file", source: "workspace" },
  { path: "src/app.ts", displayPath: "src/app.ts", name: "app.ts", kind: "file", source: "workspace" },
  { path: "docs/spec.md", displayPath: "docs/spec.md", name: "spec.md", kind: "file", source: "workspace" },
];

test("normalizeDispatcherAttachmentPaths trims and deduplicates draft attachments", () => {
  assert.deepEqual(
    normalizeDispatcherAttachmentPaths([" docs/spec.md ", "src/app.ts", "docs/spec.md", ""]),
    ["docs/spec.md", "src/app.ts"],
  );
});

test("filterDispatcherContextFiles applies search and keeps unique paths", () => {
  assert.deepEqual(
    filterDispatcherContextFiles(FILES, "spec").map((file) => file.path),
    ["docs/spec.md"],
  );
  assert.deepEqual(
    filterDispatcherContextFiles(FILES, "").map((file) => file.path),
    ["docs/spec.md", "src/app.ts"],
  );
});

test("buildDispatcherSendBody preserves attachment-only sends", () => {
  assert.deepEqual(
    buildDispatcherSendBody("   ", ["docs/spec.md"]),
    {
      message: "",
      attachments: ["docs/spec.md"],
    },
  );
});

test("canSendDispatcherDraft allows either text or attachments", () => {
  assert.equal(
    canSendDispatcherDraft({
      message: "Review this",
      attachments: [],
      canContinue: true,
      sending: false,
      isActiveInstalled: true,
    }),
    true,
  );
  assert.equal(
    canSendDispatcherDraft({
      message: "   ",
      attachments: ["docs/spec.md"],
      canContinue: true,
      sending: false,
      isActiveInstalled: true,
    }),
    true,
  );
  assert.equal(
    canSendDispatcherDraft({
      message: "   ",
      attachments: [],
      canContinue: true,
      sending: false,
      isActiveInstalled: true,
    }),
    false,
  );
});

test("canSendDispatcherDraft blocks sends when the session cannot continue, is already sending, or the agent is inactive", () => {
  assert.equal(
    canSendDispatcherDraft({
      message: "Review this",
      attachments: [],
      canContinue: false,
      sending: false,
      isActiveInstalled: true,
    }),
    false,
  );
  assert.equal(
    canSendDispatcherDraft({
      message: "Review this",
      attachments: [],
      canContinue: true,
      sending: true,
      isActiveInstalled: true,
    }),
    false,
  );
  assert.equal(
    canSendDispatcherDraft({
      message: "Review this",
      attachments: [],
      canContinue: true,
      sending: false,
      isActiveInstalled: false,
    }),
    false,
  );
});

test("resolveDispatcherAttachmentLabel prefers display paths", () => {
  assert.equal(
    resolveDispatcherAttachmentLabel("docs/spec.md", FILES[0]),
    "docs/spec.md",
  );
  assert.equal(
    resolveDispatcherAttachmentLabel("docs/other.md", null),
    "docs/other.md",
  );
});

test("shouldSendDispatcherComposerOnEnter only submits plain Enter below xl", () => {
  assert.equal(
    shouldSendDispatcherComposerOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      isDesktopXl: false,
    }),
    true,
  );
  assert.equal(
    shouldSendDispatcherComposerOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      isDesktopXl: true,
    }),
    false,
  );
  assert.equal(
    shouldSendDispatcherComposerOnEnter({
      key: "Enter",
      shiftKey: true,
      isComposing: false,
      isDesktopXl: false,
    }),
    false,
  );
  assert.equal(
    shouldSendDispatcherComposerOnEnter({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      isDesktopXl: false,
    }),
    false,
  );
  assert.equal(
    shouldSendDispatcherComposerOnEnter({
      key: "a",
      shiftKey: false,
      isComposing: false,
      isDesktopXl: false,
    }),
    false,
  );
});
