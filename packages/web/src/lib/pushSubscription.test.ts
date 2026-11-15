import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlToUint8Array,
  isValidVapidPublicKey,
  resolvePushSupportState,
  toPushSubscriptionPayload,
  uint8ArrayToBase64Url,
} from "./pushSubscription";

test("base64UrlToUint8Array decodes url-safe, unpadded input", () => {
  assert.deepEqual([...base64UrlToUint8Array("AQID")], [1, 2, 3]);
  // 0xfb 0xff -> "+/8=" in base64, "-_8" in base64url.
  assert.deepEqual([...base64UrlToUint8Array("-_8")], [0xfb, 0xff]);
  assert.deepEqual([...base64UrlToUint8Array("+/8=")], [0xfb, 0xff]);
  assert.deepEqual([...base64UrlToUint8Array("  AQ  ")], [1]);
  assert.equal(base64UrlToUint8Array("").length, 0);
});

test("base64url round-trips arbitrary bytes", () => {
  const bytes = Uint8Array.from({ length: 65 }, (_, index) => (index * 37 + 4) % 256);
  const encoded = uint8ArrayToBase64Url(bytes);
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.deepEqual([...base64UrlToUint8Array(encoded)], [...bytes]);
});

test("isValidVapidPublicKey requires a 65-byte uncompressed P-256 point", () => {
  const key = new Uint8Array(65);
  key[0] = 4;
  assert.equal(isValidVapidPublicKey(uint8ArrayToBase64Url(key)), true);
  key[0] = 3;
  assert.equal(isValidVapidPublicKey(uint8ArrayToBase64Url(key)), false);
  assert.equal(isValidVapidPublicKey(uint8ArrayToBase64Url(new Uint8Array(32))), false);
  assert.equal(isValidVapidPublicKey(""), false);
  assert.equal(isValidVapidPublicKey("not base64 !!"), false);
});

test("toPushSubscriptionPayload keeps only complete subscriptions", () => {
  assert.deepEqual(
    toPushSubscriptionPayload({
      endpoint: " https://push.example/abc ",
      keys: { p256dh: "p", auth: "a", extra: "x" },
    }),
    { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } },
  );
  assert.equal(toPushSubscriptionPayload({ endpoint: "https://push.example/abc", keys: { p256dh: "p" } }), null);
  assert.equal(toPushSubscriptionPayload({ keys: { p256dh: "p", auth: "a" } }), null);
  assert.equal(toPushSubscriptionPayload(null), null);
});

test("resolvePushSupportState maps capabilities and permission", () => {
  const supported = { hasServiceWorker: true, hasPushManager: true, hasNotification: true };
  assert.equal(resolvePushSupportState({ ...supported, permission: "granted" }), "granted");
  assert.equal(resolvePushSupportState({ ...supported, permission: "denied" }), "denied");
  assert.equal(resolvePushSupportState({ ...supported, permission: "default" }), "default");
  assert.equal(resolvePushSupportState({ ...supported, hasPushManager: false, permission: "granted" }), "unsupported");
  assert.equal(resolvePushSupportState({ ...supported, hasServiceWorker: false, permission: null }), "unsupported");
});
