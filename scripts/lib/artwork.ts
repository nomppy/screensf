import * as cheerio from 'cheerio';
import { fetchTextCached } from './http.ts';
import type { RawScreening } from './types.ts';

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** og:image / twitter:image from an HTML page, absolute URL or undefined. */
export function ogImage(html: string, pageUrl: string): string | undefined {
  const $ = cheerio.load(html);
  const raw =
    $('meta[property="og:image"]').attr('content') ??
    $('meta[property="og:image:url"]').attr('content') ??
    $('meta[name="twitter:image"]').attr('content') ??
    $('link[rel="image_src"]').attr('href');
  if (!raw) return undefined;
  try {
    return new URL(raw.trim(), pageUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Artwork the venue itself published for a title. Uses whatever a scraper
 * already attached; otherwise fetches the listing page once (cached a week)
 * and reads its og:image. Never throws.
 */
export async function venueImageFor(raws: RawScreening[]): Promise<string | undefined> {
  const attached = raws.find((r) => r.image)?.image;
  if (attached) return attached;
  const page = raws.map((r) => r.url).find((u) => /^https?:/.test(u) && !/veezi|ticket/i.test(u));
  if (!page) return undefined;
  try {
    return ogImage(await fetchTextCached(page, WEEK), page);
  } catch {
    return undefined;
  }
}
