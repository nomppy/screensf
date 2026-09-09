import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.ts';
import { horizonEndLA, parseTime, todayLA, ymd } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * The Grand Lake (Renaissance Rialto) website is hand-edited Dreamweaver
 * HTML: showtimes are prose like "SAT-SUN: 12:30, 3:45, 7:30" under a weekly
 * "Friday September 4 - Thursday September 10" heading, with next week on
 * next.php. Parsing that is fragile, so dates and times come from the
 * theatre's RTS ticketing site instead (73279.formovietickets.com:2235,
 * plain HTTP). `T.ASP?WCI=BT&Page=schedule&SelectedDate=YYYYMMDD` returns,
 * for one day, a <select> of every bookable date plus one block per film:
 * <b><a class="displaytitle">TITLE</a> (G) Running Time…</b> (one-off events
 * have a bare-text title instead of the anchor) followed by a
 * .showings_group holding .amenity_title badges ("70 MM") and a.showtime
 * links ("3:05p"). Special events (festival nights, silent films with live
 * music) are in the same feed.
 *
 * RTS titles are ALL CAPS, so the website's index.php / next.php are read
 * once for the properly-cased title and poster of each film; unmatched
 * titles are title-cased. Events ticketed elsewhere (e.g. the Oakland
 * International Film Festival, which links to oiff.org) never reach RTS.
 */
const RTS = 'http://73279.formovietickets.com:2235/T.ASP?WCI=BT&Page=schedule';
const WEEKS = 5;

interface SiteFilm {
  title: string;
  image?: string;
}

export async function scrapeGrandLake(venue: Venue): Promise<RawScreening[]> {
  const base = venue.url.replace(/\/$/, '');
  const site = await siteFilms(base);

  const first = await fetchText(RTS);
  const $ = cheerio.load(first);
  const today = todayLA();
  const horizon = horizonEndLA(WEEKS);

  // Every bookable date, from the date picker.
  const dates: string[] = [];
  $('select option').each((_, el) => {
    const m = ($(el).attr('value') ?? '').match(/SelectedDate=(\d{4})(\d{2})(\d{2})/);
    if (!m) return;
    const d = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d >= today && d <= horizon && !dates.includes(d)) dates.push(d);
  });
  if (!dates.length) {
    console.warn('  grandlake: no dates found in the RTS date picker');
    return [];
  }

  const selected = $('select option[selected]').attr('value')?.match(/SelectedDate=(\d{8})/)?.[1];
  const out: RawScreening[] = [];
  for (const date of dates) {
    const compact = date.replace(/-/g, '');
    const url = `${RTS}&SelectedDate=${compact}`;
    try {
      const html = compact === selected ? first : await fetchText(url);
      out.push(...parseDay(html, date, url, venue, site));
    } catch (err) {
      console.warn(`  grandlake: ${date} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

function parseDay(html: string, date: string, url: string, venue: Venue, site: Map<string, SiteFilm>): RawScreening[] {
  const $ = cheerio.load(html);
  const out: RawScreening[] = [];
  // Each film is a <b> (title, rating, running time) followed by its
  // .showings_group sibling. Films with a studio site wrap the title in
  // a.displaytitle; one-off events have bare text before the first <br>.
  $('b').each((_, el) => {
    try {
      const $b = $(el);
      const group = $b.nextAll('.showings_group').first();
      const nextB = $b.nextAll('b').first();
      // The group must belong to this <b>, not to a later film's.
      if (!group.length || (nextB.length && nextB.index() < group.index())) return;
      const linked = $b.find('a.displaytitle').text();
      const head = ($b.html() ?? '').split(/<br\s*\/?>/i)[0];
      const rts = (linked || cheerio.load(`<i>${head}</i>`)('i').text()).replace(/\s+/g, ' ').trim();
      if (!rts || /running time/i.test(rts)) return;

      const match = matchSite(rts, site);
      const rawTitle = match?.title ?? titleCase(rts);
      const format = formatFrom(
        group
          .find('.amenity_title')
          .map((_, a) => $(a).text())
          .get()
          .join(' ') + ' ' + rts,
      );

      group.find('a.showtime').each((_, t) => {
        const time = parseTime($(t).text().trim());
        if (!time) return;
        out.push({ venueId: venue.id, rawTitle, date, time, url, format, image: match?.image });
      });
    } catch (err) {
      console.warn(`  grandlake: bad film block on ${date}: ${(err as Error).message}`);
    }
  });
  return out;
}

/** Properly-cased titles and poster URLs from the venue's own listing pages. */
async function siteFilms(base: string): Promise<Map<string, SiteFilm>> {
  const films = new Map<string, SiteFilm>();
  for (const page of ['index.php', 'next.php']) {
    try {
      const $ = cheerio.load(await fetchText(`${base}/${page}`));
      $('h3.movTitle').each((_, el) => {
        const $h = $(el);
        const title = $h.text().replace(/\s+/g, ' ').trim();
        if (!title || $h.find('img').length) return;
        const img =
          $h.prevAll('h3.movTitle').first().find('img').attr('src') ??
          $h.closest('.movPod, [itemscope]').find('.poster img, img[src*="posters/"]').first().attr('src');
        const image = img ? new URL(img, `${base}/`).toString() : undefined;
        const key = normalize(title);
        if (key && !films.has(key)) films.set(key, { title, image });
      });
    } catch (err) {
      console.warn(`  grandlake: ${page} failed (${(err as Error).message}); titles will be title-cased`);
    }
  }
  return films;
}

function matchSite(rts: string, site: Map<string, SiteFilm>): SiteFilm | undefined {
  const variants = [rts, rts.replace(/\b(in\s+)?70\s*MM\b/i, ''), rts.replace(/\bencore\b/i, '')];
  for (const v of variants) {
    const key = normalize(v);
    if (key.length < 3) continue;
    const exact = site.get(key);
    if (exact) return exact;
    for (const [k, film] of site) {
      const kk = normalize(k.replace(/IN70MM$/, ''));
      if (kk.length >= 6 && key.length >= 6 && (kk.includes(key) || key.includes(kk))) return film;
    }
  }
  return undefined;
}

function normalize(s: string): string {
  return s
    .toUpperCase()
    .replace(/^THE\s+/, '')
    .replace(/[^A-Z0-9]/g, '');
}

function titleCase(s: string): string {
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.replace(/^[a-z]/, (c) => c.toUpperCase())))
    .join(' ')
    .replace(/\b(\d+)mm\b/i, '$1mm');
}

function formatFrom(text: string): string | undefined {
  if (/\b70\s*MM\b/i.test(text)) return '70mm';
  if (/\b35\s*MM\b/i.test(text)) return '35mm';
  if (/\b16\s*MM\b/i.test(text)) return '16mm';
  if (/\b3-?D\b/i.test(text)) return '3D';
  if (/\b4K\b/i.test(text)) return '4K';
  return undefined;
}
