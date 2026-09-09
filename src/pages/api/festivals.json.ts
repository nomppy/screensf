import type { APIRoute } from 'astro';
import { upcomingFestivals } from '../../lib/schedule';
import { jsonResponse, meta } from '../../lib/api';

/** Festivals and series still running or upcoming, with their programmes where the venue publishes one. */
export const GET: APIRoute = () => jsonResponse({ ...meta(), festivals: upcomingFestivals() });
