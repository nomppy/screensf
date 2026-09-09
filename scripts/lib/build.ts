/**
 * The "resolved" snapshot is everything sync learned about the current
 * calendars: each distinct title, its showtimes, the TMDB match and the
 * classifier's verdict. It is written to .cache/resolved.json so the review UI
 * (and a re-finalize) can work without scraping again.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { horizonEndLA, todayLA } from './dates.ts';
import { loadDecisions, loadManual, saveSchedule, screeningId } from './store.ts';
import { filmFromTmdb } from './tmdb.ts';
import { extractFormat, extractNoteFromTitle, fallbackKey } from './titles.ts';
import type { DecisionRecord, Festival, Film, FilmEdits, RawScreening, ScheduleData, Screening, TmdbMovie, Venue } from './types.ts';

export interface ResolvedItem {
  key: string;
  venueId: string;
  raws: RawScreening[];
  candidates: string[];
  year?: number;
  film: Film | null;
  /** TMDB overview of the best guess, for the review card. */
  overview?: string;
  alternatives: TmdbMovie[];
  action: 'include' | 'exclude' | 'ask';
  reason: string;
  /** Artwork from the venue's listing page, used when TMDB has none or when chosen in review. */
  venueImage?: string;
}

export interface ResolvedSnapshot {
  generatedAt: string;
  venues: Venue[];
  festivals: Festival[];
  nowPlaying: number[];
  items: ResolvedItem[];
}

const FILE = '.cache/resolved.json';

export function saveResolved(snap: ResolvedSnapshot) {
  mkdirSync('.cache', { recursive: true });
  writeFileSync(FILE, JSON.stringify(snap));
}

export function loadResolved(): ResolvedSnapshot | null {
  if (!existsSync(FILE)) return null;
  return JSON.parse(readFileSync(FILE, 'utf8')) as ResolvedSnapshot;
}

export type FinalAction = 'include' | 'exclude' | 'skip';

/** Apply saved decisions on top of the classifier's verdicts. */
export function effectiveAction(item: ResolvedItem, decision?: DecisionRecord): FinalAction {
  if (decision) return decision.decision;
  return item.action === 'ask' ? 'skip' : item.action;
}

export interface FinalizeResult {
  data: ScheduleData;
  included: number;
  excluded: number;
  pending: ResolvedItem[];
  /** every film seen (incl. excluded) keyed by film key, for watchlist matching */
  seenFilms: Record<string, Film>;
  /** raw showtime -> film key */
  rawFilmKey: Map<RawScreening, string>;
}

/**
 * Build data/screenings.json from a snapshot plus the current decisions.
 * Decisions that picked an alternative TMDB id are resolved here (details are
 * cached, so this is cheap after the first time).
 */
export async function finalizeSchedule(snap: ResolvedSnapshot, decisions = loadDecisions()): Promise<FinalizeResult> {
  const today = todayLA();
  const horizon = horizonEndLA();
  const nowPlaying = new Set(snap.nowPlaying);
  const films: Record<string, Film> = {};
  const seenFilms: Record<string, Film> = {};
  const screenings: Screening[] = [];
  const rawFilmKey = new Map<RawScreening, string>();
  const pending: ResolvedItem[] = [];
  let included = 0;
  let excluded = 0;

  for (const item of snap.items) {
    const decision = decisions[item.key];
    const action = effectiveAction(item, decision);

    let film = item.film;
    if (decision?.decision === 'include') {
      if (decision.tmdbId === null) film = null;
      else if (decision.tmdbId && decision.tmdbId !== film?.tmdbId) {
        try {
          film = await filmFromTmdb(decision.tmdbId, nowPlaying.has(decision.tmdbId));
        } catch {
          /* keep the original guess if TMDB is unreachable */
        }
      }
    }
    let record: Film = film ?? { key: fallbackKey(item.candidates[0], item.year), title: item.candidates[0], year: item.year };
    record = withEdits(record, decision?.edits);
    record = withArtwork(record, item.venueImage, decision?.image);
    seenFilms[record.key] = record;
    for (const r of item.raws) rawFilmKey.set(r, record.key);

    if (action === 'include') {
      included++;
      films[record.key] = record;
      for (const r of item.raws) {
        if (r.date < today || r.date > horizon) continue;
        const base = {
          venueId: r.venueId,
          filmKey: record.key,
          date: r.date,
          time: r.time,
          url: r.url,
          format: r.format ?? extractFormat(r.rawTitle),
          note: r.note ?? extractNoteFromTitle(r.rawTitle),
          source: r.venueId,
        };
        screenings.push({ id: screeningId(base), ...base });
      }
    } else if (action === 'exclude') {
      excluded++;
    } else {
      pending.push(item);
    }
  }

  for (const m of loadManual()) {
    if (m.screening.date < today || m.screening.date > horizon) continue;
    films[m.film.key] = { ...m.film, ...(films[m.film.key] ?? {}) };
    seenFilms[m.film.key] = films[m.film.key];
    if (!screenings.some((s) => s.id === m.screening.id)) screenings.push(m.screening);
  }

  screenings.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const festivals = snap.festivals.filter((f) => f.endDate >= today);
  const data: ScheduleData = { generatedAt: new Date().toISOString(), films, screenings, festivals };
  saveSchedule(data);
  return { data, included, excluded, pending, seenFilms, rawFilmKey };
}

/** Apply hand edits from review on top of the TMDB record. Empty strings clear a field. */
export function withEdits(film: Film, edits?: FilmEdits): Film {
  if (!edits) return film;
  const out: Film = { ...film };
  for (const [k, v] of Object.entries(edits) as [keyof FilmEdits, unknown][]) {
    if (v === undefined) continue;
    if (v === null || v === '') delete out[k];
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Pick the card image. A review override wins; otherwise TMDB art; otherwise
 * whatever the venue published. The site renders backdrop ?? poster, so the
 * chosen image is stored as the backdrop.
 */
export function withArtwork(film: Film, venueImage?: string, override?: string): Film {
  if (override) return { ...film, backdrop: override, poster: film.poster ?? override };
  if (!film.poster && !film.backdrop && venueImage) return { ...film, backdrop: venueImage };
  return film;
}
