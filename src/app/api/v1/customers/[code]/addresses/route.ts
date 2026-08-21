import { NextResponse } from 'next/server';
import { AddressUpsert } from '../../../../../../api/contracts';
import { authenticatedJson, authenticatedRequest, badRequest } from '../../../../_auth';
import { saveAddress, deleteAddress } from '../../../../../../data/enterprise';
import { portalActor, customerOr404 } from '../../../../../../customers/portal-actor';

/**
 * The customer's address book.
 *
 * POST creates or edits — send an `id` to edit, omit it to create. One verb rather than
 * two because the portal's form is one form, and a create that silently duplicates an
 * entry the customer thought they were editing is the failure this avoids.
 */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = AddressUpsert.safeParse(auth.body);
  if (!parsed.success) return badRequest('Invalid address.', parsed.error.flatten());

  const { code } = await params;
  const customer = await customerOr404(code);
  if ('response' in customer) return customer.response;

  // The core names these `address`, `type`, `phoneCode` and `isDefault`; we shipped
  // `addressLine`, `usedFor`, `contactPhoneCountry` and `defaultPickup` first. Both are
  // accepted, and one shape is stored.
  const input = parsed.data;
  const incoming = {
    ...input,
    address: (input.address ?? input.addressLine)!,
    type: input.type ?? input.usedFor ?? 'both',
    ...(input.phoneCode ?? input.contactPhoneCountry
      ? { phoneCode: (input.phoneCode ?? input.contactPhoneCountry)! }
      : {}),
    ...(input.isDefault ?? input.defaultPickup
      ? { isDefault: (input.isDefault ?? input.defaultPickup)! }
      : {}),
  };

  try {
    const saved = await saveAddress(customer.customer.code, incoming, portalActor(auth.caller));
    return NextResponse.json({ success: true, data: saved }, { status: input.id ? 200 : 201 });
  } catch (cause) {
    return badRequest(cause instanceof Error ? cause.message : 'Could not save that address.');
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return badRequest('id is required.');

  const { code } = await params;
  const customer = await customerOr404(code);
  if ('response' in customer) return customer.response;

  try {
    await deleteAddress(customer.customer.code, id, portalActor(auth.caller));
    return NextResponse.json({ success: true });
  } catch (cause) {
    return badRequest(cause instanceof Error ? cause.message : 'Could not delete that address.');
  }
}
