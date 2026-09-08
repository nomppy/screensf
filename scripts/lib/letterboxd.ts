import * as cheerio from 'cheerio';
import { fetchText, JsonCache } from './http.ts';
import { normalizeTitle } from './titles.ts';
import type { Film } from './types.ts';

export interface WatchlistFilm {
  slug: string;
  title: string;
  year?: number;
  tmdbId?: number;
}

const filmCache = new JsonCache<WatchlistFilm>('.cache/letterboxd-films.json');

/**
 * Read a public Letterboxd watchlist. The grid pages hold 28 posters each as
 * `li.poster-container > div[data-film-slug]` with the title in the <img alt>.
 * Year and TMDB id are not on the grid, so each film page is fetched once and
 * cached; Letterboxd film pages link to themoviedb.org and expose
 * `data-tmdb-id` on the body.
 */
export async function fetchWatchlist(user: string, maxPages = 20): Promise<WatchlistFilm[]> {
  const films: WatchlistFilm[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `https://letterboxd.com/${user}/watchlist/` : `https://letterboxd.com/${user}/watchlist/page/${page}/`;
    const html = await fetchText(url);
    const $ = cheerio.load(html);
    const posters = $('li.poster-container div[data-film-slug], li.poster-container div.film-poster, div.react-component[data-film-slug]');
    if (!posters.length) break;
    let added = 0;
    posters.each((_, el) => {
      const $el = $(el);
      const slugAttr = $el.attr('data-film-slug') ?? $el.attr('data-target-link') ?? '';
      const slug = slugAttr.replace(/^\/?film\//, '').replace(/\/$/, '');
      const title = ($el.find('img').attr('alt') ?? $el.attr('data-film-name') ?? '').trim();
      if (!slug || !title) return;
      if (films.some((f) => f.slug === slug)) return;
      films.push({ slug, title });
      added++;
    });
    if (!added) break;
    // Letterboxd's "Older" link is absent on the last page.
    if (!$('a.next, .paginate-nextprev a[href*="/page/"]').length && !$(`a[href*="/watchlist/page/${page + 1}/"]`).length) break;
  }

  // Enrich with year + TMDB id, cached forever per slug.
  for (const f of films) {
    const hit = filmCache.get(f.slug);
    if (hit) {
      Object.assign(f, hit);
      continue;
    }
    try {
      const html = await fetchText(`https://letterboxd.com/film/${f.slug}/`);
      const $ = cheerio.load(html);
      const tmdb = $('body').attr('data-tmdb-id') ?? html.match(/themoviedb\.org\/movie\/(\d+)/)?.[1];
      const yearText =
        $('.releaseyear a, small.number a, a[href*="/films/year/"]').first().text().trim() ||
        html.match(/\/films\/year\/(\d{4})\//)?.[1];
      f.tmdbId = tmdb ? Number(tmdb) : undefined;
      f.year = yearText ? Number(yearText) : undefined;
      filmCache.set(f.slug, f);
    } catch (err) {
      console.warn(`  letterboxd: could not enrich ${f.slug}: ${(err as Error).message}`);
    }
  }
  return films;
}

export interface WatchlistMatch {
  watchlist: WatchlistFilm;
  filmKey: string;
  how: 'tmdb' | 'title';
}

export function matchWatchlist(watchlist: WatchlistFilm[], films: Record<string, Film>): WatchlistMatch[] {
  const byTmdb = new Map<number, Film>();
  const byTitle = new Map<string, Film[]>();
  for (const f of Object.values(films)) {
    if (f.tmdbId) byTmdb.set(f.tmdbId, f);
    const n = normalizeTitle(f.title);
    byTitle.set(n, [...(byTitle.get(n) ?? []), f]);
  }
  const out: WatchlistMatch[] = [];
  for (const w of watchlist) {
    if (w.tmdbId && byTmdb.has(w.tmdbId)) {
      out.push({ watchlist: w, filmKey: byTmdb.get(w.tmdbId)!.key, how: 'tmdb' });
      continue;
    }
    for (const f of byTitle.get(normalizeTitle(w.title)) ?? []) {
      if (w.year && f.year && Math.abs(w.year - f.year) > 1) continue;
      out.push({ watchlist: w, filmKey: f.key, how: 'title' });
    }
  }
  return out;
}
