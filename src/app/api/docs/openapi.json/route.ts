import { NextResponse } from 'next/server';
import { openApiDocument } from '../../../../api/openapi';
import { docsAreOpen, docsClosed } from '../visibility';

/**
 * The machine-readable contract. Import it into Postman or Bruno, or generate a client.
 *
 * Off in production unless switched on, matching the core: "The API reference is off in
 * production unless explicitly switched on." A full route list is a map for anyone
 * probing, and this service's routes all carry commercial rates.
 */
export async function GET() {
  if (!docsAreOpen()) return docsClosed();
  return NextResponse.json(openApiDocument(), {
    headers: { 'cache-control': 'no-store' },
  });
}
