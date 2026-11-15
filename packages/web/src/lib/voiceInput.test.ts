import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTranscript,
  collectTranscripts,
  describeSpeechRecognitionError,
  resolveSpeechRecognitionConstructor,
} from "./voiceInput";

test("appendTranscript joins dictated text with sensible spacing", () => {
  assert.equal(appendTranscript("", "  hello   world "), "hello world");
  assert.equal(appendTranscript("Fix the bug", "in the parser"), "Fix the bug in the parser");
  assert.equal(appendTranscript("Fix the bug ", "now"), "Fix the bug now");
  assert.equal(appendTranscript("line one\n", "line two"), "line one\nline two");
  assert.equal(appendTranscript("keep me", "   "), "keep me");
  assert.equal(appendTranscript("   ", "fresh"), "fresh");
});

test("collectTranscripts separates final and interim results from resultIndex on", () => {
  const results = {
    length: 3,
    0: { isFinal: true, length: 1, 0: { transcript: "already handled " } },
    1: { isFinal: true, length: 1, 0: { transcript: "open the " } },
    2: { isFinal: false, length: 1, 0: { transcript: "pull request" } },
  };
  assert.deepEqual(collectTranscripts({ resultIndex: 1, results }), {
    finalText: "open the ",
    interimText: "pull request",
  });
  assert.deepEqual(collectTranscripts({ resultIndex: 3, results }), { finalText: "", interimText: "" });
});

test("resolveSpeechRecognitionConstructor prefers the standard name and tolerates absence", () => {
  class Standard {}
  class Prefixed {}
  assert.equal(resolveSpeechRecognitionConstructor({ SpeechRecognition: Standard, webkitSpeechRecognition: Prefixed }), Standard);
  assert.equal(resolveSpeechRecognitionConstructor({ webkitSpeechRecognition: Prefixed }), Prefixed);
  assert.equal(resolveSpeechRecognitionConstructor({}), null);
  assert.equal(resolveSpeechRecognitionConstructor({ SpeechRecognition: "nope" }), null);
  assert.equal(resolveSpeechRecognitionConstructor(undefined), null);
});

test("describeSpeechRecognitionError ignores benign endings and explains real failures", () => {
  assert.equal(describeSpeechRecognitionError("no-speech"), null);
  assert.equal(describeSpeechRecognitionError("aborted"), null);
  assert.equal(describeSpeechRecognitionError(undefined), null);
  assert.match(describeSpeechRecognitionError("not-allowed") ?? "", /Microphone access was blocked/);
  assert.match(describeSpeechRecognitionError("audio-capture") ?? "", /No microphone/);
  assert.match(describeSpeechRecognitionError("something-else") ?? "", /stopped unexpectedly/);
});
