export {
  MANAGED_AGENT_CONTRACT,
  MANAGED_AGENT_FORBIDDEN_AMBIENT_CREDENTIALS,
  MANAGED_AGENT_MODEL_ENVIRONMENT_VARIABLES,
  MANAGED_AGENT_MODEL_TARGETS,
  ManagedAgentConfigurationError,
  assertManagedAgentDirectGatewayOrigin,
  normalizeManagedAgentGatewayOrigin,
  normalizeManagedAgentHermeticGatewayOrigin,
  resolveManagedAgentModelTarget,
  validateManagedAgentProbeConfig,
  type ManagedAgentProbeValidationOptions,
} from "./contract.js";
export {
  buildManagedAgentChildEnvironment,
  prepareManagedAgentDirectories,
  type ManagedAgentAmbientEnvironment,
  type ManagedAgentChildEnvironmentInput,
  type ManagedAgentIsolatedDirectories,
} from "./environment.js";
export { ManagedAgentEventRecorder } from "./events.js";
export {
  FIXTURE_PATHS,
  captureManagedAgentWorkspaceSnapshot,
  createManagedAgentFixture,
  diffManagedAgentWorkspaceSnapshots,
  fixtureGitStatus,
  observeManagedAgentPreservation,
  readManagedAgentFixturePids,
  verifyManagedAgentFixtureBytes,
  waitForManagedAgentFixturePids,
  type ManagedAgentFixture,
  type ManagedAgentWorkspaceSnapshot,
} from "./fixture.js";
export {
  MANAGED_AGENT_BUILTIN_TOOLS,
  MANAGED_AGENT_DISALLOWED_TOOLS,
  ManagedAgentPathError,
  createManagedAgentPermissionHandler,
  isPathWithinRoot,
  resolveManagedAgentToolPath,
  type ManagedAgentPermissionHandlerOptions,
} from "./permissions.js";
export {
  LocalManagedAgentProcessObserver,
  createLocalManagedAgentProcessObserver,
} from "./process-observer.js";
export {
  MANAGED_AGENT_MCP_SERVER_NAME,
  MANAGED_AGENT_TEARDOWN_TIMEOUT_MS,
  createManagedAgentMcpRuntime,
  qualifiedManagedAgentMcpToolName,
  runManagedAgentProbe,
  type ManagedAgentMcpRuntime,
} from "./runtime.js";
export type {
  ManagedAgentModelTarget,
  ManagedAgentModelTargetId,
  ManagedAgentPermissionDecision,
  ManagedAgentPermissionEvidence,
  ManagedAgentPermissionReason,
  ManagedAgentPreservationObservation,
  ManagedAgentProbeConfig,
  ManagedAgentProbeDependencies,
  ManagedAgentProbeEvent,
  ManagedAgentProbeEventType,
  ManagedAgentProbeResult,
  ManagedAgentProbeScenario,
  ManagedAgentProcessObserver,
  ManagedAgentQuery,
  ManagedAgentQueryFactory,
  ManagedAgentSdkUsageEstimate,
  ManagedAgentTeardownObservation,
  ManagedAgentTerminalClassification,
  ManagedAgentToolEvidence,
  ManagedAgentWorkspaceChange,
} from "./types.js";
