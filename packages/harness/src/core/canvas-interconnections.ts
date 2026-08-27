/**
 * Heuristic scan of a workflow project's TypeScript sources for two things the
 * canvas surfaces, in a single pass:
 *
 *  - direct cross-agent invocations — current `agents.run` / `agents.launch`
 *    calls and the supported legacy `orchestrations.launch` form, extracted
 *    with a syntax-only TypeScript walk; and
 *  - Sapiom capabilities — `ctx.sapiom.<ns>.<method>(...)` call sites, rendered
 *    as capability chips on the step (the thing Sapiom bills for).
 *
 * Each call is attributed to the step whose `defineStep({ ... })` block it
 * literally sits inside — a brace-balanced extent, not merely the nearest
 * preceding `name:`. A call in a shared helper (or anywhere outside a step
 * block) is left unattributed (`fromStepId: null`) rather than mis-billed to
 * the last step in the file — for a capability chip that would read as a false
 * claim about what a step calls.
 *
 * This deliberately does not create a Program or TypeChecker. Supported direct
 * calls are syntax-accurate (comments and strings cannot become relationships),
 * while dynamic targets are returned as explicit extraction warnings.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ts from "typescript";

import type { AgentInvocationMode } from "../shared/system-graph.js";

export type { AgentInvocationMode } from "../shared/system-graph.js";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".sapiom",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const MAX_FILES_PER_WORKFLOW = 200;
const MAX_FILE_BYTES = 512 * 1024;

// Matches `sapiom.<ns>.<method>(` chains — e.g. `ctx.sapiom.web.search(`,
// `sapiom.email.messages.send(`. Captures the dotted chain AFTER `sapiom.`
// (the capability id: "web.search", "email.messages.send"), tolerating
// whitespace around the dots. The negative lookbehind avoids matching an
// identifier that merely ends in "sapiom".
const CAPABILITY_CALL_PATTERN =
  /(?<![\w$])sapiom\s*\.\s*([a-z][\w$]*(?:\s*\.\s*[a-z][\w$]*)+)\s*\(/gi;

// Agent calls are relationships, not billable capability chips.
const NON_CAPABILITY_CALLS = new Set([
  "agents.run",
  "agents.launch",
  "orchestrations.launch",
]);

// A `name: "..."` property declaration — the step-name key `defineStep`
// blocks always open with. The lookbehind rejects longer identifiers ending
// in "name" (fromName, vendorName) without consuming the preceding char.
const STEP_NAME_PATTERN = /(?<![\w$.])name\s*:\s*(['"`])([^'"`]+)\1/g;

// A `defineStep(` call opener (not `myDefineStep(`). Its brace-balanced extent
// is what bounds a step's attribution below.
const DEFINE_STEP_PATTERN = /(?<![\w$.])defineStep\s*\(/g;

/**
 * Lists the workflow's own `.ts`/`.tsx` sources (skipping node_modules and
 * friends), bounded to MAX_FILES_PER_WORKFLOW. Shared with the extraction
 * cache's source fingerprint (core/canvas-cache.ts) so "the files this grep
 * reads" and "the files whose mtimes invalidate the cache" can't drift.
 */
export async function listSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_FILES_PER_WORKFLOW) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_WORKFLOW) return;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  await walk(root);
  return files;
}

// --- attribution: which step's defineStep(...) block a call sits in ---------

/** From the opening quote at `open`, the index of the matching close quote (or
 *  the last index). Escapes are honored; a template literal is treated as one
 *  opaque span (its balanced `${…}` parens never leak into the paren count). */
function skipString(content: string, open: number): number {
  const quote = content[open];
  for (let i = open + 1; i < content.length; i++) {
    if (content[i] === "\\") {
      i++;
      continue;
    }
    if (content[i] === quote) return i;
  }
  return content.length - 1;
}

/** From the `(` at `open`, the index of its matching `)` (or end of file),
 *  skipping string and comment content so parens inside them can't miscount. */
function matchingParen(content: string, open: number): number {
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const c = content[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(content, i);
      continue;
    }
    if (c === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i);
      if (nl === -1) return content.length;
      i = nl;
      continue;
    }
    if (c === "/" && content[i + 1] === "*") {
      const close = content.indexOf("*/", i + 2);
      i = close === -1 ? content.length : close + 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return content.length;
}

interface StepBlock {
  /** Index of the `(` opening the `defineStep(` call. */
  start: number;
  /** Index of the matching `)`. */
  end: number;
  /** The known step this block declares (its first known `name:`). */
  stepId: string;
}

/** The brace-balanced extent of each `defineStep(...)` call whose declared
 *  `name` is a known step — so a call can be attributed to the step it sits in,
 *  not the nearest preceding `name:` (which mis-binds trailing helpers). */
function stepBlockRanges(
  content: string,
  knownStepIds: ReadonlySet<string>,
): StepBlock[] {
  const blocks: StepBlock[] = [];
  for (const match of content.matchAll(DEFINE_STEP_PATTERN)) {
    const open = match.index + match[0].length - 1; // the `(` of defineStep(
    const end = matchingParen(content, open);
    let stepId: string | null = null;
    for (const nameMatch of content
      .slice(open, end)
      .matchAll(STEP_NAME_PATTERN)) {
      if (knownStepIds.has(nameMatch[2]!)) {
        stepId = nameMatch[2]!;
        break;
      }
    }
    if (stepId) blocks.push({ start: open, end, stepId });
  }
  return blocks;
}

/** The step whose block contains `index`, or null (top-level / shared helper). */
function attributeTo(
  blocks: readonly StepBlock[],
  index: number,
): string | null {
  for (const block of blocks) {
    if (index > block.start && index < block.end) return block.stepId;
  }
  return null;
}

export interface DetectedLaunch {
  /** The `definition` slug the launch call referenced. */
  slug: string;
  /** The step (by declared name) the call was attributed to — the step whose
   *  `defineStep` block it sits in — or null when it sits outside any step
   *  (e.g. a launch in a shared helper). */
  fromStepId: string | null;
}

/** Internal source evidence. It never crosses the system-graph HTTP boundary. */
export interface SourceEvidence {
  /** POSIX path relative to the caller's source root. */
  file: string;
  /** One-based source location of the supported call expression. */
  line: number;
  column: number;
}

export interface DetectedAgentInvocation {
  /** The direct literal `definition` target. */
  slug: string;
  mode: AgentInvocationMode;
  fromStepId: string | null;
  evidence: SourceEvidence;
}

export interface AgentInvocationDetectionWarning {
  code: "dynamic-target";
  mode: AgentInvocationMode;
  evidence: SourceEvidence;
}

export interface AgentInvocationScanResult {
  invocations: DetectedAgentInvocation[];
  warnings: AgentInvocationDetectionWarning[];
}

export interface DetectedCapability {
  /** The dotted capability id (e.g. "web.search", "email.messages.send"). */
  capability: string;
  /** The step the call was attributed to, or null (a shared helper). */
  fromStepId: string | null;
}

export interface WorkflowSourceScan {
  launches: DetectedLaunch[];
  invocations: DetectedAgentInvocation[];
  invocationWarnings: AgentInvocationDetectionWarning[];
  capabilities: DetectedCapability[];
}

interface SupportedNamespaces {
  current: ReadonlySet<string>;
  legacy: ReadonlySet<string>;
}

function collectSupportedNamespaces(
  sourceFile: ts.SourceFile,
): SupportedNamespaces {
  const current = new Set<string>();
  const legacy = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@sapiom/tools"
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (
      !clause ||
      clause.isTypeOnly ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    ) {
      continue;
    }
    for (const specifier of clause.namedBindings.elements) {
      if (specifier.isTypeOnly) continue;
      const imported = specifier.propertyName?.text ?? specifier.name.text;
      if (imported === "agents") current.add(specifier.name.text);
      if (imported === "orchestrations") legacy.add(specifier.name.text);
    }
  }

  return { current, legacy };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function propertyAccessChain(expression: ts.Expression): string[] | null {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return [current.text];
  if (!ts.isPropertyAccessExpression(current) || current.questionDotToken) {
    return null;
  }
  const parent = propertyAccessChain(current.expression);
  return parent ? [...parent, current.name.text] : null;
}

function bindingContainsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) =>
      !ts.isOmittedExpression(element) &&
      bindingContainsName(element.name, name),
  );
}

function declarationListContainsName(
  declarationList: ts.VariableDeclarationList,
  name: string,
): boolean {
  return declarationList.declarations.some((declaration) =>
    bindingContainsName(declaration.name, name),
  );
}

function statementDeclaresName(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return declarationListContainsName(statement.declarationList, name);
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.text === name;
  }
  return false;
}

function functionBodyDeclaresVar(
  body: ts.ConciseBody | undefined,
  name: string,
): boolean {
  if (!body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== body && ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclarationList(node) &&
      !(node.flags & ts.NodeFlags.BlockScoped) &&
      declarationListContainsName(node, name)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** Import aliases are proven only while they still refer to that import. This
 * syntax-only scope check covers lexical declarations and parameters without
 * escalating to a Program or TypeChecker. */
function isImportedNamespaceShadowed(
  call: ts.CallExpression,
  name: string,
  sourceFile: ts.SourceFile,
): boolean {
  for (
    let ancestor = call.parent;
    ancestor && ancestor !== sourceFile;
    ancestor = ancestor.parent
  ) {
    if (ts.isFunctionLike(ancestor)) {
      if (
        ancestor.parameters.some((parameter) =>
          bindingContainsName(parameter.name, name),
        )
      ) {
        return true;
      }
      if (
        functionBodyDeclaresVar(
          (ancestor as ts.FunctionLikeDeclaration).body,
          name,
        )
      ) {
        return true;
      }
      if (
        (ts.isFunctionDeclaration(ancestor) ||
          ts.isFunctionExpression(ancestor)) &&
        ancestor.name?.text === name
      ) {
        return true;
      }
    }
    if (
      ts.isBlock(ancestor) &&
      ancestor.statements.some((statement) =>
        statementDeclaresName(statement, name),
      )
    ) {
      return true;
    }
    if (
      ts.isCatchClause(ancestor) &&
      ancestor.variableDeclaration &&
      bindingContainsName(ancestor.variableDeclaration.name, name)
    ) {
      return true;
    }
    if (
      (ts.isForStatement(ancestor) ||
        ts.isForInStatement(ancestor) ||
        ts.isForOfStatement(ancestor)) &&
      ancestor.initializer &&
      ts.isVariableDeclarationList(ancestor.initializer) &&
      declarationListContainsName(ancestor.initializer, name)
    ) {
      return true;
    }
  }
  return false;
}

function invocationMode(
  call: ts.CallExpression,
  namespaces: SupportedNamespaces,
  sourceFile: ts.SourceFile,
): AgentInvocationMode | null {
  const chain = propertyAccessChain(call.expression);
  if (!chain) return null;

  if (
    chain.length === 4 &&
    chain[0] === "ctx" &&
    chain[1] === "sapiom" &&
    chain[2] === "agents"
  ) {
    if (chain[3] === "run") return "blocking";
    if (chain[3] === "launch") return "async";
    return null;
  }

  if (chain.length !== 2) return null;
  const [namespace, method] = chain;
  if (
    namespaces.current.has(namespace!) &&
    !isImportedNamespaceShadowed(call, namespace!, sourceFile)
  ) {
    if (method === "run") return "blocking";
    if (method === "launch") return "async";
  }
  if (
    namespaces.legacy.has(namespace!) &&
    method === "launch" &&
    !isImportedNamespaceShadowed(call, namespace!, sourceFile)
  ) {
    return "async";
  }
  return null;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

type TargetResult = { kind: "literal"; slug: string } | { kind: "dynamic" };

/** Mirrors object-literal overwrite order sufficiently for a direct target:
 * an explicit `definition` after a spread wins; a later spread makes it
 * dynamic again because it could overwrite the target. */
function directDefinitionTarget(call: ts.CallExpression): TargetResult {
  const argument = call.arguments[0];
  if (!argument) return { kind: "dynamic" };
  const unwrapped = unwrapExpression(argument);
  if (!ts.isObjectLiteralExpression(unwrapped)) return { kind: "dynamic" };

  let result: TargetResult = { kind: "dynamic" };
  for (const property of unwrapped.properties) {
    if (ts.isSpreadAssignment(property)) {
      result = { kind: "dynamic" };
      continue;
    }
    if (!property.name || propertyName(property.name) !== "definition") {
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      result = { kind: "dynamic" };
      continue;
    }
    const value = unwrapExpression(property.initializer);
    result =
      ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
        ? { kind: "literal", slug: value.text }
        : { kind: "dynamic" };
  }
  return result;
}

function relativeEvidence(
  root: string,
  file: string,
  sourceFile: ts.SourceFile,
  position: number,
): SourceEvidence {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    file: path.relative(root, file).split(path.sep).join(path.posix.sep),
    line: location.line + 1,
    column: location.character + 1,
  };
}

function scanAgentInvocationsInFile(
  root: string,
  file: string,
  content: string,
  blocks: readonly StepBlock[],
): AgentInvocationScanResult {
  const sourceFile = ts.createSourceFile(
    path.basename(file),
    content,
    ts.ScriptTarget.Latest,
    true,
    path.extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const namespaces = collectSupportedNamespaces(sourceFile);
  const invocations: DetectedAgentInvocation[] = [];
  const warnings: AgentInvocationDetectionWarning[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const mode = invocationMode(node, namespaces, sourceFile);
      if (mode) {
        const position = node.expression.getStart(sourceFile);
        const evidence = relativeEvidence(root, file, sourceFile, position);
        const target = directDefinitionTarget(node);
        if (target.kind === "literal") {
          invocations.push({
            slug: target.slug,
            mode,
            fromStepId: attributeTo(blocks, position),
            evidence,
          });
        } else {
          warnings.push({ code: "dynamic-target", mode, evidence });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { invocations, warnings };
}

function evidenceOrder(left: SourceEvidence, right: SourceEvidence): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column
  );
}

/**
 * One pass over `root`'s sources returning both the cross-workflow launches and
 * the Sapiom capability calls, each attributed to the `defineStep` block it
 * sits in (`knownStepIds` = the workflow's real step names, so an unrelated
 * `name:` property can never be mistaken for a step). Never throws: unreadable
 * files/directories simply contribute nothing.
 *
 * A single walk + read + block computation per file: the callers used to scan
 * the tree twice (once per detector), and auto-render now fires on every save,
 * so the shared pass halves the I/O on the hot path.
 */
export async function scanWorkflowSources(
  root: string,
  knownStepIds: ReadonlySet<string>,
): Promise<WorkflowSourceScan> {
  const invocations: DetectedAgentInvocation[] = [];
  const invocationWarnings: AgentInvocationDetectionWarning[] = [];
  const capabilities: DetectedCapability[] = [];
  for (const file of await listSourceFiles(root)) {
    let content: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    const blocks = stepBlockRanges(content, knownStepIds);

    const invocationScan = scanAgentInvocationsInFile(
      root,
      file,
      content,
      blocks,
    );
    invocations.push(...invocationScan.invocations);
    invocationWarnings.push(...invocationScan.warnings);
    for (const match of content.matchAll(CAPABILITY_CALL_PATTERN)) {
      const capability = match[1]!.replace(/\s+/g, "");
      if (NON_CAPABILITY_CALLS.has(capability)) continue;
      capabilities.push({
        capability,
        fromStepId: attributeTo(blocks, match.index),
      });
    }
  }
  invocations.sort((left, right) =>
    evidenceOrder(left.evidence, right.evidence),
  );
  invocationWarnings.sort((left, right) =>
    evidenceOrder(left.evidence, right.evidence),
  );
  const launches = invocations
    .filter((invocation) => invocation.mode === "async")
    .map(({ slug, fromStepId }) => ({ slug, fromStepId }));
  return { launches, invocations, invocationWarnings, capabilities };
}

/** Direct agent invocations plus deterministic warnings for supported calls
 * whose target is not a direct literal. */
export async function detectAgentInvocations(
  root: string,
  knownStepIds: ReadonlySet<string>,
): Promise<AgentInvocationScanResult> {
  const scan = await scanWorkflowSources(root, knownStepIds);
  return {
    invocations: scan.invocations,
    warnings: scan.invocationWarnings,
  };
}

/** Just the launches from {@link scanWorkflowSources}. */
export async function detectWorkflowLaunches(
  root: string,
  knownStepIds: ReadonlySet<string>,
): Promise<DetectedLaunch[]> {
  return (await scanWorkflowSources(root, knownStepIds)).launches;
}

/** Just the capabilities from {@link scanWorkflowSources}. */
export async function detectStepCapabilities(
  root: string,
  knownStepIds: ReadonlySet<string>,
): Promise<DetectedCapability[]> {
  return (await scanWorkflowSources(root, knownStepIds)).capabilities;
}
