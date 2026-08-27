import { isIPv4, isIPv6 } from "node:net";
import dns from "node:dns/promises";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;

/** True if `address` (a literal IPv4 or IPv6) is loopback, private, link-local, or otherwise non-routable. */
export function isPrivateAddress(address: string): boolean {
  if (isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 0) return true; // "this network"
    return false;
  }
  if (isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized === "::1") return true; // loopback
    if (normalized.startsWith("fe80:")) return true; // link-local
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local
    return false;
  }
  // Not a literal IP — caller should have resolved it first. Fail closed.
  return true;
}

/** Throws if `url` is not a well-formed, non-empty http(s) URL pointing at a literal private/loopback host. */
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
  const host = parsed.hostname;
  if (host === "localhost" || (isIPv4(host) || isIPv6(host) ? isPrivateAddress(host) : false)) {
    throw new Error(`image URL points at a private host: ${url}`);
  }
  return parsed;
}

async function resolveAndCheck(hostname: string): Promise<void> {
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(`image host resolves to a private address: ${hostname}`);
    return;
  }
  const records = await dns.lookup(hostname, { all: true });
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new Error(`image host resolves to a private address: ${hostname} -> ${address}`);
    }
  }
}

/**
 * Fetches an image over HTTP(S), rejecting requests that resolve to private/loopback
 * addresses (SSRF guard) at every hop of a redirect chain, and capping response size.
 */
export async function fetchImage(url: string): Promise<Buffer> {
  let current = assertPublicHttpUrl(url);

  for (let hop = 0; ; hop++) {
    await resolveAndCheck(current.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal: controller.signal });
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
