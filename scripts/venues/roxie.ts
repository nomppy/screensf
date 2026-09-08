import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.ts';
import { isTimeLike, parseLongDate, parseTime } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * roxie.com runs WordPress with the "Theater for WordPress" plugin. The
 * /calendar/ page renders a list view where each day is a heading
 * ("Monday, September 7, 2026"), followed by one block per film: an h4 title
 * linking to /film/<slug>/ and one anchor per showtime linking to
 * /film/<slug>/#showtimes. Month grids at the top repeat the same links inside
 * <table>, which we skip so the wrong date is never attached.
 *
 * Strategy A walks headings and anchors in document order. Strategy B uses
 * the plugin's own class names in case the theme changes the heading levels.
 */
export async function scrapeRoxie(venue: Venue): Promise<RawScreening[]> {
  const html = await fetchText(`${venue.url}/calendar/`);
  const $ = cheerio.load(html);

  let out = walkHeadings($, venue);
  if (!out.length) out = pluginClasses($, venue);
  return dedupe(out);
}

function walkHeadings($: cheerio.CheerioAPI, venue: Venue): RawScreening[] {
  const out: RawScreening[] = [];
  let date: string | null = null;
  let film: { title: string; url: string } | null = null;

  $('h2, h3, h4, a').each((_, el) => {
    const $el = $(el);
    if ($el.closest('table').length) return;
    const tag = el.tagName.toLowerCase();
    const text = $el.text().replace(/\s+/g, ' ').trim();

    if (tag !== 'a') {
      // Only full dates with a year reset the current day; "September 2026"
      // month headings and film titles do not.
      if (/\b(19|20)\d{2}\b/.test(text) && /\b\d{1,2}\b/.test(text)) {
        const d = parseLongDate(text);
        if (d && /day,/i.test(text)) {
          date = d;
          film = null;
        }
      }
      return;
    }

    const href = $el.attr('href') ?? '';
    if (!href.includes('/film/')) return;

    if (href.includes('#showtimes')) {
      if (!date || !film || !isTimeLike(text)) return;
      const time = parseTime(text.replace(/[*†‡]/g, '').trim());
      if (!time) return;
      out.push({
        venueId: venue.id,
        rawTitle: film.title,
        date,
        time,
        url: film.url,
        note: /\*/.test(text) ? 'See venue listing for details' : undefined,
      });
      return;
    }

    // Title anchor: has text, is not an image-only link.
    if (text && !$el.find('img').length && date) {
      film = { title: text, url: href.replace(/\/+$/, '/') };
    }
  });
  return out;
}

function pluginClasses($: cheerio.CheerioAPI, venue: Venue): RawScreening[] {
  const out: RawScreening[] = [];
  $('.wp_theatre_event').each((_, el) => {
    const $ev = $(el);
    const title = $ev.find('.wp_theatre_event_title').text().trim();
    const url = $ev.find('.wp_theatre_event_title a').attr('href') ?? `${venue.url}/calendar/`;
    const dateText = $ev.find('.wp_theatre_event_startdate').text().trim();
    const timeText = $ev.find('.wp_theatre_event_starttime').text().trim();
    const date = parseLongDate(dateText);
    const time = parseTime(timeText);
    if (title && date && time) out.push({ venueId: venue.id, rawTitle: title, date, time, url });
  });
  return out;
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
