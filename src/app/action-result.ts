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
    // Logged as well as returned: the screen gets the sentence, the log keeps the stack.
    console.error(`${fallback}:`, cause);
    const message = cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback;
    return { error: message };
  }
}
