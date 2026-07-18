import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeTtydHandshakeFrame,
  encodeTtydInputFrame,
  encodeTtydResizeFrame,
  TTYD_CLIENT_COMMAND,
  TTYD_SERVER_COMMAND,
} from "./ttydProtocol";

test("ttyd command directions preserve the shared byte contract", () => {
  assert.deepEqual(TTYD_SERVER_COMMAND, {
    output: 0x30,
    setWindowTitle: 0x31,
    setPreferences: 0x32,
  });
  assert.deepEqual(TTYD_CLIENT_COMMAND, {
    input: 0x30,
    resize: 0x31,
    pause: 0x32,
    resume: 0x33,
  });
});

test("ttyd handshake is an unprefixed JSON frame", () => {
  const handshake = encodeTtydHandshakeFrame(120, 40);
  assert.equal(handshake[0], "{".charCodeAt(0));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(handshake)), {
    columns: 120,
    rows: 40,
  });
});

test("ttyd client encoders prefix input and resize payloads", () => {
  const input = encodeTtydInputFrame("hello");
  assert.equal(input[0], TTYD_CLIENT_COMMAND.input);
  assert.equal(new TextDecoder().decode(input.slice(1)), "hello");

  const resize = encodeTtydResizeFrame(120, 40);
  assert.equal(resize[0], TTYD_CLIENT_COMMAND.resize);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(resize.slice(1))), {
    columns: 120,
    rows: 40,
  });
});
