import {
  defineAgent,
  defineStep,
  goto,
  pauseUntilSignal,
  terminate,
  type AgentExecutionContext,
} from "@sapiom/agent";
import { CODING_RESULT_SIGNAL, type CodingResultPayload } from "@sapiom/tools";
import { z } from "zod/v4";

/**
 * autonomous-pr — point it at a repo; a coding agent picks up a task, writes
 * the code, runs your checks, and pushes a branch carrying its own self-review.
 *
 * Fuses `dependency-upgrade` (coding agent → sandbox re-attach → real checks →
 * gate the push on green) with `pr-review-bot` (a second model reading a diff
 * to write a structured review) into one end-to-end "do the work" agent rather
 * than a narrow bump or a read-only review.
 *
 *   plan ─▶ implement ──(pause: models.coding.result → verify)──▶ verify ─┬─▶ push ─▶ review ─▶ summary
 *                                                                          └─▶ rejected
 *
 *   - plan       resolves the repo. Given `repoSlug`, it must already exist —
 *                a repository is a RESOURCE. Given none, it self-provisions a
 *                small scratch repo so a zero-input run still has something
 *                real to work in (never a plausible-looking name; an actually
 *                created one).
 *   - implement  launches a coding agent (`models.coding`) on the repo, then
 *                SUSPENDS at $0 until it finishes — coding runs are long. On
 *                the scratch repo it first seeds a tiny `AUTHORING.md` and two
 *                minimal examples (the repo is empty, so this is the same
 *                agent turn as the task itself, not a second billed run), then
 *                does the task: add one more example that follows it. The
 *                agent only edits files — it is never asked to run git.
 *   - verify     re-attaches that sandbox and runs the repo's own install +
 *                check commands over the agent's (still uncommitted) changes.
 *                A failed coding run or a red check routes to `rejected`;
 *                nothing is branched or pushed.
 *   - push       creates a fresh branch and pushes the agent's changes to it
 *                (`repositories.pushFromSandbox`, which commits whatever is
 *                pending and pushes) — the platform's git host has no hosted
 *                pull-request object yet, so the pushed branch is what you
 *                review.
 *   - review     a second model (`models.run`) reads the diff and the coding
 *                agent's own notes and writes a short self-review: a verdict,
 *                a summary, and what it would flag.
 *   - summary    returns everything: the repo, the branch, the sha, and the
 *                self-review.
 *   - rejected   no repo, a failed coding run, or a red check — archived only
 *                in the run's own output; nothing is branched or pushed.
 *
 * The push is the one irreversible step, so it only happens after `verify`'s
 * checks are green — same gate `dependency-upgrade` uses for its push.
 */

const DEFAULT_TASK =
  "Read this repo's AUTHORING.md (or nearest CONTRIBUTING/README) and add ONE " +
  "new example directory that follows its conventions exactly — its own " +
  "runnable code plus its manifest. Keep the change small, self-contained, " +
  "and covered by the repo's own checks.";

// ──────────────────────────────────────────────── seed (scratch repo only) ──
// The scratch repo self-provisioned on a zero-input run starts out empty, so
// "add a new example following this repo's conventions" is meaningless until
// something establishes those conventions. These constants are handed to the
// SAME coding-agent run as exact file content to write before the real task —
// a tiny, self-contained slice of a real examples repo, not a copy of this
// one. Never applied to a `repoSlug` the caller supplied — a real repo's
// conventions are whatever it already has.
const SEED_AUTHORING_MD = `# Authoring an example

Each example is one directory under \`examples/\`, named for its id (kebab-case). It holds:

- \`index.ts\` — exports \`export const agent = defineAgent({ name, entry, steps })\`, built from \`defineStep\` from \`"@sapiom/agent"\`. Every step declares its \`next\` / \`terminal\` transitions.
- \`template.json\` — \`{ "manifestVersion": 1, "whatItDoes": "...", "useCases": ["...", "...", "..."] }\`.
- \`package.json\` / \`tsconfig.json\` — copy an existing example's, keeping its \`typecheck\` script.

A new example must run \`npm run typecheck\` clean and follow this shape exactly — no other file layout is accepted.
`;

const SEED_HELLO_AGENT_INDEX = `import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const greet = defineStep({
  name: "greet",
  next: [],
  terminal: true,
  async run(input: { name?: string }) {
    return terminate({ message: \`Hello, \${input?.name?.trim() || "world"}!\` });
  },
});

export const agent = defineAgent({ name: "hello-agent", entry: "greet", steps: { greet } });
`;

const SEED_HELLO_AGENT_TEMPLATE = `{
  "manifestVersion": 1,
  "whatItDoes": "Greet whoever runs it.",
  "useCases": ["Smoke test", "Onboarding demo", "Sanity check"]
}
`;

const SEED_ECHO_INDEX = `import { defineAgent, defineStep, terminate } from "@sapiom/agent";

const echo = defineStep({
  name: "echo",
  next: [],
  terminal: true,
  async run(input: { text?: string }) {
    return terminate({ text: input?.text ?? "" });
  },
});

export const agent = defineAgent({ name: "echo", entry: "echo", steps: { echo } });
`;

const SEED_ECHO_TEMPLATE = `{
  "manifestVersion": 1,
  "whatItDoes": "Echo the given text back unchanged.",
  "useCases": ["Wiring check", "Round-trip test", "Debug probe"]
}
`;

const SEED_ROOT_PACKAGE_JSON = `{
  "name": "examples-repo",
  "private": true,
  "type": "module",
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "@sapiom/agent": "^0.9.0", "@sapiom/tools": "^0.25.0", "zod": "^4.0.0" },
  "devDependencies": { "typescript": "^5.4.2", "@types/node": "^20.11.30" }
}
`;

const SEED_TSCONFIG = `{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2022",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["**/*.ts"]
}
`;

/** Exact-content scaffold instructions, prepended to the real task on a scratch repo only. */
const SEED_PREAMBLE =
  "This repository is brand new and empty. Before anything else, create exactly " +
  "these files with exactly this content (character for character), so it looks " +
  "like a small, real slice of an examples repo:\n\n" +
  `--- AUTHORING.md ---\n${SEED_AUTHORING_MD}\n` +
  `--- examples/hello-agent/index.ts ---\n${SEED_HELLO_AGENT_INDEX}\n` +
  `--- examples/hello-agent/template.json ---\n${SEED_HELLO_AGENT_TEMPLATE}\n` +
  `--- examples/echo/index.ts ---\n${SEED_ECHO_INDEX}\n` +
  `--- examples/echo/template.json ---\n${SEED_ECHO_TEMPLATE}\n` +
  `--- package.json ---\n${SEED_ROOT_PACKAGE_JSON}\n` +
  `--- tsconfig.json ---\n${SEED_TSCONFIG}\n\n` +
  "Once those files exist exactly as given, do the task below.\n\n";

// ──────────────────────────────────────────────────────────────── input ──
interface AutonomousPrInput {
  /** In-network repo the coding agent works in. Absent ⇒ self-provisions a scratch repo. */
  repoSlug?: string;
  /** Plain-words task for the coding agent (default: add an example following AUTHORING.md). */
  task?: string;
  /** Command that installs dependencies in the checkout (default `npm install`). */
  installCommand?: string;
  /** Command that must pass before anything is pushed (default `npm run typecheck`). */
  checkCommand?: string;
}

type Mode = "byo" | "self-provisioned";

interface Review {
  verdict: "approve" | "comment" | "request_changes";
  summary: string;
  notes: string[];
}

/** Run-scoped state; the values before the pause survive the suspend. */
interface Shared extends Record<string, unknown> {
  mode: Mode;
  repoSlug: string;
  cloneUrl: string;
  task: string;
  installCommand: string;
  checkCommand: string;
  branchName: string;
  sandboxName: string | null;
  codingSummary: string | null;
  diffStat: string | null;
  checkTail: string | null;
  pushed: boolean;
  pushSha: string | null;
  pushBranch: string | null;
  review: Review | null;
}

type Ctx = AgentExecutionContext<Shared>;

// ──────────────────────────────────────────────────────────────── steps ──

/**
 * The entry contract — this agent's public API, and what the dashboard "Run
 * once" form renders its labelled fields from. `repoSlug` has no default on
 * purpose — a repository must exist, so an empty value means "provision one",
 * not "guess a plausible one".
 */
const entryInput = z.object({
  repoSlug: z
    .string()
    .optional()
    .describe(
      "In-network repo the coding agent works in. Absent ⇒ self-provisions a scratch repo.",
    ),
  task: z
    .string()
    .default(DEFAULT_TASK)
    .describe("Plain-words task for the coding agent."),
  installCommand: z
    .string()
    .default("npm install")
    .describe("Command that installs dependencies in the checkout."),
  checkCommand: z
    .string()
    .default("npm run typecheck")
    .describe("Command that must pass before anything is pushed."),
});

const plan = defineStep({
  name: "plan",
  inputSchema: entryInput,
  next: ["implement", "rejected"],
  async run(input: AutonomousPrInput, ctx: Ctx) {
    const task = input?.task?.trim() || DEFAULT_TASK;
    const installCommand = input?.installCommand?.trim() || "npm install";
    const checkCommand = input?.checkCommand?.trim() || "npm run typecheck";
    ctx.shared.set("task", task);
    ctx.shared.set("installCommand", installCommand);
    ctx.shared.set("checkCommand", checkCommand);
    ctx.shared.set("branchName", `autonomous-pr/${slugify(ctx.executionId)}`);
    ctx.shared.set("sandboxName", null);
    ctx.shared.set("codingSummary", null);
    ctx.shared.set("diffStat", null);
    ctx.shared.set("checkTail", null);
    ctx.shared.set("pushed", false);
    ctx.shared.set("pushSha", null);
    ctx.shared.set("pushBranch", null);
    ctx.shared.set("review", null);

    const requestedSlug = (input?.repoSlug ?? "").trim();

    if (requestedSlug) {
      // A repository is a RESOURCE: it has to exist. There is deliberately no
      // default slug — naming a plausible one (`my-app`) turns a clean
      // rejection into a 404 mid-run.
      try {
        const repo = await ctx.sapiom.repositories.get(requestedSlug);
        ctx.shared.set("mode", "byo");
        ctx.shared.set("repoSlug", repo.slug);
        ctx.shared.set("cloneUrl", repo.cloneUrl);
        ctx.logger.info("planning autonomous PR against an existing repo", {
          repoSlug: repo.slug,
        });
        return goto("implement", {});
      } catch (err) {
        return goto("rejected", {
          reason: "repo-not-found",
          detail:
            `No in-network repository named \`${requestedSlug}\` was found, ` +
            `so nothing was cloned or changed (${String(err)}).`,
          unmet: ["repoSlug"],
        });
      }
    }

    // No repo named: self-provision a small scratch repo so a zero-input run
    // still has something real to work in.
    const demoSlug = `autonomous-pr-demo-${slugify(ctx.executionId)}`;
    try {
      const repo = await ctx.sapiom.repositories.create(demoSlug);
      ctx.shared.set("mode", "self-provisioned");
      ctx.shared.set("repoSlug", repo.slug);
      ctx.shared.set("cloneUrl", repo.cloneUrl);
      ctx.logger.info("provisioned a scratch demo repo", {
        repoSlug: repo.slug,
      });
      return goto("implement", {});
    } catch (err) {
      return goto("rejected", {
        reason: "provision-failed",
        detail:
          "Could not provision a scratch demo repository, so there was " +
          `nothing to work in (${String(err)}).`,
      });
    }
  },
});

/**
 * Launch the coding agent on the repo and suspend until it finishes. It only
 * edits files — never asked to run git — so the branch and the push stay in
 * `verify` / `push`, exact and repeatable rather than depending on the agent.
 */
const implement = defineStep({
  name: "implement",
  next: [],
  pause: { signal: CODING_RESULT_SIGNAL, resumeStep: "verify" },
  async run(_input: unknown, ctx: Ctx) {
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const mode = ctx.shared.get("mode") ?? "byo";
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;
    const repo = await ctx.sapiom.repositories.get(repoSlug);

    const fullTask =
      (mode === "self-provisioned" ? SEED_PREAMBLE : "") + `Task: ${task}`;

    ctx.logger.info("launching coding agent", { repoSlug, mode });
    const handle = await ctx.sapiom.models.coding.launch({
      task: fullTask,
      gitRepository: repo,
    });
    return await pauseUntilSignal(handle, { resumeStep: "verify" });
  },
});

/**
 * Re-attach the coding run's sandbox and run the repo's own install + check
 * commands over the agent's (still uncommitted) changes. Only a green check
 * reaches `push`.
 */
const verify = defineStep({
  name: "verify",
  next: ["push", "rejected"],
  timeoutMs: 900_000,
  async run(result: CodingResultPayload, ctx: Ctx) {
    const codingSummary = result?.summary ?? null;
    ctx.shared.set("codingSummary", codingSummary);

    // The coding agent itself failed — there's nothing to check.
    if (result?.status === "failed" || result?.error) {
      return goto("rejected", {
        reason: "coding-run-failed",
        detail: result?.error?.message ?? codingSummary ?? "coding run failed",
      });
    }

    const sandboxName = result?.executionEnvironment?.id ?? null;
    ctx.shared.set("sandboxName", sandboxName);
    if (!sandboxName) {
      return goto("rejected", {
        reason: "no-sandbox",
        detail: "the coding run provisioned no sandbox to check in",
      });
    }

    const installCommand = ctx.shared.get("installCommand") ?? "npm install";
    const checkCommand = ctx.shared.get("checkCommand") ?? "npm run typecheck";
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    // `gitRepository` clones into the sandbox at `/workspace/<slug>` — every
    // exec here has to target that checkout, not the sandbox's bare root.
    const cwd = repoSlug;
    const box = ctx.sapiom.sandboxes.attach(sandboxName);

    // Capture what changed, for the self-review — uncommitted, so a plain
    // `diff --stat` (no ref range) is exactly the agent's working-tree edits.
    try {
      const diff = await box.exec("git --no-pager diff --stat", {
        cwd,
        timeout: 30_000,
      });
      ctx.shared.set(
        "diffStat",
        (diff.stdout || diff.stderr || "").slice(0, 4000),
      );
    } catch (err) {
      ctx.shared.set("diffStat", `diff unavailable: ${String(err)}`);
    }

    const install = await box.exec(installCommand, { cwd, timeout: 300_000 });
    if (install.exitCode !== 0) {
      ctx.shared.set("checkTail", tail(install.stdout, install.stderr));
      return goto("rejected", {
        reason: "install-failed",
        detail: `\`${installCommand}\` exited ${install.exitCode}`,
      });
    }

    const check = await box.exec(checkCommand, { cwd, timeout: 300_000 });
    ctx.shared.set("checkTail", tail(check.stdout, check.stderr));
    if (check.exitCode !== 0) {
      return goto("rejected", {
        reason: "check-failed",
        detail: `\`${checkCommand}\` exited ${check.exitCode}`,
      });
    }

    ctx.logger.info("check green", { checkCommand });
    return goto("push", {});
  },
});

/**
 * Create a fresh branch ourselves (the agent never ran git) and push the
 * agent's changes to it. `pushFromSandbox` commits whatever is pending and
 * pushes the currently checked-out branch — the reviewable unit, since this
 * git host has no hosted pull-request object yet.
 */
const push = defineStep({
  name: "push",
  next: ["review"],
  async run(_input: unknown, ctx: Ctx) {
    const sandboxName = ctx.shared.get("sandboxName") ?? "";
    const repoSlug = ctx.shared.get("repoSlug") ?? "";
    const branchName = ctx.shared.get("branchName") ?? "autonomous-pr/task";
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;
    const box = ctx.sapiom.sandboxes.attach(sandboxName);

    // `gitRepository` clones into the sandbox at `/workspace/<slug>` — the
    // checkout `pushFromSandbox` below pushes from by default.
    await box.exec(`git checkout -b ${branchName}`, {
      cwd: repoSlug,
      timeout: 30_000,
    });

    const repo = await ctx.sapiom.repositories.get(repoSlug);
    const message = truncate(`feat: ${task}`, 72);
    const result = await repo.pushFromSandbox(box, { message });

    ctx.shared.set("pushed", result.pushed);
    ctx.shared.set("pushSha", result.sha);
    ctx.shared.set("pushBranch", result.branch ?? branchName);
    ctx.logger.info("pushed branch", {
      branch: result.branch ?? branchName,
      sha: result.sha,
    });
    return goto("review", {});
  },
});

/**
 * A second model reads the diff and the coding agent's own notes and writes a
 * short self-review — a verdict, a summary, and what it would flag. Purely
 * informational: it never blocks the push, which already happened.
 */
const review = defineStep({
  name: "review",
  next: ["summary"],
  timeoutMs: 60_000,
  async run(_input: unknown, ctx: Ctx) {
    const diffStat = ctx.shared.get("diffStat") ?? "";
    const checkTail = ctx.shared.get("checkTail") ?? "";
    const codingSummary = ctx.shared.get("codingSummary") ?? "";
    const task = ctx.shared.get("task") ?? DEFAULT_TASK;

    const system =
      "You are reviewing your own pull request before a human sees it. The " +
      "checks already passed. Judge whether the change actually does the " +
      "stated task, is scoped tightly to it, and reads like something you'd " +
      'approve. Reply with ONLY minified JSON: {"verdict":"approve|comment|' +
      'request_changes","summary":string,"notes":string[]}.';
    const prompt =
      `Task:\n${task}\n\n` +
      `Coding agent's own summary:\n${codingSummary}\n\n` +
      `Diff (stat):\n${diffStat}\n\n` +
      `Check output (tail):\n${checkTail}`;

    const res = await ctx.sapiom.models.run({ prompt, system, maxTokens: 500 });
    const rev = parseReview(res.output);
    ctx.shared.set("review", rev);
    ctx.logger.info("self-review complete", { verdict: rev.verdict });
    return goto("summary", {});
  },
});

/** Green, pushed, and self-reviewed: return everything. */
const summary = defineStep({
  name: "summary",
  next: [],
  terminal: true,
  async run(_input: unknown, ctx: Ctx) {
    const mode = ctx.shared.get("mode") ?? "byo";
    return terminate({
      mode,
      repoSlug: ctx.shared.get("repoSlug") ?? "",
      cloneUrl: ctx.shared.get("cloneUrl") ?? "",
      branch:
        ctx.shared.get("pushBranch") ?? ctx.shared.get("branchName") ?? "",
      sha: ctx.shared.get("pushSha") ?? null,
      pushed: ctx.shared.get("pushed") === true,
      // No hosted pull-request object exists yet — never fabricate one.
      prUrl: null,
      task: ctx.shared.get("task") ?? DEFAULT_TASK,
      codingSummary: ctx.shared.get("codingSummary") ?? null,
      review: ctx.shared.get("review"),
      note:
        (mode === "self-provisioned"
          ? "Ran against a scratch demo repo Sapiom just provisioned for this " +
            "run — set `repoSlug` to your own in-network repo to work on " +
            "something real. "
          : "") +
        "This git host has no hosted pull-request object yet, so the pushed " +
        "branch above is what you review — there is no `prUrl` to open.",
    });
  },
});

/** No repo, a failed coding run, or a red check: nothing branched, nothing pushed. */
const rejected = defineStep({
  name: "rejected",
  next: [],
  terminal: true,
  async run(
    input: { reason: string; detail?: string; unmet?: string[] },
    ctx: Ctx,
  ) {
    const mode = ctx.shared.get("mode") ?? "byo";
    ctx.logger.info("autonomous PR rejected", { reason: input?.reason });
    return terminate({
      mode,
      repoSlug: ctx.shared.get("repoSlug") ?? "unknown",
      pushed: false,
      reason: input?.reason ?? "unknown",
      detail: input?.detail ?? null,
      checkTail: ctx.shared.get("checkTail") ?? null,
      ...(input?.unmet?.length
        ? { unmet: input.unmet, note: input.detail ?? null }
        : {}),
    });
  },
});

// ────────────────────────────────────────────────────────────── helpers ──

/** Lowercase, hyphenated, bounded — safe inside a repo slug or a branch name. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16) || "run"
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Last `max` chars of the combined stdout/stderr — enough to see a failure. */
function tail(stdout: string, stderr: string, max = 2000): string {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  return combined.length > max ? combined.slice(-max) : combined;
}

/** Extract the self-review from model output; fall back to a safe default. */
function parseReview(output: string | null): Review {
  const fallback: Review = {
    verdict: "comment",
    summary: "Self-review unavailable; see the coding agent's own summary.",
    notes: [],
  };
  if (!output) return fallback;
  try {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end < 0) return fallback;
    const raw = JSON.parse(output.slice(start, end + 1)) as Partial<Review>;
    const verdict =
      raw.verdict === "approve" ||
      raw.verdict === "comment" ||
      raw.verdict === "request_changes"
        ? raw.verdict
        : fallback.verdict;
    return {
      verdict,
      summary: typeof raw.summary === "string" ? raw.summary : fallback.summary,
      notes: Array.isArray(raw.notes)
        ? raw.notes.filter((n): n is string => typeof n === "string")
        : [],
    };
  } catch {
    return fallback;
  }
}

export const agent = defineAgent<AutonomousPrInput, Shared>({
  name: "autonomous-pr",
  entry: "plan",
  steps: { plan, implement, verify, push, review, summary, rejected },
});
