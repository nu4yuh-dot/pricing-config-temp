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

/**
 * Which code is answering.
 *
 * Added because the service could not say. Deploying uploads a directory rather than
 * triggering from a commit, so Railway has no `RAILWAY_GIT_COMMIT_SHA` to report, and there
 * was no way to tell whether production was running the commit somebody had just pushed —
 * a health check that says `ok` says nothing at all about *which* build is ok.
 *
 * `BUILD_COMMIT` is set by `npm run deploy` immediately before the upload, so it cannot
 * describe a different build than the one it ships with. Unset — a local run, or a deploy
 * somebody did by hand — reports `unknown` rather than a stale value, because a wrong commit
 * is worse than an absent one.
 *
 * Safe to expose: a commit hash identifies a build, and the repository is not public.
 */
function build() {
  return {
    commit: process.env.BUILD_COMMIT ?? 'unknown',
    id: LOADED_BUILD_ID,
    startedAt: STARTED_AT,
  };
}

/**
 * The build this process loaded, captured once at module scope.
 *
 * Read here rather than per request, and that distinction is the whole point. A running
 * server keeps its compiled handlers in memory across a rebuild, but anything it reads from
 * disk at request time comes back *new* — so the build id in a served page reflects the
 * files on disk, not the code answering. Captured at load, this is the code answering.
 *
 * Set by `scripts/standalone.mjs`; absent in the container, where `commit` is the answer
 * instead. `unknown` rather than a guess.
 */
const LOADED_BUILD_ID = process.env.NEXT_BUILD_ID ?? 'unknown';

/**
 * When this process began serving.
 *
 * Module scope, so it is the process's own start rather than the time of the request. A
 * server still running from before a deploy reports an older time than the deploy — which is
 * exactly the stale-build case, visible without having to guess.
 */
const STARTED_AT = new Date().toISOString();

export async function GET() {
  try {
    const database = await db();
    await database.command({ ping: 1 });
    return NextResponse.json({ status: 'ok', database: 'reachable', build: build() });
  } catch {
    return NextResponse.json(
      { status: 'degraded', database: 'unreachable', build: build() },
      { status: 503 },
    );
  }
}
