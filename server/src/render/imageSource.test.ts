import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, isPrivateAddress } from "./imageSource.ts";

test("accepts public IPv4 addresses", () => {
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("rejects loopback, private and link-local IPv4 ranges", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.0.0.5"), true);
  assert.equal(isPrivateAddress("172.16.0.1"), true);
  assert.equal(isPrivateAddress("172.31.255.255"), true);
  assert.equal(isPrivateAddress("192.168.1.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true); // cloud metadata endpoint
  assert.equal(isPrivateAddress("0.0.0.0"), true);
});

test("does not treat 172.32.x as private (just outside the 172.16/12 block)", () => {
  assert.equal(isPrivateAddress("172.32.0.1"), false);
});

test("rejects IPv6 loopback and unique-local ranges", () => {
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("fc00::1"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
});

test("assertPublicHttpUrl rejects non-http(s) protocols", () => {
  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"));
  assert.throws(() => assertPublicHttpUrl("ftp://example.com/x.png"));
});

test("assertPublicHttpUrl rejects URLs with a literal private host", () => {
  assert.throws(() => assertPublicHttpUrl("http://127.0.0.1/x.png"));
  assert.throws(() => assertPublicHttpUrl("http://localhost/x.png"));
  assert.throws(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data"));
});

test("assertPublicHttpUrl accepts a well-formed public https URL", () => {
  assert.doesNotThrow(() => assertPublicHttpUrl("https://pbs.twimg.com/media/x.jpg"));
});
