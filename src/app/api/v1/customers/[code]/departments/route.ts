import { NextResponse } from 'next/server';
import { DepartmentUpsert } from '../../../../../../api/contracts';
import { authenticatedJson, authenticatedRequest, badRequest } from '../../../../_auth';
import { saveDepartment, deleteDepartment } from '../../../../../../data/enterprise';
import { portalActor, customerOr404 } from '../../../../../../customers/portal-actor';

/**
 * Departments within a plant.
 *
 * A department with no plant is refused here, not only on the screen. The portal already
 * says "Create a plant first before adding departments", but a screen that guards a rule
 * is not the rule — an import or a direct call would walk straight past it.
 */
/**
 * The customer's departments, optionally narrowed to one plant.
 *
 * `?plantCode=` matches the `departments/by-plant/{id}` call their portal already makes.
 * A filter rather than a second route, because it is the same list with a `where` on it —
 * and a route per filter is how an API grows a shape nobody can hold in their head.
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const { code } = await params;
  const customer = await customerOr404(code, auth.caller);
  if ('response' in customer) return customer.response;

  const { accountOf } = await import('../../../../../../data/enterprise');
  const plantCode = new URL(request.url).searchParams.get('plantCode');
  const departments = accountOf(customer.customer).departments;

  return NextResponse.json({
    success: true,
    data: plantCode
      ? departments.filter((department) => department.plantCode === plantCode)
      : departments,
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedJson(request);
  if (!auth.ok) return auth.response;

  const parsed = DepartmentUpsert.safeParse(auth.body);
  if (!parsed.success) return badRequest('Invalid department.', parsed.error.flatten());

  const { code } = await params;
  const customer = await customerOr404(code, auth.caller);
  if ('response' in customer) return customer.response;

  try {
    const { isActive, active, ...rest } = parsed.data;
    const saved = await saveDepartment(
      customer.customer.code,
      // Absent means active, so a caller that predates the field creates a working
      // department rather than a withdrawn one.
      { ...rest, active: isActive ?? active ?? true },
      portalActor(auth.caller),
    );
    return NextResponse.json({ success: true, data: saved }, { status: parsed.data.id ? 200 : 201 });
  } catch (cause) {
    return badRequest(cause instanceof Error ? cause.message : 'Could not save that department.');
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const auth = await authenticatedRequest(request);
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return badRequest('id is required.');

  const { code } = await params;
  const customer = await customerOr404(code, auth.caller);
  if ('response' in customer) return customer.response;

  try {
    await deleteDepartment(customer.customer.code, id, portalActor(auth.caller));
    return NextResponse.json({ success: true });
  } catch (cause) {
    return badRequest(cause instanceof Error ? cause.message : 'Could not delete that department.');
  }
}
