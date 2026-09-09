import type { APIRoute } from 'astro';
import { rss, XML_HEADERS } from '../lib/api';

/** RSS feed of every upcoming screening: one item per film, venue and day. */
export const GET: APIRoute = ({ site }) => new Response(rss(String(site ?? 'https://screensf.com').replace(/\/$/, '')), { headers: XML_HEADERS });
