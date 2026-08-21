import { NextResponse } from 'next/server';
import { BluedartQuoteQuery } from '../../../../../api/contracts';
import { authenticatedRequest, badRequest } from '../../../_auth';
import { findPincode } from '../../../../../data/pincodes';
import { liveCardsFromSource } from '../../../../../data/rate-cards';
import { quoteBluedart } from '../../../../../pricing/bluedart';
import { BLUEDART_SERVICES, SERVICE_LABELS } from '../../../../../domain/bluedart';

export async function GET(request: Request) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const parsed = BluedartQuoteQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return badRequest('Invalid Bluedart quote query.', parsed.error.flatten());
  }
  const q = parsed.data;

  /**
   * Partner carriers are gated per customer by a SameX admin. Quoting one the customer is
   * not enabled for hands them a price they cannot book, which is worse than no price.
   */
  if (q.customer) {
    const { findCustomer } = await import('../../../../../data/customers');
    const { mayUseCarrier, carrierRefusedMessage } = await import('../../../../../customers/carrier-access');
    const customer = await findCustomer(q.customer);
    if (customer && !mayUseCarrier(customer, 'bluedart')) {
      return NextResponse.json(
        {
          bookable: false,
          reason: 'carrier-not-enabled',
          message: carrierRefusedMessage(customer.name, 'Bluedart'),
        },
        { status: 403 },
      );
    }
  }

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
