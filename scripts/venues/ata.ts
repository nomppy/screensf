import * as cheerio from 'cheerio';
import { fetchJson, fetchText } from '../lib/http.ts';
import { horizonEndLA, todayLA } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * atasite.org is WordPress running The Events Calendar (tribe), whose REST
 * API is public: /wp-json/tribe/events/v1/events?start_date=YYYY-MM-DD&
 * end_date=YYYY-MM-DD&per_page=50&page=N returns {events: [...], total,
 * total_pages}. Each event has title, url, start_date ("2026-09-12 20:00:00",
 * America/Los_Angeles), description (HTML), image.url, categories
 * (Screening / Co-Present / Gallery) and organizer ("Other Cinema" for the
 * Saturday programme, otherwise ATA itself).
 *
 * We keep Screening events and film-ish Co-Present events, drop Gallery-only
 * items and open-submission/workshop nights (Open Screening, workshops, open
 * mics). Titles stay as printed ("Other Cinema: Psychedelic Cinema"). If the
 * REST API is unavailable, the /events/list/ page's JSON-LD Event array is
 * parsed instead (same fields, minus categories).
 */
export async function scrapeAta(venue: Venue): Promise<RawScreening[]> {
  const base = venue.url.replace(/\/$/, '');
  const today = todayLA();
  const horizon = horizonEndLA(5);

  let events: TribeEvent[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const url =
        `${base}/wp-json/tribe/events/v1/events?start_date=${today}&end_date=${horizon}` +
        `&per_page=50&page=${page}&status=publish`;
      const res = await fetchJson<{ events?: TribeEvent[]; total_pages?: number }>(url);
      events.push(...(res.events ?? []));
      if (page >= (res.total_pages ?? 1)) break;
    }
  } catch (err) {
    console.warn(`  ata: tribe REST failed: ${(err as Error).message}`);
  }
  if (!events.length) {
    try {
      events = await fromJsonLd(`${base}/events/list/`);
    } catch (err) {
      console.warn(`  ata: /events/list/ fallback failed: ${(err as Error).message}`);
    }
  }

  const out: RawScreening[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    try {
      const title = clean(ev.title ?? '');
      const m = (ev.start_date ?? '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
      if (!title || !m) continue;
      const date = m[1];
      if (date < today || date > horizon) continue;
      if (ev.all_day) continue;

      const cats = (ev.categories ?? []).map((c) => (c.slug ?? c.name ?? '').toLowerCase());
      const text = clean(ev.description ?? '');
      const FILMIC = /\b(film|films|video|screening|cinema|16mm|35mm|super ?8|shorts|documentary|projector|celluloid)\b/i;
      if (cats.length && !cats.includes('screening') && !(cats.includes('co-present') && FILMIC.test(`${title} ${text}`))) continue;
      if (!cats.length && !FILMIC.test(`${title} ${text}`)) continue;
      if (/\b(workshop|open mic|open screening|class|seminar|fundraiser only)\b/i.test(title)) continue;

      const url = ev.url || `${base}/events/`;
      const key = `${title}|${date}|${m[2]}:${m[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const fm = text.match(/\b(16\s?mm|35\s?mm|70\s?mm|super\s?8|8\s?mm)\b/i);
      out.push({
        venueId: venue.id,
        rawTitle: title,
        date,
        time: `${m[2]}:${m[3]}`,
        url,
        note: buildNote(ev, text),
        format: fm ? fm[1].replace(/\s+/g, '').replace(/^super8$/i, 'Super 8') : undefined,
        image: ev.image?.sizes?.large?.url || ev.image?.url || undefined,
      });
    } catch (err) {
      console.warn(`  ata: skipping "${ev?.title}": ${(err as Error).message}`);
    }
  }
  return out;
}

interface TribeEvent {
  title?: string;
  url?: string;
  start_date?: string;
  all_day?: boolean;
  description?: string;
  image?: { url?: string; sizes?: Record<string, { url?: string }> } | false;
  categories?: { name?: string; slug?: string }[];
  organizer?: { organizer?: string }[];
  cost?: string;
}

/** Organizer/series (Other Cinema), then one sentence about guests or curation. */
function buildNote(ev: TribeEvent, text: string): string | undefined {
  const parts: string[] = [];
  const org = clean(ev.organizer?.[0]?.organizer ?? '');
  const title = clean(ev.title ?? '');
  if (org && !/television access|^ata$/i.test(org) && !title.toLowerCase().startsWith(org.toLowerCase())) parts.push(org);
  const sentence = text
    .split(/(?<=[.!?])\s+/)
    .find((s) => /\b(in[- ]person|curated by|curator|Q\s?[+&]\s?A|live[- ]scored?|introduc|presented by|co-presented)/i.test(s));
  if (sentence) parts.push(sentence);
  const note = parts.join(' — ').trim();
  if (!note) return undefined;
  return note.length <= 160 ? note : `${note.slice(0, 157).replace(/\s+\S*$/, '')}…`;
}

/** tribe's list view embeds the visible events as a JSON-LD Event array. */
async function fromJsonLd(url: string): Promise<TribeEvent[]> {
  const $ = cheerio.load(await fetchText(url));
  const out: TribeEvent[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text()) as unknown;
      const list = (Array.isArray(data) ? data : [data]) as { '@type'?: string; name?: string; url?: string; startDate?: string; description?: string; image?: string }[];
      for (const d of list) {
        if (d['@type'] !== 'Event' || !d.startDate) continue;
        out.push({
          title: d.name,
          url: d.url,
          start_date: d.startDate.replace(/[+-]\d{2}:\d{2}$/, ''),
          description: d.description,
          image: d.image ? { url: d.image } : false,
        });
      }
    } catch {
      /* other ld+json blocks (WebSite, Organization) */
    }
  });
  return out;
}

function clean(s: string): string {
  return cheerio.load(`<x>${s.replace(/<[^>]+>/g, ' ')}</x>`)('x').text().replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}
