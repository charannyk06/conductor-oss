import test from "node:test";
import assert from "node:assert/strict";
import { iterateSseFrames } from "./sseFetch.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]));
      i += 1;
    },
  });
}

test("iterateSseFrames parses default event and named refresh", async () => {
  const body = streamFromChunks([
    'data: {"hello":1}\n\n',
    'event: refresh\ndata: {"type":"refresh"}\n\n',
  ]);
  const out: { event: string | null; data: string }[] = [];
  for await (const f of iterateSseFrames(body)) {
    out.push(f);
  }
  assert.equal(out.length, 2);
  assert.equal(out[0].event, null);
  assert.equal(out[0].data, '{"hello":1}');
  assert.equal(out[1].event, "refresh");
  assert.equal(out[1].data, '{"type":"refresh"}');
});

test("iterateSseFrames parses frames split across chunks and flushes final partial frame", async () => {
  const body = streamFromChunks([
    'data: {"hello":1}\n\n',
    'event: refresh\ndata: {"type":"refresh"}\n',
  ]);
  const out: { event: string | null; data: string }[] = [];
  for await (const f of iterateSseFrames(body)) {
    out.push(f);
  }
  assert.equal(out.length, 2);
  assert.equal(out[0].event, null);
  assert.equal(out[0].data, '{"hello":1}');
  assert.equal(out[1].event, "refresh");
  assert.equal(out[1].data, '{"type":"refresh"}');
});

test("iterateSseFrames ignores comments and parses empty data lines", async () => {
  const body = streamFromChunks([
    ": heartbeat\n",
    "data:\n",
    "\n",
  ]);
  const out: { event: string | null; data: string }[] = [];
  for await (const f of iterateSseFrames(body)) {
    out.push(f);
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].event, null);
  assert.equal(out[0].data, "");
});
