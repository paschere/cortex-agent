import { IntegrationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';

/**
 * Datos de vuelos (AeroDataBox). Proveedor OPCIONAL: sólo se ofrece si existe
 * AERODATABOX_API_KEY; sin ella el autofill de las tablas usa la web. Es de
 * sólo lectura.
 */

export const flightsConfigured = () => Boolean(process.env.AERODATABOX_API_KEY);

const sideSchema = z.object({
  airport: z.string(),
  iata: z.string(),
  city: z.string(),
  scheduledLocal: z.string().nullable(),
  revisedLocal: z.string().nullable(),
  terminal: z.string().nullable(),
});

type Side = {
  airport?: { name?: string; iata?: string; municipalityName?: string };
  scheduledTime?: { local?: string };
  revisedTime?: { local?: string };
  terminal?: string;
};

function side(s: Side | undefined): z.infer<typeof sideSchema> {
  return {
    airport: s?.airport?.name ?? '',
    iata: s?.airport?.iata ?? '',
    city: s?.airport?.municipalityName ?? '',
    scheduledLocal: s?.scheduledTime?.local ?? null,
    revisedLocal: s?.revisedTime?.local ?? null,
    terminal: s?.terminal ?? null,
  };
}

export const flightsLookup = registerTool({
  id: 'flights.lookup',
  description:
    'Look up a flight by its number (e.g. "AV204") on a date (default today): airline, origin, destination, scheduled and estimated times, status. Read-only. Use it to fill flight fields; if it is not available, use web.search.',
  inputSchema: z.object({
    flight: z.string().trim().min(2).max(10).describe('Flight number, e.g. AV204 or LA 580.'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('YYYY-MM-DD; defaults to today.'),
  }),
  outputSchema: z.object({
    flights: z.array(
      z.object({
        number: z.string(),
        airline: z.string(),
        status: z.string(),
        departure: sideSchema,
        arrival: sideSchema,
      }),
    ),
  }),
  rateLimit: { perMinute: 20 },
  available: flightsConfigured,
  handler: async (input, ctx) => {
    const key = process.env.AERODATABOX_API_KEY;
    if (!key) throw new IntegrationError('AERODATABOX_API_KEY not configured', 'flights');
    const host = process.env.AERODATABOX_API_HOST || 'aerodatabox.p.rapidapi.com';
    const number = input.flight.replace(/\s+/g, '').toUpperCase();
    const date = input.date ?? new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
    const r = await fetch(`https://${host}/flights/number/${encodeURIComponent(number)}/${date}`, {
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': host },
      signal: ctx.signal,
    });
    if (r.status === 404) return { flights: [] };
    if (!r.ok) throw new IntegrationError(`AeroDataBox ${r.status}`, 'flights');
    const data = (await r.json()) as Array<{
      number?: string;
      status?: string;
      airline?: { name?: string };
      departure?: Side;
      arrival?: Side;
    }>;
    return {
      flights: (Array.isArray(data) ? data : []).slice(0, 5).map((f) => ({
        number: f.number ?? number,
        airline: f.airline?.name ?? '',
        status: f.status ?? '',
        departure: side(f.departure),
        arrival: side(f.arrival),
      })),
    };
  },
});
