/**
 * Carrying a refusal's reason across the Server Action boundary.
 *
 * Next.js strips the message from any error thrown out of a Server Action in a production
 * build, replacing it with "An error occurred in the Server Components render. The specific
 * message is omitted…". That is right for an unexpected crash, whose message could leak
 * internals — and wrong for the refusals this codebase is full of, which were written
 * precisely so a person would know what to do:
 *
 *   "surface is one of the four networks this service prices."
 *   "This contract is awaiting approval and cannot be edited."
 *   "An offer called “Diwali” already exists."
 *
 * Thrown, every one of those reaches the user as boilerplate, and the useful sentence is
 * left in a server log nobody reading the screen can see.
 *
 * So an action returns its refusal instead of throwing it. `attempt` does that wrapping in
 * one place rather than thirty-six.
 */

/**
 * Next's own control flow, which travels as a thrown error.
 *
 * `redirect()` and `notFound()` both work this way, so any wrapper that catches broadly has
 * to let them past. Recognised by digest rather than by class, because the classes are
 * internal and the digest is the documented contract.
 */
function isControlFlow(cause: unknown): boolean {
  const digest = (cause as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND');
}

export interface Failed {
  error: string;
}

export type Outcome<T> = ({ ok: true } & T) | Failed;

/**
 * Run the work, and turn a refusal into something the screen can show.
 *
 * The message is taken from the Error the data layer raised, because that is where the
 * reason is known. Anything that is not an Error — a string thrown from somewhere odd, or a
 * value with no message at all — falls back to `fallback`, which should say what was being
 * attempted rather than "something went wrong".
 */
export async function attempt<T extends object>(
  fallback: string,
  work: () => Promise<T>,
): Promise<Outcome<T>> {
  try {
    return { ok: true, ...(await work()) };
  } catch (cause) {
    // `redirect()` and `notFound()` are implemented by throwing. Catching them here would
    // turn a navigation into an error toast and leave the user on the page they had just
    // finished with — so they are passed straight through.
    if (isControlFlow(cause)) throw cause;

    // Logged as well as returned: the screen gets the sentence, the log keeps the stack.
    console.error(`${fallback}:`, cause);
    const message = cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback;
    return { error: message };
  }
}

/**
 * Read the reason out of whatever an action returned or threw.
 *
 * Actions here report failure three ways — a thrown Error, a returned `{ error }`, or a bare
 * string — because they were written at different times. Rather than make every caller
 * remember which, this takes any of them.
 */
export function reasonFrom(cause: unknown): string {
  if (typeof cause === 'string' && cause.trim() !== '') return cause;
  if (cause instanceof Error && cause.message) return cause.message;
  if (cause && typeof cause === 'object') {
    const maybe = (cause as { error?: unknown; message?: unknown });
    if (typeof maybe.error === 'string' && maybe.error.trim() !== '') return maybe.error;
    if (typeof maybe.message === 'string' && maybe.message.trim() !== '') return maybe.message;
  }
  return 'No reason was given, which is usually a bug rather than a silent success.';
}
