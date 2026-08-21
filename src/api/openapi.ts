import { z } from 'zod';
import {
  QuoteRequest,
  NetworkQuoteQuery,
  FtlQuoteQuery,
  BluedartQuoteQuery,
  UpsQuoteQuery,
  ShipmentIntakeBody,
  CustomerRegistration,
  BookingExceptionRequest,
  ContractRequestIntake,
  AddressUpsert,
  PlantUpsert,
  DepartmentUpsert,
  TeamMemberUpsert,
  BillingChangeRequest,
  ShipmentUpdate,
  BillLineMark,
  BillAcceptAll,
} from './contracts';

/**
 * The API contract this service publishes.
 *
 * The handbook requires it: "It has its own API contract. Pricing publishes a spec the
 * same way the core does, and the core is written against it. Same append-only rule
 * applies in that direction too."
 *
 * Request shapes are generated from the zod schemas that actually do the validating, so
 * the spec cannot describe a field the service does not accept, or miss one it does.
 * Descriptions and response shapes are written here, because no schema validates our own
 * output — which is an honest limit worth stating rather than papering over: a caller can
 * trust the request side absolutely and should treat the response side as documentation.
 *
 * Served as JSON rather than YAML. The core publishes `openapi.yaml`; the two are the same
 * document in different clothes, and Postman, Bruno and every generator read JSON. Adding
 * a YAML serialiser to hand-roll would risk publishing a malformed contract to save a file
 * extension.
 */

const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' });

/** Query parameters, from the schema that validates them. */
function queryParameters(schema: z.ZodType) {
  const asJson = json(schema) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return Object.entries(asJson.properties ?? {}).map(([name, definition]) => ({
    name,
    in: 'query' as const,
    required: (asJson.required ?? []).includes(name),
    schema: definition,
  }));
}

const jsonBody = (schema: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema: json(schema) } },
});

/**
 * The statuses every authenticated endpoint shares.
 *
 * `429` is here rather than on individual paths because the limiter sits in the shared
 * authenticator: every published endpoint can return it, so declaring it per path would be
 * a list somebody forgets to extend on the next route.
 */
const ok = (description: string) => ({
  '200': { description },
  '400': { description: 'The request did not match this endpoint’s schema.' },
  '401': { description: 'No valid service credentials were presented.' },
  '429': {
    description:
      'Too many requests from this caller. Carries retry-after, x-ratelimit-limit and ' +
      'x-ratelimit-remaining. The budget is per caller, per minute.',
  },
});

export const SERVICE_TITLE = 'DNS Logistics pricing service';

export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: SERVICE_TITLE,
      version: '1.0.0',
      description: [
        'Pricing, quoting and shipment intake for the SameX platform.',
        '',
        'This service is called by the core; it never calls the core. Every endpoint',
        'requires service credentials — there is no user token here, because there is no',
        'person involved in "what does this lane cost".',
        '',
        'Every field is permanent. Fields are added, never renamed or removed, so a',
        'deployed caller cannot be broken by a release here.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'This service' }],
    components: {
      securitySchemes: {
        /**
         * PROVISIONAL. The handbook requires HMAC with a timestamp and a one-use number
         * but does not state the header names or the signed string, so these are ours
         * until the core team confirms theirs. When they do, their scheme is added
         * alongside this one rather than renamed into it.
         */
        signedServiceKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-samex-signature',
          description: [
            'PROVISIONAL — names not yet confirmed with the core team.',
            '',
            'Send four headers: x-samex-key-id, x-samex-timestamp (unix seconds),',
            'x-samex-nonce (unique per request) and x-samex-signature.',
            '',
            'The signature is "sha256=" followed by the hex HMAC-SHA256, keyed with the',
            'shared secret, over these five lines joined by \\n:',
            '',
            '  METHOD',
            '  request path',
            '  timestamp',
            '  nonce',
            '  sha256 hex of the raw body ("" for a GET)',
            '',
            'The timestamp must be within 300 seconds of our clock, and each nonce is',
            'accepted once. Both are what stop a captured request being replayed.',
          ].join('\n'),
        },
        staticKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description:
            'DEPRECATED but permanent. Prefer signedServiceKey: a static key travels on ' +
            'every request and a captured request replays for as long as the key lives.',
        },
      },
    },
    security: [{ signedServiceKey: [] }, { staticKey: [] }],
    paths: {
      '/api/v1/quotes': {
        post: {
          summary: 'Price a shipment across every service tier',
          description:
            'The canonical quoting contract. Returns a quoteId; keep it — it is how the ' +
            'same number is explained again on an invoice months later.',
          requestBody: jsonBody(QuoteRequest),
          responses: {
            ...ok('Tiers, each with a full breakdown, plus the quoteId.'),
            '403': {
              description:
                'The named customer is not enabled for the carrier whose card prices them. ' +
                'Carries reason: carrier-not-enabled. Their base card is that partner’s, so ' +
                'there is no other price to fall back to.',
            },
          },
        },
      },
      '/api/v1/quotes/{quoteId}': {
        get: {
          summary: 'Read back a quote we answered',
          description:
            'Returns what was quoted, not what the card says now. Re-pricing on read ' +
            'would hide the one case this exists for: a rate that has since changed.',
          parameters: [
            { name: 'quoteId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            ...ok('The stored quote, its inputs, and what priced it.'),
            '404': { description: 'No quote with that identifier.' },
          },
        },
      },
      '/api/v1/network/quotes': {
        get: {
          summary: 'Quote our own network for one mode',
          parameters: queryParameters(NetworkQuoteQuery),
          responses: ok('Whether it is bookable, and the price on each eligible card.'),
        },
      },
      '/api/v1/network/ftl/quotes': {
        get: {
          summary: 'Quote a full truck',
          description: 'An FTL booking names a vehicle, not a weight; there is no chargeable weight.',
          parameters: queryParameters(FtlQuoteQuery),
          responses: ok('The rate for that vehicle on that lane, where one exists.'),
        },
      },
      '/api/v1/bluedart/quotes': {
        get: {
          summary: 'Quote the Bluedart franchise card',
          description: 'No origin: everything ships ex-Pune. Omit `service` to price all four.',
          parameters: queryParameters(BluedartQuoteQuery),
          responses: ok('One service, or all four.'),
        },
      },
      '/api/v1/ups/quotes': {
        get: {
          summary: 'Quote the UPS / MOVIN international export card',
          description: 'Origin is fixed at Mumbai and the destination is a country, not a pincode.',
          parameters: queryParameters(UpsQuoteQuery),
          responses: ok('One product, or every product that can carry the shipment.'),
        },
      },
      '/api/v1/shipments': {
        post: {
          summary: 'Hand us shipments that have been booked',
          description:
            'Strict: unknown fields and empty fields are both refused, and a batch is ' +
            'accepted whole or refused whole. One AWB is one shipment, so a retry is safe.',
          requestBody: jsonBody(ShipmentIntakeBody),
          responses: {
            ...ok('Every shipment in the batch was accepted.'),
            '409': { description: 'An unknown customer, or an AWB that conflicts with one we hold.' },
          },
        },
      },
      '/api/v1/customers': {
        get: {
          summary: 'List customers we can price for',
          description:
            'Omit limit and cursor to receive every customer, which is what this has always ' +
            'done. Supply limit to page: the response then carries page.nextCursor, and null ' +
            'there means the last page. The cursor is the last code seen, not an offset, so a ' +
            'customer created mid-page cannot cause one to be read twice or missed.',
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: ok('Customer codes and the card each is on.'),
        },
        post: {
          summary: 'Register a customer created elsewhere',
          description:
            'Puts them on the base card with no overrides — priced exactly like everyone ' +
            'else until terms are negotiated and approved here.',
          requestBody: jsonBody(CustomerRegistration),
          responses: ok('The customer as we now hold them.'),
        },
      },
      '/api/v1/booking-exceptions': {
        get: {
          summary: 'Check whether an exception has been decided',
          parameters: [
            { name: 'reference', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: ok('pending, approved or rejected. Do not book until approved.'),
        },
        post: {
          summary: 'Ask for a shipment the contract does not cover',
          requestBody: jsonBody(BookingExceptionRequest),
          responses: ok('A reference to poll.'),
        },
      },
      '/api/v1/customers/{code}/account': {
        get: {
          summary: 'Everything the enterprise Account Settings page shows',
          description:
            'One call for the whole screen: profile, addresses, plants, departments, team, ' +
            'billing arrangement and credit position \u2014 plus the option lists, so the portal ' +
            'never hard-codes a dropdown this service would refuse.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { ...ok('The customer\u2019s account.'), '404': { description: 'Unknown customer.' } },
        },
      },
      '/api/v1/customers/{code}/addresses': {
        post: {
          summary: 'Create or edit an address in the customer\u2019s book',
          description:
            'Send an id to edit, omit it to create. At most one address is the default ' +
            'pickup: starring one unstars the rest, and deleting the default moves the star.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: jsonBody(AddressUpsert),
          responses: { ...ok('The address as saved.'), '201': { description: 'Created.' } },
        },
        delete: {
          summary: 'Remove an address',
          parameters: [
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: ok('Removed.'),
        },
      },
      '/api/v1/customers/{code}/plants': {
        post: {
          summary: 'Create or edit a plant',
          description:
            'Location is collected as one line ("Mumbai, Maharashtra") and split on the last ' +
            'comma into city and state, because a pincode has to resolve to a zone.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: jsonBody(PlantUpsert),
          responses: { ...ok('The plant as saved.'), '201': { description: 'Created.' } },
        },
        delete: {
          summary: 'Remove a plant, and any departments at it',
          parameters: [
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'plantCode', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: ok('Removed.'),
        },
      },
      '/api/v1/customers/{code}/departments': {
        get: {
          summary: 'Departments, optionally narrowed to one plant',
          description:
            'Serves the departments/by-plant/{id} call, as a filter rather than a second ' +
            'route \u2014 it is the same list with a where on it.',
          parameters: [
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'plantCode', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: ok('Departments.'),
        },
        post: {
          summary: 'Create or edit a department',
          description: 'Refused unless the named plant exists \u2014 enforced here, not only on the screen.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: jsonBody(DepartmentUpsert),
          responses: { ...ok('The department as saved.'), '201': { description: 'Created.' } },
        },
        delete: {
          summary: 'Remove a department',
          parameters: [
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: ok('Removed.'),
        },
      },
      '/api/v1/customers/{code}/team': {
        get: {
          summary: 'The team roster',
          description:
            'Serves both team and team-emails \u2014 the second is this list with only the ' +
            'addresses taken off, and the whole member lets a picker show a name beside the ' +
            'address. No credential appears here, because none is held.',
          parameters: [
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'activeOnly', in: 'query', required: false, schema: { type: 'boolean' } },
          ],
          responses: ok('Team members.'),
        },
        post: {
          summary: 'Add or change somebody on the customer\u2019s team',
          description:
            'NEVER send a password. The body is strict and will refuse one with a 400 \u2014 this ' +
            'service does not store credentials, the core issues them. Only actorRole "owner" ' +
            '(shown in the portal as Supply Chain Head) may change the team, and the account ' +
            'must always keep one active owner.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: jsonBody(TeamMemberUpsert),
          responses: {
            '201': { description: 'The member as saved.' },
            '400': { description: 'Invalid \u2014 including a password being sent.' },
            '401': { description: 'No valid service credentials were presented.' },
            '403': { description: 'Not the owner, or it would leave the account without one.' },
            '404': { description: 'Unknown customer.' },
          },
        },
        delete: {
          summary: 'Disable a team member',
          description:
            'Disabled, never deleted \u2014 they are named on shipments they booked, and a roster ' +
            'that forgets them makes that history unreadable.',
          parameters: [
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'email', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'actorRole', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { ...ok('Disabled.'), '403': { description: 'Refused.' } },
        },
      },
      '/api/v1/customers/{code}/billing-change': {
        post: {
          summary: 'Request a change to the billing arrangement',
          description:
            'What the portal\u2019s "Request Change" button raises. Billing config is read-only to ' +
            'the customer for a reason: a credit period decides what they are charged and when. ' +
            'This lands in the same review queue as a contract request.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: jsonBody(BillingChangeRequest),
          responses: { '201': { description: 'Raised. Returns a reference.' }, '401': { description: 'Unauthorised.' } },
        },
      },
      '/api/v1/contract-requests': {
        get: {
          summary: 'Check a customer negotiation request',
          description:
            'Returns the state only. An accepted request is a promise to price something, ' +
            'not a promise about a price, so no rate is returned here.',
          parameters: [
            { name: 'reference', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            ...ok('pending, accepted or declined, with the reviewer’s comment.'),
            '404': { description: 'No such request.' },
          },
        },
        post: {
          summary: 'Raise a contract request from the enterprise portal',
          description:
            'What a customer wants added to their contract — modes, lanes, weight bands, ' +
            'or rates they propose. Accepting one puts the ask into their draft contract ' +
            'for our team to rate; nothing reaches a quote until that contract is approved. ' +
            'Tell the customer "received", never "granted".',
          requestBody: jsonBody(ContractRequestIntake),
          responses: {
            '201': { description: 'Raised. Returns a reference to poll.' },
            '400': { description: 'The request did not ask for anything.' },
            '401': { description: 'No valid service credentials were presented.' },
            '409': { description: 'We do not price for that customer.' },
          },
        },
      },
      '/api/v1/pincodes/{pincode}': {
        get: {
          summary: 'One pincode, in the core\u2019s own document shape',
          description:
            'Replaces Pincode.findOne({ pincode }) \u2014 seven places in the core do this today. ' +
            'Same fields under the same names, so a caller switches by changing where it asks. ' +
            '404 means we do not serve it, which is a different answer from out of zone.',
          parameters: [{ name: 'pincode', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { ...ok('The pincode.'), '404': { description: 'Not serviceable.' } },
        },
      },
      '/api/v1/cities': {
        get: {
          summary: 'City reference, sorted by hub then city',
          description:
            'Replaces CityReference.find().sort({ hub, cityName }), which fills the ' +
            'contract-request form\u2019s dropdowns. Derived from the pincode master rather than ' +
            'stored, so it cannot go stale when a pincode changes hub.',
          responses: ok('Cities with their hub, prefixes and pincode count.'),
        },
      },
      '/api/v1/customers/{code}/master': {
        get: {
          summary: 'A customer in the core\u2019s CustomerMaster shape',
          description:
            'Replaces CustomerMaster.findOne({ custId }). custId is our customer code. ' +
            'Unset billing fields read "Not configured", exactly as the core\u2019s own endpoint ' +
            'substitutes, so the portal renders a sentence rather than a blank.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { ...ok('The customer master record.'), '404': { description: 'Unknown customer.' } },
        },
      },
      '/api/v1/customers/{code}/rates': {
        get: {
          summary: 'A customer\u2019s negotiated rates, in the core\u2019s CustomerRateCard shape',
          description:
            'Replaces CustomerRateCard.find({ custId }) and the /contracts response around ' +
            'it \u2014 the customer block and the rate rows together, because that endpoint ' +
            'returns both. FOR DISPLAY ONLY: their slab shape applies one rate to the whole ' +
            'weight, ours can be cumulative bands, so these numbers are right to show a ' +
            'customer and must never be an input to a price. Where part of a contract cannot ' +
            'be expressed in their shape (a rule agreed at pincode level), the response says ' +
            'so rather than quietly widening it.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { ...ok('Customer and rate rows.'), '404': { description: 'Unknown customer.' } },
        },
      },
      '/api/v1/customers/{code}/billing': {
        get: {
          summary: 'The customer\u2019s bills \u2014 current and history',
          description:
            'Replaces billing/customer/current and billing/customer/history in one call, ' +
            'because that screen shows both together and two calls let one arrive without ' +
            'the other. "Current" is the newest period actually billed: an open period is ' +
            'not a bill, and showing one invites a query about a total still moving.',
          parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { ...ok('Current bill and history.'), '404': { description: 'Unknown customer.' } },
        },
      },
      '/api/v1/customers/{code}/billing/{periodId}': {
        get: {
          summary: 'One bill, with every line',
          description:
            'Replaces billing/customer/bill/{id} and billing/customer/reconcile/{id} \u2014 one ' +
            'document serves both, because reconciling a bill is reading it with the ' +
            'intention of arguing. The period id is the date it starts, e.g. 2026-08-01.',
          parameters: [
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'periodId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { ...ok('The bill and its lines.'), '404': { description: 'No such bill.' } },
        },
      },
      '/api/v1/customers/{code}/billing/{periodId}/lines': {
        post: {
          summary: 'Accept every outstanding line',
          description:
            'Only lines nobody has looked at. Accepting everything must not quietly ' +
            'withdraw a dispute the customer already raised.',
          parameters: [
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'periodId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: jsonBody(BillAcceptAll),
          responses: ok('How many were accepted.'),
        },
      },
      '/api/v1/customers/{code}/billing/{periodId}/lines/{awb}': {
        post: {
          summary: 'Accept or dispute one line',
          description:
            'Replaces reconcile/{id}/accept and /dispute. One route, because it is one ' +
            'decision with two answers \u2014 and a dispute must carry a reason, which a bare ' +
            '/dispute path has nowhere to put. A dispute here is what later proposes ' +
            'reopening the billing period, so the reason reaches whoever decides.',
          parameters: [
            { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'periodId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'awb', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: jsonBody(BillLineMark),
          responses: {
            ...ok('Recorded.'),
            '404': { description: 'That line is not on this bill.' },
          },
        },
      },
      '/api/v1/shipments/{awb}': {
        get: {
          summary: 'One shipment we hold, with its proof of delivery',
          parameters: [{ name: 'awb', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { ...ok('The shipment.'), '404': { description: 'Not held.' } },
        },
        patch: {
          summary: 'Record proof of delivery against a shipment',
          description:
            'POD lands days after booking, one shipment at a time, and a billing basis of ' +
            '"POD Verified" holds the invoice until it does. Sent here rather than fetched: ' +
            'the core\u2019s POD endpoints are list-scoped to a customer or an admin, with no ' +
            'lookup by AWB for us to call.',
          parameters: [{ name: 'awb', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: jsonBody(ShipmentUpdate),
          responses: {
            ...ok('Recorded.'),
            '404': { description: 'No such shipment \u2014 push the shipment before its POD.' },
          },
        },
      },
      '/api/health': {
        get: {
          summary: 'Liveness, and whether the database is reachable',
          security: [],
          responses: {
            '200': { description: 'Healthy.' },
            '503': { description: 'The database is not reachable.' },
          },
        },
      },
    },
  };
}
