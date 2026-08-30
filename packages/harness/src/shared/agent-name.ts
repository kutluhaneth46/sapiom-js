/**
 * What a new agent may be called — ONE rule, shared by the dialog and the
 * route (SAP-2981).
 *
 * The dialog validates as you type so the refusal arrives before the click, and
 * `POST /api/agents/scaffold` refuses again on its own findings because a
 * disabled button is not a permission system. Those are two guards, and two
 * guards written twice become two different rules: a name the field accepts and
 * the server rejects reads as a broken app, and a name the server would accept
 * but the field greys out reads as an arbitrary one. So the rule lives here and
 * both sides import it.
 *
 * It is deliberately a folder-name rule, not a naming-convention one. The agent
 * gets a directory inside the project, and everything refused below is refused
 * because of what it would do to that directory — not because of house style.
 */

/**
 * Characters that cannot appear in a directory name on every platform the
 * Studio runs on, plus the C0 controls. A NUL in particular reaches `fs` as a
 * thrown `ERR_INVALID_ARG_VALUE` rather than a refusal, so it is answered here
 * where the caller gets a sentence instead of a 500.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_NAME = /[\u0000-\u001f<>:"|?*]/;

/** Longest agent folder name accepted — a bound, not a style rule. */
const MAX_NAME_LENGTH = 64;

/**
 * Why this name cannot be a new agent's folder, or null when it can.
 *
 * The message is shown verbatim, so each sentence says what to do rather than
 * what a regex thinks. The leading-dot refusal is the one that is not about
 * path escape: a dotted directory is skipped by the agent scan, so `.notes`
 * would scaffold successfully and then never appear in the rail — the exact
 * "did it work?" failure the create endpoint exists to end.
 */
export function refuseAgentName(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "")
    return "Give the agent a name.";
  if (name.trim() !== name)
    return "An agent name can't start or end with a space.";
  if (name.length > MAX_NAME_LENGTH)
    return `That name is too long — keep it under ${MAX_NAME_LENGTH} characters.`;
  if (/[/\\]/.test(name))
    return "An agent name is one folder name — it can't contain / or \\.";
  if (name.startsWith("."))
    return "An agent name can't start with a dot — a dotted folder is hidden from the rail.";
  // A TRAILING dot is not the same mistake, and it is worse: Windows silently
  // strips it, so `mkdir foo.` makes `foo` and the created directory no longer
  // matches the name the caller was told it got — the SPA then focuses and
  // binds a path that does not exist.
  if (name.endsWith("."))
    return "An agent name can't end with a dot.";
  if (FORBIDDEN_IN_NAME.test(name)) return `'${name}' isn't a folder name.`;
  return null;
}
