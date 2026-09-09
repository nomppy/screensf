import type { APIRoute } from 'astro';
import { jsonResponse, meta, scheduleDays } from '../../lib/api';

/** The schedule as rendered: upcoming days, each a list of cards (one film at one venue with all its times). */
export const GET: APIRoute = () => jsonResponse({ ...meta(), days: scheduleDays() });
