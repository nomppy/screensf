import { readFileSync, writeFileSync } from 'node:fs';
import type { DecisionRecord, Film, ScheduleData, Screening, Venue } from './types.ts';

export const FILES = {
  venues: 'data/venues.json',
  decisions: 'data/decisions.json',
  manual: 'data/manual.json',
  screenings: 'data/screenings.json',
};

/** A manually entered listing: the screening plus whatever film data we have. */
export interface ManualEntry {
  screening: Screening;
  film: Film;
  addedAt: string;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export const loadVenues = () => readJson<Venue[]>(FILES.venues, []);
export const loadDecisions = () => readJson<Record<string, DecisionRecord>>(FILES.decisions, {});
export const saveDecisions = (d: Record<string, DecisionRecord>) => writeJson(FILES.decisions, d);
export const loadManual = () => readJson<ManualEntry[]>(FILES.manual, []);
export const saveManual = (m: ManualEntry[]) => writeJson(FILES.manual, m);
export const loadSchedule = () =>
  readJson<ScheduleData>(FILES.screenings, { generatedAt: null, films: {}, screenings: [] });
export const saveSchedule = (s: ScheduleData) => writeJson(FILES.screenings, s);

export function screeningId(s: Omit<Screening, 'id'>): string {
  return `${s.venueId}:${s.date}:${s.time}:${s.filmKey}`;
}
