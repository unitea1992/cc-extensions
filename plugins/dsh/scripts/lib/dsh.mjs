// Runtime for the DSH companion: each task is one `dst run --json` execution.
//
// DSH (DeepSeek Harness) is invoked through the `dst` launcher in headless mode. The run command
// must not receive `--profile dsh-tui` (it deadlocks headless runs); the profile's provider
// definitions are applied with an explicit `--patch` of the profile's patch file instead. The model
// and reasoning effort are selected with a bundled overlay patch that reads them from the
// DSH_LAUNCH_PROVIDER / DSH_LAUNCH_MODEL / DSH_LAUNCH_EFFORT environment variables: the
// `--provider` / `--model` flags cannot carry an effort (their one-shot override is applied after
// the patch and drops it). Each run prints one line of JSON on stdout (schemaVersion 1, ok,
// sessionId, text / error.code, error.message) and exits; exit code 124 is dst's own deadline.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { binaryAvailable, runCommand, stopProcessGroup } from "./process.mjs";

export const DSH_BIN_ENV = "DSH_COMPANION_BIN";
export const TIMEOUT_ENV = "DSH_COMPANION_TIMEOUT_SECONDS";
export const LAUNCH_PROVIDER_ENV = "DSH_LAUNCH_PROVIDER";
export const LAUNCH_MODEL_ENV = "DSH_LAUNCH_MODEL";
export const LAUNCH_EFFORT_ENV = "DSH_LAUNCH_EFFORT";
export const MODELS_PROFILE = "dsh-tui";
export const PROFILE_PATCH_ENV = "DSH_COMPANION_PROFILE_PATCH";
export const PERMISSION_MODES = ["read-only", "workspace-write", "danger-full-access"];
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BUNDLED_AGENT_MODEL_PATCH = path.join(PLUGIN_ROOT, "scripts", "patches", "agent-model.yml");
const DEFAULT_PROFILE_PATCH = path.join(".dsh", "profiles", MODELS_PROFILE, "cordis.patch.yml");
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session. Pick the next highest-value step and follow through until the task is resolved.";

export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "one `dst run` process per run",
    detail: "Each task starts its own `dst run --json` process and it exits when the run ends."
  };
}

export function getDshCommand(env = process.env) {
  return env[DSH_BIN_ENV] || "dst";
}

// Cancel and SessionEnd match the runner's process group against the command it was started with,
// so the recorded name must follow a DSH_COMPANION_BIN replacement instead of assuming `dst`.
export function getRunnerCommandName(env = process.env) {
  return path.basename(getDshCommand(env));
}

// `dst --version` proves the launcher is on PATH; `dst run --help` is printed without starting
// DSH and proves this dst speaks the flags the companion needs.
export function getDshAvailability(cwd, options = {}) {
  const command = getDshCommand(options.env);
  const versionStatus = binaryAvailable(command, ["--version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    return versionStatus;
  }
  const help = runCommand(command, ["run", "--help"], { cwd, env: options.env });
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (help.error || help.status !== 0 || !helpText.includes("--patch") || !helpText.includes("--json")) {
    return {
      available: false,
      detail: `${versionStatus.detail}; this dst does not support \`run --json\` with \`--patch\``
    };
  }
  return versionStatus;
}

export function ensureDshAvailable(cwd, options = {}) {
  const availability = getDshAvailability(cwd, options);
  if (!availability.available) {
    throw new Error(
      "DSH is not installed or its `dst` launcher does not support `run --json`. Install it, then rerun `/dsh:setup`."
    );
  }
}

function parseJsonOutput(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Not a JSON line; try the previous one.
    }
  }
  return null;
}

// `dst models list` answers with { ok, data: [{ provider, models: [{ id, name }] }] }. The TUI
// profile is where model providers are defined for this machine, so it is asked for first; without
// it only the headless defaults answer.
export function listDshModels(cwd, options = {}) {
  const command = getDshCommand(options.env);
  let result = runCommand(command, ["models", "list", "--profile", MODELS_PROFILE, "--json"], { cwd, env: options.env });
  let source = `the ${MODELS_PROFILE} profile`;
  if (result.error || result.status !== 0) {
    result = runCommand(command, ["models", "list", "--json"], { cwd, env: options.env });
    source = "the headless defaults (the dsh-tui profile was unavailable)";
  }
  if (result.error || result.status !== 0) {
    return {
      models: [],
      source,
      detail: result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)
    };
  }
  const parsed = parseJsonOutput(result.stdout);
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.data)) {
    return { models: [], source, detail: "dst returned no model list" };
  }
  const models = [];
  for (const provider of parsed.data) {
    if (!provider || typeof provider.provider !== "string") {
      continue;
    }
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (model && typeof model.id === "string" && model.id) {
        models.push(`${provider.provider}/${model.id}`);
      }
    }
  }
  return { models, source, detail: null };
}

// DSH model ids may contain slashes themselves (for example openrouter/minimax/…:free), so only
// the first slash separates the provider.
export function parseModelRoute(model) {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(
      `Model "${trimmed}" must use the provider/model form (for example logfare/glm-5.3). /dsh:setup lists the available ones.`
    );
  }
  return { provider: trimmed.slice(0, separator), model: trimmed.slice(separator + 1) };
}

export function normalizeEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim();
  // Effort candidates differ per model, so anything non-empty is forwarded; DSH stops the run with
  // UNSUPPORTED_REASONING_EFFORT when the model does not support it.
  return normalized || null;
}

export function normalizePermissionMode(mode) {
  if (mode == null) {
    return null;
  }
  const normalized = String(mode).trim();
  if (!normalized) {
    return null;
  }
  if (!PERMISSION_MODES.includes(normalized)) {
    throw new Error(`Unsupported permission mode "${mode}". Use one of: ${PERMISSION_MODES.join(", ")}.`);
  }
  return normalized;
}

// The environment can carry the default route (and default effort) the same way the bundled patch
// reads them; an explicit --model only inherits the environment effort when the route itself comes
// from the environment, so a stale effort never follows a different model.
export function resolveLaunchRoute({ model, effort } = {}, env = process.env) {
  const explicitRoute = parseModelRoute(model);
  const envRoute =
    env[LAUNCH_PROVIDER_ENV] && env[LAUNCH_MODEL_ENV]
      ? { provider: env[LAUNCH_PROVIDER_ENV], model: env[LAUNCH_MODEL_ENV] }
      : null;
  const route = explicitRoute ?? envRoute;
  const effortValue = normalizeEffort(effort ?? (explicitRoute ? null : env[LAUNCH_EFFORT_ENV]));
  if (!route && effortValue) {
    throw new Error(
      "DSH needs a model before an effort can be applied. Pass --model provider/model together with --effort."
    );
  }
  return { route, effort: route ? effortValue : null };
}

export function resolveDefaultRoute(env = process.env) {
  return env[LAUNCH_PROVIDER_ENV] && env[LAUNCH_MODEL_ENV]
    ? { provider: env[LAUNCH_PROVIDER_ENV], model: env[LAUNCH_MODEL_ENV] }
    : null;
}

export function resolveTimeoutMs(value, env = process.env) {
  const raw = value ?? env[TIMEOUT_ENV];
  if (raw == null || String(raw).trim() === "") {
    return 0;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid timeout "${raw}". Use a number of seconds, or 0 to disable.`);
  }
  return Math.round(seconds * 1000);
}

// The profile patch defines this machine's providers (API keys and models). Other machines have
// their own; when the file is missing the run falls back to DSH's own provider defaults.
export function resolveProfilePatchPath(env = process.env) {
  return env[PROFILE_PATCH_ENV] || path.join(os.homedir(), DEFAULT_PROFILE_PATCH);
}

function resolvePatchFiles(env = process.env) {
  const patchFiles = [];
  const profilePatch = resolveProfilePatchPath(env);
  if (profilePatch && fs.existsSync(profilePatch)) {
    patchFiles.push(profilePatch);
  }
  return patchFiles;
}

export function buildRunArgs(options = {}) {
  const args = ["run", "--json"];
  for (const patch of options.patchFiles ?? []) {
    args.push("--patch", patch);
  }
  if (options.resumeSessionId) {
    args.push("--session-id", options.resumeSessionId);
  }
  // --permission-mode and --write/--read-only are rejected together upstream; the explicit mode
  // still wins here so a stored request from an older version cannot fall back to a weaker level.
  const mode = normalizePermissionMode(options.permissionMode) ?? (options.readOnly ? "read-only" : null);
  if (mode) {
    args.push("--permission-mode", mode);
  }
  if (options.timeoutMs > 0) {
    args.push("--timeout", String(Math.round(options.timeoutMs)));
  }
  return args;
}

function cleanStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function describeFailure({ exit, parsed, stderr }) {
  if (parsed && parsed.ok === false) {
    const error = parsed.error ?? {};
    return {
      code: typeof error.code === "string" ? error.code : null,
      message: String(error.message ?? "DSH reported a failed task."),
      threadId: typeof parsed.sessionId === "string" ? parsed.sessionId : null
    };
  }
  if (exit.signal) {
    return { code: null, message: `DSH was stopped by ${exit.signal}.`, threadId: null };
  }
  if (exit.code === 124) {
    return {
      code: "DEADLINE_EXCEEDED",
      message: "DSH exceeded its --timeout deadline before finishing the task.",
      threadId: null
    };
  }
  const detail = cleanStderr(stderr);
  return {
    code: null,
    message: `DSH exited with status ${exit.code}${detail ? `: ${shorten(detail, 400)}` : "."}`,
    threadId: null
  };
}

async function runAttempt({ cwd, args, env, prompt, options }) {
  const child = spawn(getDshCommand(env), args, {
    cwd,
    env,
    // Own process group so cancellation can stop DSH together with the commands it started.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  // The child runs in its own process group, so signals sent to this process do not reach it.
  // Forward termination explicitly so an interrupted companion never leaves DSH running.
  const stopChild = (signal = "SIGTERM") => {
    if (!child.pid) {
      return;
    }
    if (process.platform !== "win32" && typeof signal === "string" && signal !== "SIGTERM") {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    }
    try {
      stopProcessGroup(child.pid);
    } catch {
      // Best effort while exiting.
    }
  };
  const onSignal = (signal) => {
    stopChild(signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  process.on("exit", stopChild);
  for (const signal of forwardedSignals) {
    process.on(signal, onSignal);
  }

  if (child.pid) {
    emitProgress(options.onProgress, `DSH process started (pid ${child.pid}).`, "starting", {
      runnerPid: child.pid,
      runnerCommand: getRunnerCommandName(env)
    });
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // The prompt goes through stdin so long instructions never hit command-line length limits.
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  process.off("exit", stopChild);
  for (const signal of forwardedSignals) {
    process.off(signal, onSignal);
  }
  return { exit, stdout, stderr };
}

export async function runDshTurn(cwd, options = {}) {
  ensureDshAvailable(cwd, { env: options.env });

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this DSH run.");
  }

  const baseEnv = options.env ?? process.env;
  const { route, effort } = resolveLaunchRoute({ model: options.model, effort: options.effort }, baseEnv);
  const permissionMode = normalizePermissionMode(options.permissionMode);
  const readOnly = options.readOnly !== false;
  const modeLabel = permissionMode ?? (readOnly ? "read-only" : "workspace-write (dst default)");
  const patchFiles = resolvePatchFiles(baseEnv);
  if (route) {
    // The bundled overlay points the default agent at the requested model; see patches/agent-model.yml.
    patchFiles.push(BUNDLED_AGENT_MODEL_PATCH);
  }
  const args = buildRunArgs({
    patchFiles,
    resumeSessionId: options.resumeSessionId,
    readOnly,
    permissionMode,
    timeoutMs: resolveTimeoutMs(options.timeoutSeconds, baseEnv)
  });
  const env = { ...baseEnv };
  if (route) {
    env[LAUNCH_PROVIDER_ENV] = route.provider;
    env[LAUNCH_MODEL_ENV] = route.model;
    if (effort) {
      env[LAUNCH_EFFORT_ENV] = effort;
    } else {
      delete env[LAUNCH_EFFORT_ENV];
    }
  } else {
    delete env[LAUNCH_PROVIDER_ENV];
    delete env[LAUNCH_MODEL_ENV];
    delete env[LAUNCH_EFFORT_ENV];
  }

  emitProgress(
    options.onProgress,
    options.resumeSessionId
      ? `Resuming DSH session ${options.resumeSessionId} (${route ? `${route.provider}/${route.model}` : "default model"}, ${modeLabel}).`
      : `Starting DSH ${route ? `${route.provider}/${route.model}` : "default-model"} run in ${modeLabel} mode.`,
    "starting"
  );

  const result = await runAttempt({ cwd, args, env, prompt, options });
  const { exit, stdout, stderr } = result;
  if (exit.error) {
    throw exit.error;
  }

  const parsed = parseJsonOutput(stdout);
  const failed = exit.code !== 0 || !parsed || parsed.ok !== true;
  let error = null;
  let finalMessage = "";
  let sessionId = null;
  if (parsed && parsed.ok === true) {
    finalMessage = typeof parsed.text === "string" ? parsed.text : "";
    sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
  }
  if (failed) {
    error = describeFailure({ exit, parsed, stderr });
    sessionId = error.threadId ?? sessionId;
  }
  emitProgress(options.onProgress, failed ? "DSH run failed." : "DSH run completed.", failed ? "failed" : "finalizing");

  return {
    status: failed ? 1 : 0,
    threadId: sessionId ?? options.resumeSessionId ?? null,
    finalMessage,
    error,
    stderr: cleanStderr(stderr),
    exitCode: exit.code,
    signal: exit.signal
  };
}
