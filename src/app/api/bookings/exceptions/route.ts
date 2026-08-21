/**
 * Booking exceptions.
 *
 * @deprecated This path is superseded by `/api/v1/booking-exceptions`. It is kept alive permanently, not
 * as a courtesy but as a rule: the platform's contract is append-only, and callers are
 * already installed against this address. Removing it would break them, and we cannot
 * make them redeploy.
 *
 * The implementation lives at the canonical path and this file only points at it, so the
 * two can never drift apart and answer the same question differently.
 */
export { GET, POST } from '../../v1/booking-exceptions/route';
