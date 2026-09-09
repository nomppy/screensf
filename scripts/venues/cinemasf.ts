import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.ts';
import { isTimeLike, parseLongDate, parseTime } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * The Balboa, Vogue and 4 Star (CinemaSF) share one Squarespace template.
 * Each film run is one Squarespace "event" whose body lists per-day headings
 * ("Monday, September 7") followed by Veezi   // own startDate; walking the body would attach later showtimes to this
  // page's URL and duplicate them across the run.
  if (start) {
 links whose text is the
 * showtime. Titles embed showtimes after a tilde ("Akira 4K ~ 1:30 PM ...")
 * which titles.ts strips later.
 *
 * Strategy A: Squarespace's `?format=json` on the collection, which returns
 * `upcoming[]` with `title`, `fullUrl`, `startDate` (epoch ms) and `body`
 * (HTML). Strategy B: the rendered HTML list, same body markup.
 */
interface SqsEvent {
  title: string;
  fullUrl: string;
  startDate: number;
  endDate?: number;
  body?: string;
  excerpt?: string;
  assetUrl?: string;
}

export async function scrapeCinemaSF(venue: Venue): Promise<RawScreening[]> {
  const calendarUrl = venue.calendarUrl ?? `${venue.url}/calendar-of-events`;
  const origin = new URL(calendarUrl).origin;

  let out: RawScreening[] = [];
  try {
    const text = await fetchText(`${calendarUrl}?format=json`, { headers: { accept: 'application/json' } });
    const data = JSON.parse(text) as { upcoming?: SqsEvent[]; items?: SqsEvent[] };
    const events = data.upcoming ?? data.items ?? [];
    for (const ev of events) {
      out.push(...fromEvent(venue, origin, decodeEntities(ev.title), ev.fullUrl, ev.startDate, ev.body ?? '', ev.assetUrl));
    }
    if (out.length) return out;
    console.warn(`  ${venue.id}: JSON endpoint returned no events, falling back to HTML`);
  } catch (err) {
    console.warn(`  ${venue.id}: JSON endpoint failed (${(err as Error).message}), falling back to HTML`);
  }

  const html = await fetchText(calendarUrl);
  const $ = cheerio.load(html);
  $('.eventlist-event, article[class*="eventlist"]').each((_, el) => {
    const $ev = $(el);
    const link = $ev.find('.eventlist-title a, .eventlist-title-link, h1 a, h2 a').first();
    const title = link.text().trim() || $ev.find('.eventlist-title').text().trim();
    const href = link.attr('href') ?? '';
    const dt = $ev.find('time.event-date').attr('datetime') ?? $ev.find('time[datetime]').first().attr('datetime');
    const startMs = dt ? Date.parse(dt) : NaN;
    const body = $ev.find('.eventlist-description, .eventlist-excerpt, .sqs-block-content').html() ?? '';
    if (title) out.push(...fromEvent(venue, origin, title, href, startMs, body));
  });
  return out;
}

function laParts(ms: number): { date: string; time: string; year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
    year: Number(get('year')),
    month: Number(get('month')),
  };
}

function fromEvent(
  venue: Venue,
  origin: string,
  title: string,
  href: string,
  startMs: number,
  bodyHtml: string,
  image?: string,
): RawScreening[] {
  const url = href.startsWith('http') ? href : `${origin}${href}`;
  const start = Number.isFinite(startMs) ? laParts(startMs) : null;
  const hint = start ? { year: start.year, month: start.month } : undefined;
  const $ = cheerio.load(bodyHtml);

  // First short bold line that is not the loyalty-card boilerplate.
  let note: string | undefined;
  $('strong, b, em').each((_, el) => {
    if (note) return;
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length >= 8 && t.length <= 110 && !/loyalty|annual|pass|can be used/i.test(t)) note = t;
  });
  if (!note && /subtitled/i.test(title)) note = 'Subtitled';

  // Squarespace gives one event per showtime, and each event body repeats the
  // whole remaining run (every day heading + ticket link). Trust the event's
  // own startDate; walking the body would attach later showtimes to this
  // page's URL and duplicate them across the run.
  if (start) {
    return [{ venueId: venue.id, rawTitle: title, date: start.date, time: start.time, url, note, image }];
  }

  const out: RawScreening[] = [];
  let date: string | null = null;
  $('h1, h2, h3, h4, h5, p, strong, a').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (tag === 'a') {
      const link = $el.attr('href') ?? '';
      if (!/veezi|ticket|purchase/i.test(link) || !isTimeLike(text) || !date) return;
      const time = parseTime(text);
      if (time) out.push({ venueId: venue.id, rawTitle: title, date, time, url: link, note, image });
      return;
    }
    // Day headings never contain a time and are short.
    if (text.length <= 40 && /day\b/i.test(text) && !/\d\s*[ap]m/i.test(text)) {
      const d = parseLongDate(text, hint);
      if (d) date = d;
    }
  });

    // Ticket links are per-showtime; the public listing is the event page.
  return out.map((s) => ({ ...s, url: s.url.includes('veezi') ? url : s.url }));
}

/** Squarespace JSON carries HTML entities in titles ("Ep. 1 &amp; 2"). */
function decodeEntities(s: string): string {
  return cheerio.load(`<i>${s}</i>`)('i').text().replace(/\s+/g, ' ').trim();
}
