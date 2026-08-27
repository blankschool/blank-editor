import { type LookupFunction } from "node:net";
import dns from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;

/** True if `address` (a literal IPv4 or IPv6) is loopback, private, link-local, or otherwise non-routable. */
export function isPrivateAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  // process() normalizes IPv4-mapped IPv6 addresses before classification, so
  // forms such as ::ffff:127.0.0.1 cannot bypass the IPv4 loopback rules.
  return ipaddr.process(address).range() !== "unicast";
}

/**
 * Throws if `url` is not a well-formed http(s) URL, or names a private host as a literal
 * (an IP in the URL itself, or "localhost"). This is a fast, synchronous pre-check for the
 * common case — it cannot see through DNS, so it is NOT the SSRF guard by itself. The
 * authoritative check is `pickPublicAddress`, applied to the address actually used to
 * connect (see `guardedDispatcher` below), which is what closes the DNS-rebinding gap a
 * "resolve once, fetch separately" check would leave open.
 */
export function assertPublicHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid image URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`image URL must be http(s): ${url}`);
  }
  // Node's URL.hostname retains square brackets around IPv6 literals; address
  // parsers (and the socket) use the unbracketed value.
  const host = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  if (host === "localhost" || (ipaddr.isValid(host) && isPrivateAddress(host))) {
    throw new Error(`image URL points at a private host: ${url}`);
  }
  return parsed;
}

/** Picks the address a guarded lookup should hand back to the socket, refusing the whole answer if any resolved address is private. */
export function pickPublicAddress(
  hostname: string,
  addresses: Array<{ address: string; family: number }>,
): { address: string; family: number } {
  if (addresses.length === 0) throw new Error(`image host did not resolve to any address: ${hostname}`);
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error(`image host resolves to a private address: ${hostname} -> ${bad.address}`);
  return addresses[0];
}

/**
 * A dns.lookup-compatible function that validates every address before handing it to the
 * socket that will actually connect — the DNS answer used for validation is the same one
 * used for the connection, so a hostname can't answer differently between check and connect.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, options.all ? [] : "");
    try {
      const picked = pickPublicAddress(hostname, addresses);
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, picked.address, picked.family);
      }
    } catch (guardErr) {
      callback(guardErr as NodeJS.ErrnoException, options.all ? [] : "");
    }
  });
};

const guardedDispatcher = new Agent({ connect: { lookup: guardedLookup } });

/**
 * Fetches an image over HTTP(S), rejecting requests that resolve to private/loopback/
 * metadata addresses (SSRF guard) at every hop of a redirect chain — including at the
 * moment of the actual TCP connect, not just an earlier DNS check — and caps response size.
 */
export async function fetchImage(url: string): Promise<Buffer> {
  let current = assertPublicHttpUrl(url);

  for (let hop = 0; ; hop++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(current, {
        dispatcher: guardedDispatcher,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`redirect from ${current} had no Location header`);
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects fetching ${url}`);
      current = assertPublicHttpUrl(new URL(location, current).toString());
      continue;
    }

    if (!res.ok) throw new Error(`image fetch failed: ${res.status} ${current}`);

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
      throw new Error(`image too large: ${contentLength} bytes`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large: ${buf.byteLength} bytes`);
    return buf;
  }
}
