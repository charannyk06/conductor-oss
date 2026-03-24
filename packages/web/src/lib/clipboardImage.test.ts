import assert from "node:assert/strict";
import test from "node:test";
import {
  extractFilesFromTransfer,
  extractImageFromClipboard,
} from "./clipboardImage";

test("extractImageFromClipboard returns the first clipboard image file", () => {
  const imageFile = { name: "clipboard.png", type: "image/png", size: 1024 } as File;
  const clipboard = {
    items: [
      {
        kind: "string",
        type: "text/plain",
        getAsFile: () => null,
      },
      {
        kind: "file",
        type: "image/png",
        getAsFile: () => imageFile,
      },
    ],
  } as unknown as DataTransfer;

  assert.equal(extractImageFromClipboard(clipboard), imageFile);
});

test("extractImageFromClipboard falls back to clipboard files when available", () => {
  const imageFile = { name: "paste.jpg", type: "image/jpeg", size: 2048 } as File;
  const clipboard = {
    files: [imageFile],
    items: [],
  } as unknown as DataTransfer;

  assert.equal(extractImageFromClipboard(clipboard), imageFile);
});

test("extractFilesFromTransfer returns dropped files in order", () => {
  const droppedFiles = [
    { name: "one.txt", type: "text/plain", size: 10 } as File,
    { name: "two.png", type: "image/png", size: 20 } as File,
  ];
  const transfer = {
    files: droppedFiles,
  } as unknown as DataTransfer;

  assert.deepEqual(extractFilesFromTransfer(transfer), droppedFiles);
});

test("extractFilesFromTransfer returns an empty array for empty transfers", () => {
  assert.deepEqual(extractFilesFromTransfer(undefined), []);
  assert.deepEqual(extractFilesFromTransfer(null), []);
});
