import * as cheerio from 'cheerio';
import { fetchText, fetchTextCached } from '../lib/http.ts';
import { ogImage } from '../lib/artwork.ts';
import { horizonEndLA, parseTime, todayLA } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';
import { paragraphs } from './roxie.ts';

/**
 * bampfa.org is Drupal 7. /visit/calendar/YYYY-MM renders one month as a
 * <table> whose cells are <td class="single-day" data-date="YYYY-MM-DD">. Each
 * event in a cell is a .views-row holding a compact card (div.time "7 PM",
 * div.title.month-title[data-id] > a[href="/event/<slug>"], and
 * ul.calendar_filter with type tags such as "Film", "Art", "Tours") plus a
 * hidden popup (div.popupboxthing[data-popup=<data-id>]) with the series link
 * (.parent-series a), an intro line (.event-information: "New 35mm Print",
 * "4K Digital Restoration"), in-person guests (h5 "In Conversation" +
 * .inperson-txt h5) and a 170x150 thumbnail. The museum shares the calendar
 * with exhibitions, tours and talks, so only rows tagged "Film" are kept.
 *
 * Projection format lives only on the event page, under the "FILM DETAILS"
 * accordion as an h4 "Print Info" followed by <ul><li>35mm</li>…; pages are
 * cached for a week so re-runs only hit new titles. og:image there is the
 * full-size still. Talks occasionally carry the "Film" tag too (a series
 * symposium); those have neither the popup's director/year block
 * (.cb_details) nor a Print Info list, and are dropped. There is also
 * /events/upcoming.ics, but it carries no type field, so it cannot separate
 * films from gallery events.
 */
export async function scrapeBampfa(venue: Venue): Promise<RawScreening[]> {
  const base = venue.url.replace(/\/$/, '');
  const today = todayLA();
  const horizon = horizonEndLA(5);

  // url -> the showtimes that share an event page; format/image are per page.
  const byUrl = new Map<string, RawScreening[]>();
  // urls whose calendar popup showed director/country/year, i.e. a film.
  const filmLike = new Set<string>();
  for (const month of monthsBetween(today, horizon)) {
    const page = `${base}/visit/calendar/${month}`;
    try {
      for (const { screening: s, hasCredits } of parseMonth(await fetchText(page), venue, base, today, horizon)) {
        const list = byUrl.get(s.url) ?? [];
        list.push(s);
        byUrl.set(s.url, list);
        if (hasCredits) filmLike.add(s.url);
      }
    } catch (err) {
      console.warn(`  bampfa: ${page} failed: ${(err as Error).message}`);
    }
  }

  for (const [url, list] of byUrl) {
    try {
      const html = await fetchTextCached(url, 7 * 24 * 60 * 60 * 1000);
      const print = printInfo(html);
      if (!print.present && !filmLike.has(url)) {
        console.warn(`  bampfa: skipping "${list[0].rawTitle}" (tagged Film, but no film credits or print info)`);
        byUrl.delete(url);
        continue;
      }
      const format = print.format;
      const image = ogImage(html, url);
      const synopsis = paragraphs(cheerio.load(html), '.field-name-body p');
      for (const s of list) {
        s.format ??= format;
        if (image) s.image = image;
        if (synopsis) s.synopsis = synopsis;
      }
    } catch (err) {
      console.warn(`  bampfa: ${url} failed: ${(err as Error).message}`);
    }
  }

  return dedupe([...byUrl.values()].flat());
}

/** "YYYY-MM" for every month touched by the inclusive [from, to] range. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

interface MonthRow {
  screening: RawScreening;
  /** Popup listed director/country/year (.cb_details): a film, not a talk. */
  hasCredits: boolean;
}

function parseMonth(html: string, venue: Venue, base: string, from: string, to: string): MonthRow[] {
  const $ = cheerio.load(html);
  const out: MonthRow[] = [];

  $('td.single-day[data-date]').each((_, td) => {
    const date = $(td).attr('data-date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) return;

    $(td)
      .find('.title.month-title')
      .each((_, el) => {
        try {
          const $title = $(el);
          const card = $title.closest('.calendar-event');
          const tags = card
            .find('ul.calendar_filter li')
            .map((_, li) => $(li).text().trim())
            .get();
          if (!tags.includes('Film')) return;

          const a = $title.find('a').first();
          const rawTitle = a.text().replace(/\s+/g, ' ').trim();
          const href = a.attr('href') ?? '';
          if (!rawTitle || !href) return;
          const url = new URL(href, `${base}/`).toString().split(/[?#]/)[0];

          // "7 PM", "3:30 PM"; "11 AM–7 PM" ranges use the start; "All Day" is skipped.
          const timeText = card.find('.time').first().text().replace(/\s+/g, ' ').trim();
          const time = parseTime(timeText.split(/[–—-]/)[0].trim());
          if (!time) {
            console.warn(`  bampfa: no time for "${rawTitle}" on ${date} ("${timeText}")`);
            return;
          }

          const id = $title.attr('data-id');
          const popup = id ? $(td).find(`.popupboxthing[data-popup="${id}"]`).first() : $();
          const { note, format, image, director, year } = popupDetails($, popup, base);

          out.push({
            screening: { venueId: venue.id, rawTitle, date, time, url, note, format, image, director, year },
            hasCredits: popup.find('.cb_details').length > 0,
          });
        } catch (err) {
          console.warn(`  bampfa: bad calendar row on ${date}: ${(err as Error).message}`);
        }
      });
  });
  return out;
}

function popupDetails(
  $: cheerio.CheerioAPI,
  popup: cheerio.Cheerio<cheerio.AnyNode>,
  base: string,
): { note?: string; format?: string; image?: string; director?: string; year?: number } {
  if (!popup.length) return {};
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

  // Credits block: <div class="cb_details"><div class="director cb_person"> Alice Diop, </div> … <div class="year cb_year"> 2022 </div>
  const director = clean(popup.find('.cb_details .cb_person').first().text()).replace(/[,;\s]+$/, '') || undefined;
  const year = Number(clean(popup.find('.cb_details .cb_year').first().text()).match(/\b(1[89]\d{2}|20\d{2})\b/)?.[1]) || undefined;

  const parts: string[] = [];
  const series = clean(popup.find('.parent-series a').first().text());
  if (series) parts.push(series);

  // Intro line: "New 35mm Print", "4K Digital Restoration"; admission boilerplate is dropped.
  const info = clean(popup.find('.event-information').text());
  if (info && !/admission|tickets? (required|available)|ages? \d/i.test(info)) parts.push(info);

  // In-person guests: <h5 class="dashed-border-bottom">In Conversation</h5> + names.
  const kind = clean(popup.find('h5.dashed-border-bottom').first().text());
  const guests = popup
    .find('.inperson-txt h5')
    .map((_, el) => clean($(el).text()))
    .get()
    .filter(Boolean);
  if (kind && guests.length) parts.push(`${kind}: ${guests.join(', ')}`);
  else if (kind) parts.push(kind);

  let note: string | undefined;
  for (const p of parts) {
    const next = note ? `${note} · ${p}` : p;
    if (next.length > 160) break;
    note = next;
  }

  const format = formatIn(info);
  const src = popup.find('.image img').first().attr('src');
  const image = src ? new URL(src, `${base}/`).toString() : undefined;
  return { note, format, image, director, year };
}

/** Print Info list on the event page: <h4>Print Info</h4><ul><li>B&W</li><li>35mm</li><li>85 mins</li></ul>. */
function printInfo(html: string): { present: boolean; format?: string } {
  const $ = cheerio.load(html);
  const heading = $('h4').filter((_, el) => /print info/i.test($(el).text()));
  if (!heading.length) return { present: false };
  const items = heading
    .next('ul')
    .find('li')
    .map((_, li) => $(li).text().trim())
    .get();
  return { present: true, format: formatIn(items.join(' ')) };
}

function formatIn(text: string): string | undefined {
  const m = text.match(/\b(70mm|35mm|16mm|DCP|4K)\b/i);
  if (!m) return undefined;
  const f = m[1].toUpperCase();
  return f.endsWith('MM') ? f.toLowerCase() : f;
}

function dedupe(list: RawScreening[]): RawScreening[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.url}|${s.date}|${s.time}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
