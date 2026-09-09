import * as cheerio from 'cheerio';
import { fetchText, fetchTextCached } from '../lib/http.ts';
import { ogImage } from '../lib/artwork.ts';
import { horizonEndLA, parseLongDate, parseTime, todayLA } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * thecastro.com (Another Planet Entertainment, WordPress) mixes concerts,
 * comedy and film. Event URLs look like /events/<slug>-YYMMDD. The listing
 * pages give us URLs; each event page gives a clean <title>, a date line
 * ("Wednesday, September 09, 2026"), "Doors: 6:30 pm | Show: 7:30 pm", and a
 * film rating line ("This film is rated PG") that we use, along with the
 * /event_category/film taxonomy, to keep only screenings.
 */
export async function scrapeCastro(venue: Venue): Promise<RawScreening[]> {
  const base = venue.url.replace(/\/$/, '');
  const listingPages = [`${base}/`, `${base}/listing/`, `${base}/calendar/`];
  const filmCategory = `${base}/event_category/film`;

  // url -> text of the listing card around the link (headline, kicker, date)
  const cards = new Map<string, string>();
  const filmUrls = new Set<string>();

  for (const page of listingPages) {
    try {
      for (const [u, text] of collectEventLinks(await fetchText(page), base)) {
        cards.set(u, `${cards.get(u) ?? ''} ${text}`);
      }
    } catch (err) {
      console.warn(`  castro: ${page} failed: ${(err as Error).message}`);
    }
  }
  try {
    for (const [u, text] of collectEventLinks(await fetchText(filmCategory), base)) {
      filmUrls.add(u);
      cards.set(u, `${cards.get(u) ?? ''} ${text}`);
    }
  } catch {
    /* category page may be JS-rendered; heuristics below still work */
  }

  // Every event page has to be opened once to know whether it is a film
  // (the site mixes concerts and comedy in). Pages are cached for a week, so
  // only new events cost a request, and http.ts spaces requests to this host
  // out and backs off on HTTP 429. Likely films go first so a cut-short run
  // still gets the useful ones.
  const FILMIC = /\b(film|films|screening|movie|cinema|35mm|70mm|sing-?along|double feature|shorts|documentary|matinee|restoration)\b/i;
  const candidates = [...cards.keys()].sort((x, y) => score(y) - score(x));
  function score(u: string) {
    return (filmUrls.has(u) ? 2 : 0) + (FILMIC.test(cards.get(u) ?? '') ? 1 : 0);
  }

  // Skip event pages whose listing card already shows a date outside the sync
  // horizon, so the slow one-page-per-event fetch only covers the weeks we show.
  const today = todayLA();
  const horizon = horizonEndLA();
  const inRange = (u: string) => {
    const m = (cards.get(u) ?? '').match(/\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}/);
    const d = m ? parseLongDate(m[0]) : null;
    return !d || (d >= today && d <= horizon);
  };

  const out: RawScreening[] = [];
  for (const url of candidates) {
    if (!inRange(url)) continue;
    try {
      const html = await fetchTextCached(url, 7 * 24 * 60 * 60 * 1000);
      const s = parseEvent(html, url, venue, filmUrls.has(url));
      if (s) out.push(...s);
    } catch (err) {
      console.warn(`  castro: ${url} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

function collectEventLinks(html: string, base: string): [string, string][] {
  const $ = cheerio.load(html);
  const found = new Map<string, string>();
  $('a[href*="/events/"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') ?? '';
    const abs = href.startsWith('http') ? href : `${base}${href}`;
    if (!abs.startsWith(base)) return;
    const clean = abs.split(/[?#]/)[0].replace(/\/$/, '');
    if (!/\/events\/[a-z0-9-]+$/i.test(clean)) return;
    // Walk up to the card container: the nearest ancestor that holds a date.
    let node = $a.parent();
    for (let i = 0; i < 5 && node.length && !/\b\d{4}\b|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(node.text()); i++) node = node.parent();
    const text = [node.text(), $a.attr('title'), $a.find('img').attr('alt')].join(' ').replace(/\s+/g, ' ').trim();
    found.set(clean, `${found.get(clean) ?? ''} ${text}`.slice(0, 2000));
  });
  return [...found.entries()];
}

function parseEvent(html: string, url: string, venue: Venue, knownFilm: boolean): RawScreening[] | null {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');

  const isFilm =
    knownFilm ||
    /this film is rated/i.test(text) ||
    $('a[href*="event_category/film"]').length > 0 ||
    /\b(screening|35mm|70mm|sing-along|double feature)\b/i.test(text.slice(0, 4000));
  if (!isFilm) return null;

  let title = ($('title').text().split('|')[0] ?? '').trim();
  if (!title) title = $('h2').first().text().trim();
  // Kicker and headline sometimes run together: "…Frameline presentA tribute…"
  title = title.replace(/\b(presents?)([A-Z])/g, '$1 $2');
  if (!title) return null;

  const dateLine = text.match(/\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}/);
  const date = dateLine ? parseLongDate(dateLine[0]) : null;
  if (!date) return null;

  const show = text.match(/Show:\s*(\d{1,2}(?::\d{2})?\s*[ap]m)/i);
  const doors = text.match(/Doors:\s*(\d{1,2}(?::\d{2})?\s*[ap]m)/i);
  const time = parseTime(show?.[1] ?? doors?.[1] ?? '');
  if (!time) return null;

  // Sub-headline above the title carries the event framing.
  // Siblings are joined with spaces; .text() alone would run them together
  // ("…Frameline present" + "A tribute…" -> "presentA tribute").
  const kicker = $('h2')
    .first()
    .prevAll()
    .map((_, el) => $(el).text())
    .get()
    .reverse()
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(presents?)([A-Z])/g, '$1 $2')
    .trim();
  const note = kicker && kicker.length <= 160 ? kicker : undefined;

  return [{ venueId: venue.id, rawTitle: title, date, time, url, note, image: ogImage(html, url) }];
}
