import type { APIRoute } from 'astro';
import { jsonResponse, meta, publicVenues, upcomingFilms, upcomingScreenings } from '../../lib/api';

/** Normalised data: flat upcoming showtimes plus the films and venues they reference. */
export const GET: APIRoute = () => jsonResponse({ ...meta(), venues: publicVenues(), films: upcomingFilms(), screenings: upcomingScreenings() });
