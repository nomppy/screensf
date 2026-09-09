import type { APIRoute, GetStaticPaths } from 'astro';
import { publicVenues, rss, XML_HEADERS } from '../../lib/api';

/** Per-venue RSS feed, e.g. /feed/roxie.xml. */
export const getStaticPaths: GetStaticPaths = () => publicVenues().map((v) => ({ params: { venue: v.id } }));

export const GET: APIRoute = ({ params, site }) =>
  new Response(rss(String(site ?? 'https://screensf.com').replace(/\/$/, ''), { venueId: params.venue }), { headers: XML_HEADERS });
