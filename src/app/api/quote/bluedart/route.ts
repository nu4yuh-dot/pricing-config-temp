import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiKey, badRequest } from '../../_auth';
import { findPincode } from '../../../../data/pincodes';
import { liveCardsFromSource } from '../../../../data/rate-cards';
import { quoteBluedart } from '../../../../pricing/bluedart';
import { BLUEDART_SERVICES, SERVICE_LABELS } from '../../../../domain/bluedart';

/**
 * Quoting the Bluedart franchise card.
 *
 * A separate endpoint because the question has a different shape: there is no origin —
 * everything ships ex-Pune — and the choice is a service rather than a mode. Asking for
 * a service returns that one; asking for none returns all four, so a booking desk can see
 * what the alternatives cost without four round trips.
 */

const Query = z.object({
  to: z.coerce.number().int().positive(),
  weight: z.coerce.number().positive(),
  service: z.enum(BLUEDART_SERVICES).optional(),
  value: z.coerce.number().nonnegative().optional(),
  length: z.coerce.number().nonnegative().optional(),
  breadth: z.coerce.number().nonnegative().optional(),
  height: z.coerce.number().nonnegative().optional(),
  pieces: z.coerce.number().int().positive().optional(),
});

export async function GET(request: Request) {
  const unauthorised = requireApiKey(request);
  if (unauthorised) return unauthorised;

  const url = new URL(request.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid Bluedart quote query.', parsed.error.flatten());
  }
  const q = parsed.data;

  const [card] = await liveCardsFromSource('bluedart');
  const data = card?.data.bluedart;
  if (!data) {
    return NextResponse.json(
      {
        bookable: false,
        error: 'product-not-configured',
        message: 'The Bluedart rate card is not configured.',
      },
      { status: 503 },
    );
  }

  const destination = await findPincode(q.to);
  if (!destination) {
    return NextResponse.json(
      {
        bookable: false,
        error: 'unknown-pincode',
        message: `Pincode ${q.to} is not serviceable.`,
      },
      { status: 404 },
    );
  }
  if (!destination.bluedart) {
    return NextResponse.json(
      {
        bookable: false,
        error: 'no-bluedart-zone',
        message: `Pincode ${q.to} has no Bluedart directional zone.`,
      },
      { status: 404 },
    );
  }

  const shipment = {
    actualWeight: q.weight,
    ...(q.value === undefined ? {} : { declaredValue: q.value }),
    ...(q.length === undefined ? {} : { length: q.length }),
    ...(q.breadth === undefined ? {} : { breadth: q.breadth }),
    ...(q.height === undefined ? {} : { height: q.height }),
    ...(q.pieces === undefined ? {} : { pieces: q.pieces }),
  };

  const services = q.service ? [q.service] : [...BLUEDART_SERVICES];
  const quotes = services.map((service) => {
    const result = quoteBluedart({ service, ...shipment }, destination.bluedart ?? null, data);
    return {
      service,
      label: SERVICE_LABELS[service],
      ...(result.available
        ? { available: true, breakdown: result.breakdown, warnings: result.warnings }
        : { available: false, reason: result.reason, message: result.message }),
    };
  });

  const anyAvailable = quotes.some((entry) => entry.available);

  return NextResponse.json(
    {
      bookable: anyAvailable,
      product: 'bluedart',
      pricing: 'base',
      destination: {
        pincode: destination.pincode,
        area: destination.area,
        district: destination.bluedart.district,
        state: destination.state,
        zone: destination.bluedart.zone,
        odaStatus: destination.bluedart.odaStatus,
        edlKm: destination.bluedart.edlKm,
      },
      quotes,
    },
    // Nothing priced at all — for a single service that is the one asked for being
    // unavailable, which the caller has to handle rather than treat as a price.
    { status: anyAvailable ? 200 : 409 },
  );
}
