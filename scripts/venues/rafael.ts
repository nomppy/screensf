import * as cheerio from 'cheerio';
import { fetchText, fetchTextCached } from '../lib/http.ts';
import { ogImage } from '../lib/artwork.ts';
import { horizonEndLA, isTimeLike, parseLongDate, parseTime, todayLA } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * The Smith Rafael Film Center shares California Film Institute's custom
 * (Tailwind, server-rendered) cinema app at cinema.cafilm.org with the
 * Sequoia. rafaelfilm.cafilm.org itself is just a WordPress shell whose front
 * page embeds the same film grid. There is no JSON, ICS or REST feed; the
 * Agile Ticketing backend (tix.cafilm.org) sits behind Incapsula.
 *
 * Two pages matter:
 *
 *  - cinema.cafilm.org/schedule?cinema=SMITH+RAFAEL+FILM+CENTER lists every
 *    published showtime for the Rafael under <h4 data-date="YYYY-MM-DD">
 *    headings. It is only used to collect film URLs (/film/<slug>), because
 *    its times have no AM/PM ("4:15").
 *  - Each film page has a #tickets-section with one block per day: a heading
 *    div ("Wednesday, September 9", no year) followed by one column per
 *    showtime holding a <button> whose text is the time ("4:30 PM") and a
 *    <button class="venue-link" data-venue="RAF1|RAF2|RAF3|Sequoia1|..."> that
 *    names the screen. Only RAF* screens are kept. The header also carries an
 *    event-type line ("SCREENING AND CONVERSATION") and a synopsis whose Q&A /
 *    "will attend" sentence goes into `note`. Posters are /drive_serve/<slug>/
 *    images; the pages have no og:image.
 */
const SCHEDULE_URL = 'https://cinema.cafilm.org/schedule?cinema=SMITH+RAFAEL+FILM+CENTER';
const FILM_HOST = 'https://cinema.cafilm.org';
const WEEKS_AHEAD = 5;

export async function scrapeRafael(venue: Venue): Promise<RawScreening[]> {
  const filmUrls = new Set<string>();
  for (const page of [SCHEDULE_URL, `${venue.url.replace(/\/$/, '')}/`]) {
    try {
      for (const u of collectFilmLinks(await fetchText(page))) filmUrls.add(u);
    } catch (err) {
      console.warn(`  rafael: ${page} failed: ${(err as Error).message}`);
    }
    // The schedule page is authoritative; the venue front page is a fallback.
    if (filmUrls.size) break;
  }

  const today = todayLA();
  const horizon = horizonEndLA(WEEKS_AHEAD);
  const [y, m] = today.split('-').map(Number);
  const hint = { year: y, month: m };

  const out: RawScreening[] = [];
  for (const url of filmUrls) {
    try {
      const html = await fetchTextCached(url, 12 * 60 * 60 * 1000);
      out.push(...parseFilm(html, url, venue, hint).filter((s) => s.date >= today && s.date <= horizon));
    } catch (err) {
      console.warn(`  rafael: ${url} failed: ${(err as Error).message}`);
    }
  }
  return dedupe(out);
}

function collectFilmLinks(html: string): string[] {
  const $ = cheerio.load(html);
  const found = new Set<string>();
  $('a[href*="/film/"]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const abs = href.startsWith('http') ? href : `${FILM_HOST}${href}`;
    const clean = abs.split(/[?#]/)[0].replace(/\/$/, '');
    if (/^https:\/\/cinema\.cafilm\.org\/film\/[a-z0-9_-]+$/i.test(clean)) found.add(clean);
  });
  return [...found];
}

function parseFilm(html: string, url: string, venue: Venue, hint: { year: number; month: number }): RawScreening[] {
  const $ = cheerio.load(html);
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

  const title =
    clean($('div.text-2xl.font-light.uppercase').first().text()) ||
    clean(($('title').text().split('—').pop() ?? '')) ||
    clean($('h1').first().text());
  if (!title) {
    console.warn(`  rafael: no title on ${url}`);
    return [];
  }

  // Header lines under the title: a one-line blurb (may be empty) and the
  // event type ("SCREENING AND CONVERSATION"). Uppercase in the source.
  const blurb = clean($('div.text-base.font-light.uppercase').first().text());
  const kind = clean($('div.text-lg.uppercase').first().text());
  // Synopsis lines are separated by <br>, which .text() would run together.
  const bodyHtml = $('#tickets-section').prevAll('section').html() ?? $('section p').first().html() ?? '';
  const body = clean(cheerio.load(bodyHtml.replace(/<br\s*\/?>/gi, '. '))('body').text());
  const note = buildNote(kind, blurb, body);
  const format = detectFormat(`${title} ${blurb} ${body}`);

  const poster = $('img[src*="/drive_serve/"]').first().attr('src');
  const image = ogImage(html, url) ?? (poster ? new URL(poster, url).toString() : undefined);

  const out: RawScreening[] = [];
  $('#tickets-section button.venue-link[data-venue]').each((_, el) => {
    try {
      const screen = $(el).attr('data-venue') ?? '';
      if (!/^RAF/i.test(screen)) return;

      // venue-link sits in a small caption div inside the showtime column,
      // whose first button is the time; the column's parent is the day block.
      const col = $(el).parent().parent();
      const timeText = clean(col.children('button').first().text());
      if (!isTimeLike(timeText)) return;
      const time = parseTime(timeText);

      let date: string | null = null;
      col
        .parent()
        .children()
        .each((_, d) => {
          const t = clean($(d).text());
          if (!date && t.length <= 40 && /day,/i.test(t)) date = parseLongDate(t, hint);
        });
      if (!date || !time) return;

      out.push({ venueId: venue.id, rawTitle: title, date, time, url, note, format, image });
    } catch (err) {
      console.warn(`  rafael: bad showtime on ${url}: ${(err as Error).message}`);
    }
  });
  return out;
}

function buildNote(kind: string, blurb: string, body: string): string | undefined {
  const parts: string[] = [];
  if (kind && !/^(now screening|coming soon)$/i.test(kind)) parts.push(titleCase(kind));
  // Sentence that says who is in the room; prefer an explicit Q&A / in person
  // line, then the shortest, so a long marketing blurb does not win.
  const PEOPLE = /\b(Q&A|in person|in-person|will attend|in attendance|introduc\w*|conversation with|discussion with|moderated by|hosted by|presented by|live score|with filmmaker|with director)\b/i;
  const STRONG = /\b(Q&A|in person|in-person|with filmmaker|with director)\b/i;
  const sentence = `${blurb}. ${body}`
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().replace(/[.\s]+$/, ''))
    .filter((s) => s.length >= 8 && PEOPLE.test(s))
    .sort((a, b) => Number(STRONG.test(b)) - Number(STRONG.test(a)) || a.length - b.length)[0];
  if (sentence) parts.push(titleCaseIfShouting(sentence));
  if (!parts.length) return undefined;
  const note = parts.join(' — ');
  return note.length <= 160 ? note : `${note.slice(0, 157).replace(/\s+\S*$/, '')}...`;
}

function detectFormat(text: string): string | undefined {
  const m = text.match(/\b(70\s?mm|35\s?mm|16\s?mm|4K(?:\s+restoration)?|DCP)\b/i);
  if (!m) return undefined;
  const f = m[1].replace(/\s+/g, '').toUpperCase();
  return f.startsWith('4K') ? '4K' : f === 'DCP' ? 'DCP' : f.toLowerCase();
}

/** "WITH FILMMAKER RUSTIN THOMPSON" -> "With Filmmaker Rustin Thompson"; mixed case is left alone. */
function titleCaseIfShouting(s: string): string {
  return s === s.toUpperCase() && /[A-Z]/.test(s) ? titleCase(s) : s;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/(?<=\S )(And|Of|The|With|A|In)\b/g, (w) => w.toLowerCase());
}

function dedupe(list: RawScreening[]): RawScreening[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.rawTitle}|${s.date}|${s.time}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
