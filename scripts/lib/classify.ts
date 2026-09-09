import { daysBetween, todayLA } from './dates.ts';
import type { Film } from './types.ts';

export type Verdict =
  | { action: 'include'; reason: string }
  | { action: 'exclude'; reason: string }
  | { action: 'ask'; reason: string };

export interface ClassifyOptions {
  /** TMDB popularity at or above which a now-playing film is a blockbuster. */
  blockbusterPopularity: number;
  /** Films older than this are repertory and always in. */
  repertoryDays: number;
  /** New releases not in wide release become auto-includes after this many days. */
  settledDays: number;
  /** A non-repertory film with at least this many showtimes in the window is a first-run booking, not a rep screening. */
  firstRunShowtimes: number;
  /** Repertory and settled releases at or above this TMDB popularity are asked about rather than included on sight. */
  askPopularity: number;
}

/** Facts about the listing itself that bear on the verdict. */
export interface ClassifyContext {
  /** Showtimes for this title in the sync window. */
  showtimes?: number;
  /** The venue's title is one or two words ("Comedy", "Live Music"), so an exact TMDB title match proves little. */
  generic?: boolean;
  /** The match was confirmed by the venue's own director credit. */
  confirmed?: boolean;
}

export const DEFAULTS: ClassifyOptions = {
  blockbusterPopularity: Number(process.env.BLOCKBUSTER_POPULARITY ?? 60),
  repertoryDays: 730,
  settledDays: 90,
  firstRunShowtimes: Number(process.env.FIRST_RUN_SHOWTIMES ?? 20),
  askPopularity: Number(process.env.REPERTORY_POPULARITY ?? 20),
};

/**
 * Decide whether a screening belongs on a repertory / arthouse schedule.
 *
 *   No TMDB match ............................ ask (could be shorts, a live event, or a typo)
 *   Unconfident TMDB match ................... ask
 *   Generic one/two-word title matched to an
 *     obscure film, no director to confirm .... ask ("Live Music" is not a 2009 movie)
 *   Released <= repertoryDays ago with
 *     >= firstRunShowtimes showtimes ......... exclude (a first-run booking: several shows a day for weeks)
 *   In US now-playing and popular ............ exclude (the blockbuster case)
 *   In US now-playing but not popular ........ ask   (indie first-run at the Roxie, e.g.)
 *   Released > repertoryDays ago, popular .... ask   (studio re-release, kids' matinee: decide once per film)
 *   Released > repertoryDays ago ............. include
 *   Released > settledDays ago, popular ...... ask   (a blockbuster that has left the now-playing list)
 *   Released > settledDays ago, not wide ..... include
 *   Anything else (fresh release) ............ ask
 *
 * "Popular" for the two ask rules means TMDB popularity >= askPopularity
 * (REPERTORY_POPULARITY, default 20). Decisions are keyed by title and year,
 * so each such film is asked about once.
 */
export function classify(film: Film | null, confident: boolean, ctx: ClassifyContext = {}, opts: ClassifyOptions = DEFAULTS): Verdict {
  if (!film || !film.tmdbId) return { action: 'ask', reason: 'no TMDB match' };
  if (!confident) return { action: 'ask', reason: 'uncertain TMDB match' };

  const pop = film.popularity ?? 0;
  const showtimes = ctx.showtimes ?? 0;
  if (ctx.generic && !ctx.confirmed && pop < 2) {
    return { action: 'ask', reason: `generic title, obscure TMDB match (popularity ${pop.toFixed(1)})` };
  }
  const age = film.releaseDate ? daysBetween(film.releaseDate, todayLA()) : null;
  const repertory = age !== null && age > opts.repertoryDays;
  if (!repertory && showtimes >= opts.firstRunShowtimes) {
    return { action: 'exclude', reason: `first-run booking, ${showtimes} showtimes in the window` };
  }
  if (film.nowPlaying) {
    if (pop >= opts.blockbusterPopularity) {
      return { action: 'exclude', reason: `in wide US release, popularity ${Math.round(pop)}` };
    }
    return { action: 'ask', reason: `in US now-playing list, popularity ${Math.round(pop)}` };
  }

  if (age === null) return { action: 'ask', reason: 'no release date' };
  if (age > opts.repertoryDays) {
    if (pop >= opts.askPopularity) return { action: 'ask', reason: `popular re-release (${film.year}), popularity ${Math.round(pop)}` };
    return { action: 'include', reason: `repertory (${film.year})` };
  }
  if (age > opts.settledDays) {
    if (pop >= opts.askPopularity) return { action: 'ask', reason: `popular release, ${age} days old, popularity ${Math.round(pop)}` };
    return { action: 'include', reason: `released ${age} days ago, not in wide release` };
  }
  if (age < -30) return { action: 'ask', reason: 'unreleased / preview' };
  return { action: 'ask', reason: `new release (${age} days), popularity ${Math.round(pop)}` };
}
