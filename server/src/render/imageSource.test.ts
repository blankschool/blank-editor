import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, isPrivateAddress, pickPublicAddress } from "./imageSource.ts";

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
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("rejects mapped, unspecified and reserved IPv6 addresses", () => {
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("::"), true);
  assert.equal(isPrivateAddress("2001:db8::1"), true);
});

test("assertPublicHttpUrl rejects non-http(s) protocols", () => {
  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"));
  assert.throws(() => assertPublicHttpUrl("ftp://example.com/x.png"));
});

test("assertPublicHttpUrl rejects URLs with a literal private host", () => {
  assert.throws(() => assertPublicHttpUrl("http://127.0.0.1/x.png"));
  assert.throws(() => assertPublicHttpUrl("http://localhost/x.png"));
  assert.throws(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data"));
  assert.throws(() => assertPublicHttpUrl("http://[::1]/x.png"));
  assert.throws(() => assertPublicHttpUrl("http://[::ffff:127.0.0.1]/x.png"));
});

test("assertPublicHttpUrl accepts a well-formed public https URL", () => {
  assert.doesNotThrow(() => assertPublicHttpUrl("https://pbs.twimg.com/media/x.jpg"));
});

test("pickPublicAddress rejects the whole DNS answer if ANY resolved address is private", () => {
  // This is the case a naive "lookup once, fetch separately" check misses: a hostname
  // that resolves to a mix of a public and a private address (attacker picks which one
  // answers the actual TCP connect). Refusing to pick at all is the safe behaviour.
  assert.throws(
    () =>
      pickPublicAddress("evil.example.com", [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    /evil\.example\.com/,
  );
});

test("pickPublicAddress returns the first address when all resolved addresses are public", () => {
  const picked = pickPublicAddress("example.com", [
    { address: "93.184.216.34", family: 4 },
    { address: "93.184.216.35", family: 4 },
  ]);
  assert.deepEqual(picked, { address: "93.184.216.34", family: 4 });
});

test("pickPublicAddress rejects an empty DNS answer", () => {
  assert.throws(() => pickPublicAddress("example.com", []));
});
