import type { APIRoute } from 'astro';
import { jsonResponse, meta, publicVenues } from '../../lib/api';

export const GET: APIRoute = () => jsonResponse({ ...meta(), venues: publicVenues() });
