---
"@sapiom/harness": minor
---

Studio: creating an agent in a project is now a form that creates it, not a
message asking your coding agent to.

Every create door ended the same way — a session started and an English
sentence was typed into the terminal asking the coding agent to please call a
scaffold tool. Studio never created anything, so a failure arrived as a
confused model rather than an error, and "did it work?" could only be answered
by reading a terminal. On a project that already held agents it simply could
not work: the scaffold was aimed at the project folder, which is not empty, and
the reply was a paragraph asking you which subdirectory you meant.

- **Create an agent in {project}** opens a small dialog: a name, a starter, and
  the project it lands in — stated, not asked again, because you clicked that
  row. Submit and Studio creates the agent itself.
- **Creation completes before the chat starts.** The agent is on disk and in
  your rail before a session opens on it, and the rail scrolls it into view. A
  first instruction is optional, and the session opens on that instead of on a
  request to scaffold.
- **A refusal is a sentence in the dialog.** A name already taken in that
  project, a name that is not a folder name, a folder Studio does not show as a
  project — each is refused with a reason you can act on, and nothing
  half-created is left behind if the scaffold itself fails.
- **The bundled starters in the template gallery take the same path**, so the
  two ways of starting from a starter cannot drift. Cloning a published
  template still goes through your coding agent, which is a different operation
  with a different failure mode.
- The empty-project row's **Create the first agent here** now responds to a
  click; it had been unclickable.
- Starting from an idea on the home screen is unchanged: no project, no name,
  and a folder that does not exist yet, so it stays a conversation.

New endpoint `POST /api/agents/scaffold` — `{ root, name, template? }` → the
created agent's path. It runs the same scaffold the CLI does and refuses on its
own findings rather than on the caller's word.
