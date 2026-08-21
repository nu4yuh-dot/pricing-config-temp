import { NextResponse } from 'next/server';

/**
 * Whether the published contract is readable from this deployment.
 *
 * The core's reference is "off in production unless explicitly switched on", and the same
 * reasoning applies here with more force: every route in this service prices freight, so
 * the route list is a target list. Open outside production, and in production only when
 * somebody deliberately sets the flag.
 */
export function docsAreOpen(): boolean {
  if (process.env.API_DOCS === 'on') return true;
  if (process.env.API_DOCS === 'off') return false;
  return process.env.NODE_ENV !== 'production';
}

export function docsClosed(): NextResponse {
  return NextResponse.json(
    {
      error: 'not-available',
      message:
        'The API reference is not published from this deployment. Set API_DOCS=on to enable it.',
    },
    { status: 404 },
  );
}
