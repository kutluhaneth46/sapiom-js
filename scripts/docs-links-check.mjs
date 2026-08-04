import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Public pages in the approved Docs.sapiom.ai information architecture.
 * Product source may link only to these canonical routes; redirects are for
 * old released binaries and bookmarks, not permission to emit stale links.
 */
export const CANONICAL_DOC_ROUTES = new Set([
  "/",
  "/agent-studio/account-and-privacy",
  "/agent-studio/canvas-steps-and-code",
  "/agent-studio/install",
  "/agent-studio/overview",
  "/agent-studio/sessions",
  "/agent-studio/workspaces-and-projects",
  "/agents/authoring",
  "/agents/quick-start",
  "/capabilities",
  "/capabilities/ai-models",
  "/capabilities/audio",
  "/capabilities/browser",
  "/capabilities/compute",
  "/capabilities/data",
  "/capabilities/domains",
  "/capabilities/email-enrichment",
  "/capabilities/file-storage",
  "/capabilities/github-export",
  "/capabilities/images",
  "/capabilities/messaging",
  "/capabilities/repositories",
  "/capabilities/scraping",
  "/capabilities/search",
  "/capabilities/verify",
  "/concepts/agents-and-agent-projects",
  "/concepts/local-and-cloud",
  "/concepts/studio-mcp-sdk-and-dashboard",
  "/concepts/workspaces-and-sessions",
  "/guides/build",
  "/guides/configure-authentication-and-runtime-inputs",
  "/guides/connect-claude-code-with-mcp",
  "/guides/create-from-a-template",
  "/guides/deploy",
  "/guides/inspect",
  "/guides/run-in-production",
  "/guides/schedule",
  "/guides/test-locally",
  "/guides/use-signals",
  "/integration/mcp-servers/remote",
  "/integration/sdk",
  "/privacy-policy",
  "/reference/agent-studio",
  "/reference/credentials-and-configuration",
  "/terms-of-use",
  "/troubleshooting/agent-studio",
  "/troubleshooting/build-deploy-run",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);

const REQUIRED_EMITTED_LINKS = [
  "https://docs.sapiom.ai/agent-studio/account-and-privacy",
  "https://docs.sapiom.ai/agent-studio/install",
  "https://docs.sapiom.ai/agent-studio/overview",
  "https://docs.sapiom.ai/agents/authoring",
  "https://docs.sapiom.ai/agents/quick-start",
  "https://docs.sapiom.ai/guides/connect-claude-code-with-mcp",
  "https://docs.sapiom.ai/reference/agent-studio",
];

function walk(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) return [];
    return walk(join(path, entry.name));
  });
}

export function extractDocsLinks(content) {
  return [
    ...content.matchAll(/https:\/\/docs\.sapiom\.ai(?:\/[^\s<>"'`)\]]*)?/g),
  ].map((match) => match[0].replace(/[.,;:]+$/, ""));
}

export function validateDocsLinkContent(filePath, content) {
  const errors = [];
  for (const rawLink of extractDocsLinks(content)) {
    const url = new URL(rawLink);
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    if (CANONICAL_DOC_ROUTES.has(pathname)) continue;
    const offset = content.indexOf(rawLink);
    const line = content.slice(0, offset).split("\n").length;
    errors.push(
      `${filePath}:${line} emits noncanonical docs route ${pathname}`,
    );
  }
  return errors;
}

export function validateRepository(root = REPOSITORY_ROOT) {
  const candidates = [
    join(root, "README.md"),
    join(root, "packages"),
    join(root, "plugins"),
  ]
    .flatMap((path) => walk(path))
    .filter((path) => TEXT_EXTENSIONS.has(extname(path)))
    .filter((path) => !path.endsWith("CHANGELOG.md"));

  const files = candidates.map((path) => ({
    path,
    relativePath: relative(root, path),
    content: readFileSync(path, "utf8"),
  }));
  const errors = files.flatMap(({ relativePath, content }) =>
    validateDocsLinkContent(relativePath, content),
  );
  if (errors.length) throw new Error(errors.join("\n"));

  const corpus = files.map(({ content }) => content).join("\n");
  for (const link of REQUIRED_EMITTED_LINKS) {
    if (!corpus.includes(link)) {
      throw new Error(`Required canonical product link is missing: ${link}`);
    }
  }

  return { files: files.length, links: extractDocsLinks(corpus).length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = validateRepository();
  console.log(
    `Verified ${result.links} Docs.sapiom.ai links across ${result.files} product files.`,
  );
}
