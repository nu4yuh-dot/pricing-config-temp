import { NextResponse } from 'next/server';
import { db } from '../../../data/mongo';

/**
 * Health check for the load balancer.
 *
 * Deliberately unauthenticated — an ALB target-group check cannot present a session
 * cookie or an API key. It leaks nothing beyond "the service is up and can reach
 * its database", and it does verify the database, because a task that cannot reach
 * Mongo can serve a login page but cannot serve a quote.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const database = await db();
    await database.command({ ping: 1 });
    return NextResponse.json({ status: 'ok', database: 'reachable' });
  } catch {
    return NextResponse.json(
      { status: 'degraded', database: 'unreachable' },
      { status: 503 },
    );
  }
}
