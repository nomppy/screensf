import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const CACHE_DIR = '.cache';
const RAW_DIR = join(CACHE_DIR, 'raw');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const lastRequestAt = new Map<string, number>();
const DEFAULT_GAP_MS = 700;
/** Hosts that rate-limit aggressively get a longer gap between requests. */
const HOST_GAP_MS: Record<string, number> = {
  'thecastro.com': 2500,
  'letterboxd.com': 1500,
  // robots.txt asks for Crawl-delay: 10. Pages are cached a week, so this
  // only bites on a cold cache.
  'bampfa.org': 10_000,
};

async function politeDelay(url: string) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const gap = HOST_GAP_MS[host] ?? DEFAULT_GAP_MS;
  const wait = (lastRequestAt.get(host) ?? 0) + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(host, Date.now());
}

/**
 * Fetch text with a browser UA, a small delay between requests, one retry,
 * and a copy of the raw response saved under .cache/raw/ so a broken scraper
 * can be debugged against exactly what the site returned.
 */
export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  await politeDelay(url);
  let lastErr: unknown;
  // 429 (rate limited): honour Retry-After if present, else back off 5s, 15s, 40s.
  const backoff = [5_000, 15_000, 40_000];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...(init?.headers ?? {}) },
        redirect: 'follow',
      });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff[Math.min(attempt, backoff.length - 1)];
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        if (attempt < 3) {
          process.stdout.write(`\n  rate limited by ${new URL(url).hostname}, waiting ${Math.round(wait / 1000)}s... `);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      saveRaw(url, text);
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt >= 1) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

const pageCache = new Map<string, { at: number; body: string }>();
let pageCacheStore: JsonCache<{ at: number; body: string }> | null = null;

/** fetchText with an on-disk TTL cache, for pages that rarely change (event detail pages). */
export async function fetchTextCached(url: string, ttlMs = 12 * 60 * 60 * 1000): Promise<string> {
  pageCacheStore ??= new JsonCache<{ at: number; body: string }>(join(CACHE_DIR, 'pages.json'));
  const hit = pageCache.get(url) ?? pageCacheStore.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body;
  const body = await fetchText(url);
  const entry = { at: Date.now(), body };
  pageCache.set(url, entry);
  pageCacheStore.set(url, entry);
  return body;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const text = await fetchText(url, init);
  return JSON.parse(text) as T;
}

function saveRaw(url: string, body: string) {
  try {
    mkdirSync(RAW_DIR, { recursive: true });
    const name = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const host = new URL(url).hostname.replace(/^www\./, '');
    writeFileSync(join(RAW_DIR, `${host}-${name}.txt`), `${url}\n\n${body}`);
  } catch {
    /* caching is best-effort */
  }
}

/** Tiny JSON file cache used for TMDB lookups and Letterboxd film pages. */
export class JsonCache<T> {
  private data: Record<string, T>;
  private file: string;
  constructor(file: string) {
    this.file = file;
    mkdirSync(CACHE_DIR, { recursive: true });
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, T>) : {};
  }
  get(key: string): T | undefined {
    return this.data[key];
  }
  set(key: string, value: T) {
    this.data[key] = value;
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  has(key: string) {
    return key in this.data;
  }
}
