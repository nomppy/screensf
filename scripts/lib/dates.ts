const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

export function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Today's date in America/Los_Angeles as YYYY-MM-DD. */
export function todayLA(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Parse strings like "Monday, September 7, 2026", "September 07, 2026",
 * "Sep 7", "MonDAY, September 7" (Balboa's odd casing). When no year is
 * present, `yearHint` is used, rolling forward one year if the result would
 * be more than ~6 months before the hint date.
 */
export function parseLongDate(text: string, yearHint?: { year: number; month: number }): string | null {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const m = cleaned.match(
    /(?:[a-z]+day,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i,
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  let year: number;
  if (m[3]) {
    year = Number(m[3]);
  } else if (yearHint) {
    year = yearHint.year;
    if (month < yearHint.month - 6) year += 1;
  } else {
    year = new Date().getFullYear();
  }
  return ymd(year, month, day);
}

/** "7 PM", "7:30 pm", "12:00 AM", "11:59PM", "19:30" -> "HH:MM". */
export function parseTime(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?\b/i) ?? t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'p' && h !== 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return `${pad(h)}:${pad(min)}`;
}

/** Looks like a time and nothing else (allowing a trailing marker such as "*"). */
export function isTimeLike(text: string): boolean {
  return /^\s*\d{1,2}(:\d{2})?\s*[ap]\.?m\.?\s*[*†‡]?\s*$/i.test(text);
}

export function formatDateHeading(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatTime12(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ap}`;
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
