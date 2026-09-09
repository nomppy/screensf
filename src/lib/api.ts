/**
 * Shared helpers for the public data endpoints (/api/*.json) and RSS feeds
 * (/feed.xml, /feed/<venue>.xml). Everything is generated at build time from
 * data/screenings.json, so it is exactly what the schedule page shows.
 */
import schedule from '../../data/screenings.json';
import venuesJson from '../../data/venues.json';
import { buildDays, generatedAt, runtime, time12, upcomingFestivals, todayLA, type Card, type Film, type Screening, type Venue } from './schedule';

const venues = (venuesJson as Venue[]).map(({ id, name, shortName, city, url }) => ({ id, name, shortName, city, url }));
const films = schedule.films as Record<string, Film>;
const screenings = schedule.screenings as Screening[];

export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
export const XML_HEADERS = { 'content-type': 'application/rss+xml; charset=utf-8', 'access-control-allow-origin': '*' };

export function publicVenues() {
  return venues;
}

/** Every upcoming showtime, flat, with its film and venue ids. */
export function upcomingScreenings() {
  const today = todayLA();
  return screenings.filter((s) => s.date >= today && films[s.filmKey]).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/** Films referenced by at least one upcoming showtime. */
export function upcomingFilms() {
  const keys = new Set(upcomingScreenings().map((s) => s.filmKey));
  return Object.fromEntries(Object.entries(films).filter(([k]) => keys.has(k)));
}

/** The schedule as the site renders it: days of cards, each card one film at one venue with all its times. */
export function scheduleDays() {
  return buildDays().map((d) => ({
    date: d.date,
    cards: d.cards.map((c) => ({
      film: c.film,
      venue: { id: c.venue.id, name: c.venue.name, shortName: c.venue.shortName, city: c.venue.city, url: c.venue.url },
      date: c.date,
      times: c.times,
      format: c.format ?? null,
      note: c.note ?? null,
    })),
  }));
}

export function meta() {
  return { generatedAt, site: 'Screen SF', source: 'https://github.com/nomppy/screensf', license: 'Listings are public information gathered from the venues; film metadata and artwork © TMDB.' };
}

export const jsonResponse = (body: unknown) => new Response(JSON.stringify(body, null, 2) + '\n', { headers: JSON_HEADERS });

// ---------------------------------------------------------------------------
// RSS

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** RFC 822 date for a screening day, 9am Pacific so items sort by show date. */
function pubDate(date: string): string {
  return new Date(`${date}T09:00:00-07:00`).toUTCString();
}

function itemFor(c: Card, site: string): string {
  const f = c.film;
  const bits = [f.year, f.director, runtime(f.runtime), c.format].filter(Boolean).join(' · ');
  const times = c.times.map((t) => time12(t.time)).join(', ');
  const title = `${f.title}${f.year ? ` (${f.year})` : ''} — ${c.venue.shortName}, ${longDate(c.date)}`;
  const link = c.times[0]?.url || c.venue.url || site;
  const image = f.backdrop ?? f.poster;
  const html =
    (image ? `<p><img src="${esc(image)}" alt="" /></p>` : '') +
    `<p><strong>${esc(c.venue.name)}</strong> · ${esc(longDate(c.date))} · ${esc(times)}</p>` +
    (bits ? `<p>${esc(bits)}</p>` : '') +
    (c.note ? `<p><em>${esc(c.note)}</em></p>` : '') +
    (f.overview ? `<p>${esc(f.overview)}</p>` : '') +
    `<p><a href="${esc(link)}">Tickets and details at ${esc(c.venue.shortName)}</a></p>`;
  return (
    `<item>` +
    `<title>${esc(title)}</title>` +
    `<link>${esc(link)}</link>` +
    `<guid isPermaLink="false">${esc(`${c.venue.id}|${f.key}|${c.date}`)}</guid>` +
    `<pubDate>${pubDate(c.date)}</pubDate>` +
    `<category>${esc(c.venue.shortName)}</category>` +
    (f.genre ? `<category>${esc(f.genre)}</category>` : '') +
    `<description><![CDATA[${html}]]></description>` +
    `</item>`
  );
}

export function rss(site: string, opts: { venueId?: string } = {}): string {
  const venue = opts.venueId ? venues.find((v) => v.id === opts.venueId) : undefined;
  const cards = scheduleDays().flatMap((d) => d.cards).filter((c) => !opts.venueId || c.venue.id === opts.venueId);
  const title = venue ? `Screen SF · ${venue.shortName}` : 'Screen SF';
  const desc = venue
    ? `Upcoming screenings at ${venue.name}, ${venue.city}. One item per film per day.`
    : 'Repertory and independent film screenings around the San Francisco Bay Area. One item per film, venue and day.';
  const self = venue ? `${site}/feed/${venue.id}.xml` : `${site}/feed.xml`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">` +
    `<channel>` +
    `<title>${esc(title)}</title>` +
    `<link>${esc(site)}/</link>` +
    `<description>${esc(desc)}</description>` +
    `<language>en-us</language>` +
    `<lastBuildDate>${new Date(generatedAt ?? Date.now()).toUTCString()}</lastBuildDate>` +
    `<atom:link href="${esc(self)}" rel="self" type="application/rss+xml" />` +
    cards.map((c) => itemFor(c as Card, site)).join('') +
    `</channel></rss>\n`
  );
}
