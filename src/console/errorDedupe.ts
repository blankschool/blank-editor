// Evita spam do mesmo erro repetido (ex: um efeito que re-lança em loop de render).
const DEDUPE_TTL_MS = 30_000;
const seenErrors = new Map<string, number>();

export function shouldLogError(key: string, now: number = Date.now()): boolean {
  for (const [k, ts] of seenErrors) {
    if (now - ts > DEDUPE_TTL_MS) seenErrors.delete(k);
  }
  const last = seenErrors.get(key);
  seenErrors.set(key, now);
  return last === undefined || now - last > DEDUPE_TTL_MS;
}
