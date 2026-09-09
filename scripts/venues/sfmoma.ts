import * as cheerio from 'cheerio';
import { fetchJson, fetchText, fetchTextCached } from '../lib/http.ts';
import { ogImage } from '../lib/artwork.ts';
import { horizonEndLA, todayLA } from '../lib/dates.ts';
import type { RawScreening, Venue } from '../lib/types.ts';

/**
 * sfmoma.org is WordPress with a custom "event" post type that is not exposed
 * over /wp-json/ (only its taxonomies are). /calendar/ redirects to
 * /exhibitions/; the public programme lives at /events/, which mixes talks,
 * workshops, family programmes, member events and film screenings.
 *
 * The /events/ page inlines every upcoming occurrence as JSON for its filter
 * widget: `APP.data['archive_filter_posts'] = [{ID, post_title, permalink,
 * StartDate: "2026-09-13", StartTime: "10:30:00", EndDate, terms: [522, ...],
 * supertitle: "Family Program", image: {url}}, ...];`. The same page's filter
 * menu lists the event-category terms (`<label data-termid="522">Film
 * Screening</label>`), so the film term id is read from the markup with 522
 * as the fallback. Category filters (?_terms=) are applied client-side only,
 * so we filter the JSON ourselves; if the inline JSON is missing we POST the
 * widget's admin-ajax action (`archive_events_filter` + selected_dates) which
 * returns `{events: [...]}` in the same shape.
 *
 * Each film's detail page is opened once (cached a week) for the venue line
 * ("Floor 1, Phyllis Wattis Theater"), the JSON-LD description (Q&A, guests,
 * partner such as SFFILM), any stated gauge, and og:image.
 */
export async function scrapeSfmoma(venue: Venue): Promise<RawScreening[]> {
  const base = venue.url.replace(/\/$/, '');
  const today = todayLA();
  const horizon = horizonEndLA(5);

  let posts: ArchivePost[] = [];
  let filmTerm = 522;
  try {
    const html = await fetchText(`${base}/events/`);
    filmTerm = findFilmTerm(html) ?? filmTerm;
    posts = parseInlinePosts(html);
    // The archive is paged client-side but the theme also honours ?_page=N
    // server-side; walk extra pages only when the first one says they exist.
    const pages = Number(html.match(/APP\.data\['max_num_pages'\]\s*=\s*"?(\d+)/)?.[1] ?? 1);
    for (let p = 2; p <= Math.min(pages, 6); p++) {
      try {
        posts.push(...parseInlinePosts(await fetchText(`${base}/events/?_page=${p}`)));
      } catch (err) {
        console.warn(`  sfmoma: page ${p} failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`  sfmoma: /events/ failed: ${(err as Error).message}`);
  }
  if (!posts.length) {
    try {
      posts = await ajaxPosts(base, today, horizon);
    } catch (err) {
      console.warn(`  sfmoma: admin-ajax fallback failed: ${(err as Error).message}`);
    }
  }

  const out: RawScreening[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    try {
      const date = post.StartDate;
      if (!date || date < today || date > horizon) continue;
      const time = (post.StartTime ?? '').match(/^(\d{2}):(\d{2})/);
      if (!time) continue;
      const isFilm = (post.terms ?? []).includes(filmTerm) || /\b(film|screening|cinema)\b/i.test(post.supertitle ?? '');
      if (!isFilm) continue;

      const url = post.permalink || `${base}/events/`;
      const key = `${post.ID}|${date}|${time[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const title = clean(post.post_title || post.title || '');
      if (!title) continue;

      let detail: Detail = {};
      try {
        detail = parseDetail(await fetchTextCached(url, 7 * 24 * 60 * 60 * 1000), url);
      } catch (err) {
        console.warn(`  sfmoma: ${url} failed: ${(err as Error).message}`);
      }
      // Term says film but the page puts it somewhere other than the theater
      // (e.g. a gallery talk about a film): keep it unless the location is
      // clearly not a screening room.
      if (detail.location && /studio|classroom|library|store|offsite|off-site/i.test(detail.location) && !/theater/i.test(detail.location)) {
        continue;
      }

      out.push({
        venueId: venue.id,
        rawTitle: title,
        date,
        time: `${time[1]}:${time[2]}`,
        url,
        note: buildNote(post, detail),
        format: detail.format,
        image: post.image?.url || detail.image,
      });
      if (post.EndDate && post.EndDate !== date) {
        console.warn(`  sfmoma: "${title}" runs ${date}..${post.EndDate}; only the first day is listed`);
      }
    } catch (err) {
      console.warn(`  sfmoma: skipping "${post?.post_title}": ${(err as Error).message}`);
    }
  }
  return out;
}

interface ArchivePost {
  ID: number;
  post_title?: string;
  title?: string;
  permalink?: string;
  StartDate?: string;
  StartTime?: string;
  EndDate?: string;
  terms?: number[];
  supertitle?: string;
  image?: { url?: string };
}

interface Detail {
  location?: string;
  description?: string;
  info?: string;
  format?: string;
  image?: string;
}

/** The `APP.data['archive_filter_posts'] = [...]` literal, bracket-matched. */
function parseInlinePosts(html: string): ArchivePost[] {
  const m = html.match(/APP\.data\['archive_filter_posts'\]\s*=\s*/);
  if (!m || m.index === undefined) return [];
  const start = m.index + m[0].length;
  if (html[start] !== '[') return [];
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      const parsed = JSON.parse(html.slice(start, i + 1)) as unknown;
      return Array.isArray(parsed) ? (parsed as ArchivePost[]) : [];
    }
  }
  return [];
}

function findFilmTerm(html: string): number | null {
  const $ = cheerio.load(html);
  let id: number | null = null;
  $('[data-termid]').each((_, el) => {
    if (/^film/i.test($(el).text().trim())) id = Number($(el).attr('data-termid'));
  });
  return id && Number.isFinite(id) ? id : null;
}

async function ajaxPosts(base: string, from: string, to: string): Promise<ArchivePost[]> {
  const body = new URLSearchParams();
  body.set('action', 'archive_events_filter');
  body.append('selected_dates[]', `${from}T00:00:00.000Z`);
  body.append('selected_dates[]', `${to}T00:00:00.000Z`);
  body.set('id', '');
  const res = await fetchJson<{ events?: ArchivePost[] }>(`${base}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  return res.events ?? [];
}

function parseDetail(html: string, url: string): Detail {
  const $ = cheerio.load(html);
  const location = clean($('.eventcard-wrapper-text-location').first().text());
  const info = clean($('.eventcard-wrapper-text-info').text());
  let description = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text()) as { '@type'?: string; description?: string };
      if (data['@type'] === 'Event' && data.description) description = clean(data.description);
    } catch {
      /* not every ld+json block is the event */
    }
  });
  if (!description) description = clean($('meta[property="og:description"]').attr('content') ?? '');
  const body = clean($('.single-column-content, .wysiwygmodule-content').text());
  const fm = `${info} ${description} ${body}`.match(/\b(16\s?mm|35\s?mm|70\s?mm|super\s?8|8\s?mm|4K|DCP)\b/i);
  return {
    location: location || undefined,
    description: description || undefined,
    info: info || undefined,
    format: fm ? fm[1].replace(/\s+/g, '').replace(/^super8$/i, 'Super 8').replace(/mm$/i, 'mm') : undefined,
    image: ogImage(html, url),
  };
}

/** Programme framing (family/member series), guests, Q&A, partner org. */
function buildNote(post: ArchivePost, detail: Detail): string | undefined {
  const parts: string[] = [];
  const super_ = clean(post.supertitle ?? '');
  if (super_ && !/^(film screening|film|event)$/i.test(super_)) parts.push(super_);
  const text = `${detail.description ?? ''} ${detail.info ?? ''}`;
  const sentence = text
    .split(/(?<=[.!?])\s+/)
    .find((s) => /\b(in[- ]person|Q\s?[+&]\s?A|conversation|introduc|live score|curated by|presented (by|with)|with SFFILM|filmmaker)/i.test(s));
  if (sentence) parts.push(sentence.replace(/^Join us (and [^,]+ )?for /i, ''));
  const note = parts.join(' — ').trim();
  if (!note) return undefined;
  return note.length <= 160 ? note : `${note.slice(0, 157).replace(/\s+\S*$/, '')}…`;
}

function clean(s: string): string {
  return cheerio.load(`<x>${s.replace(/<[^>]+>/g, ' ')}</x>`)('x').text().replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}
