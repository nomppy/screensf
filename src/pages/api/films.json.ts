import type { APIRoute } from 'astro';
import { jsonResponse, meta, upcomingFilms } from '../../lib/api';

/** Films with at least one upcoming showtime, keyed by film key. */
export const GET: APIRoute = () => jsonResponse({ ...meta(), films: upcomingFilms() });
