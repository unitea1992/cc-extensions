// Modified from openai/codex-plugin-cc (Apache-2.0): the Codex app-server runtime was
// replaced with one-shot `opencode run --standalone --format json` executions.
//
// Each run starts a private OpenCode server. Read-only runs inject a dedicated agent through
// OPENCODE_CONFIG_CONTENT for that run only, so the user's OpenCode config files are never edited.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";

export const OPENCODE_BIN_ENV = "OPENCODE_COMPANION_BIN";
export const READ_ONLY_AGENT = "cc-companion-readonly";
export const WRITE_AGENT = "build";
const TASK_THREAD_PREFIX = "OpenCode Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
const MAX_REASONING_SECTIONS = 3;
const MAX_REASONING_CHARS = 400;
const INSTALL_HINT =
  "OpenCode CLI is not installed or is too old. Install OpenCode v2 (https://opencode.ai), then rerun `/opencode:setup`.";

// OpenCode treats a trailing " *" as "optionally followed by arguments", so "git diff *" matches
// `git diff` and `git diff --stat` but not `git difftool`.
const READ_ONLY_SHELL_COMMANDS = [
  "git status *",
  "git diff *",
  "git log *",
  "git show *",
  "git blame *",
  "git rev-parse *",
  "git ls-files *",
  "git merge-base *",
  "git branch --show-current"
];

// Rules are evaluated last-match-wins, so denials that must override the allow-list come last.
// Shell resources include redirections (`git diff > out`), so any redirect is denied outright.
const READ_ONLY_SHELL_DENIALS = ["*>*", "*--output*", "*--ext-diff*", "*$(*", "*`*"];

export function getSessionRuntimeStatus() {
  return {
    mode: "standalone",
    label: "private server per run",
    detail: "Each review or task starts its own `opencode run --standalone` server and stops it when the run ends."
  };
}

function findOnPath(command, env) {
  const extensions = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  for (const directory of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// The official installer puts the binary in ~/.opencode/bin and edits shell profiles, which does
// not reach an already running Claude Code. Fall back to that location so setup works right after
// installing.
export function getOpencodeCommand(env = process.env) {
  if (env[OPENCODE_BIN_ENV]) {
    return env[OPENCODE_BIN_ENV];
  }
  if (findOnPath("opencode", env)) {
    return "opencode";
  }
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const installed = path.join(home, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  return fs.existsSync(installed) ? installed : "opencode";
}

export function buildReadOnlyAgentConfig() {
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "list", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    ...READ_ONLY_SHELL_COMMANDS.map((resource) => ({ action: "shell", resource, effect: "allow" })),
    ...READ_ONLY_SHELL_DENIALS.map((resource) => ({ action: "shell", resource, effect: "deny" }))
  ];
  return {
    description: "Read-only agent injected by the Claude Code OpenCode companion. Cannot edit files or run writing commands.",
    mode: "primary",
    permissions
  };
}

// The read-only agent may run `git diff`/`git log -p`/`git status`, and git can launch programs
// from repository or user config while doing so (textconv, external diff drivers, clean/process
// filters, fsmonitor). Those programs could write files, so neutralize them through GIT_CONFIG_*
// overrides, which take precedence over every config file and apply to every git the run starts.
const SAFE_EXTERNAL_DIFF = "sh -c 'diff -u -- \"$2\" \"$5\"; exit 0' companion-diff";
const DRIVER_KEY_PATTERN = "^((diff|filter)\\..+\\.(textconv|command|clean|smudge|process)|diff\\.external)$";

export function buildGitHardeningEnv(cwd, env = process.env) {
  // diff.external is replaced only when configured; overriding it unconditionally would switch
  // every `git diff` to the external format.
  const overrides = [["core.fsmonitor", "false"]];
  const result = runCommand("git", ["config", "--null", "--get-regexp", DRIVER_KEY_PATTERN], { cwd, env });
  if (!result.error && result.status === 0) {
    for (const entry of result.stdout.split("\0")) {
      const key = entry.split("\n", 1)[0];
      if (key === "diff.external") {
        overrides.push([key, SAFE_EXTERNAL_DIFF]);
        continue;
      }
      const match = /^(diff|filter)\.(.+)\.(textconv|command|clean|smudge|process)$/.exec(key);
      if (!match) {
        continue;
      }
      const [, section, name, kind] = match;
      if (kind === "textconv" || kind === "clean" || kind === "smudge") {
        overrides.push([key, "cat"]);
      } else if (kind === "command") {
        overrides.push([key, SAFE_EXTERNAL_DIFF]);
      } else {
        overrides.push([key, ""]);
      }
      if (section === "filter") {
        overrides.push([`filter.${name}.required`, "false"]);
      }
    }
  }

  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const hardening = { GIT_CONFIG_COUNT: String(start + overrides.length) };
  overrides.forEach(([key, value], index) => {
    hardening[`GIT_CONFIG_KEY_${start + index}`] = key;
    hardening[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  return hardening;
}

export function buildRunConfigContent(existingContent) {
  let base = {};
  if (existingContent && existingContent.trim()) {
    try {
      const parsed = JSON.parse(existingContent);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed;
      }
    } catch {
      base = {};
    }
  }
  const agents = base.agents && typeof base.agents === "object" && !Array.isArray(base.agents) ? base.agents : {};
  return JSON.stringify({
    ...base,
    agents: {
      ...agents,
      [READ_ONLY_AGENT]: buildReadOnlyAgentConfig()
    }
  });
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    String(command ?? "")
  );
}

function cleanStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
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

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);

function toolInputPath(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  return input.filePath ?? input.path ?? input.file ?? null;
}

function describeTool(part) {
  const tool = part?.tool ?? "tool";
  const state = part?.state ?? {};
  const input = state.input ?? {};
  const status = state.status ?? "completed";
  if (tool === "shell" || tool === "bash") {
    const command = shorten(input.command, 96);
    const phase = looksLikeVerificationCommand(input.command) ? "verifying" : "running";
    return status === "error"
      ? { message: `Command failed: ${command} (${shorten(state.error ?? state.output, 96)})`, phase }
      : { message: `Command completed: ${command}`, phase };
  }
  if (EDIT_TOOLS.has(tool)) {
    const target = toolInputPath(input);
    return {
      message: `File change ${status === "error" ? "failed" : "applied"}${target ? `: ${target}` : "."}`,
      phase: "editing"
    };
  }
  const target = toolInputPath(input) ?? input.pattern ?? input.query ?? input.url ?? null;
  return {
    message: `Tool ${tool} ${status === "error" ? "failed" : "completed"}${target ? `: ${shorten(target, 96)}` : "."}`,
    phase: "investigating"
  };
}

export function createRunState(options = {}) {
  return {
    sessionId: options.sessionId ?? null,
    messageOrder: [],
    messageTexts: new Map(),
    reasoningSummary: [],
    toolCalls: [],
    touchedFiles: new Set(),
    error: null,
    onProgress: options.onProgress ?? null
  };
}

export function applyRunEvent(state, event) {
  if (!event || typeof event !== "object") {
    return;
  }
  if (typeof event.sessionID === "string" && event.sessionID && state.sessionId !== event.sessionID) {
    state.sessionId = event.sessionID;
    emitProgress(state.onProgress, `Session ready (${event.sessionID}).`, "starting", { threadId: event.sessionID });
  }
  const part = event.part ?? {};

  switch (event.type) {
    case "step_start":
      break;
    case "text": {
      const messageId = part.messageID ?? "unknown";
      if (!state.messageTexts.has(messageId)) {
        state.messageTexts.set(messageId, []);
        state.messageOrder.push(messageId);
      }
      const text = String(part.text ?? "");
      if (text) {
        state.messageTexts.get(messageId).push(text);
        emitLogEvent(state.onProgress, {
          message: `Assistant message captured: ${shorten(text, 96)}`,
          logTitle: "Assistant message",
          logBody: text
        });
      }
      break;
    }
    case "reasoning": {
      const text = normalizeReasoningText(part.text);
      if (text && !state.reasoningSummary.includes(text)) {
        state.reasoningSummary.push(text);
        emitLogEvent(state.onProgress, {
          message: `Reasoning captured: ${shorten(text, 96)}`,
          logTitle: "Reasoning",
          logBody: `- ${text}`
        });
      }
      break;
    }
    case "tool_use": {
      const call = {
        tool: part.tool ?? null,
        status: part.state?.status ?? null,
        input: part.state?.input ?? null,
        error: part.state?.error ?? null
      };
      state.toolCalls.push(call);
      if (EDIT_TOOLS.has(call.tool) && call.status !== "error") {
        const target = toolInputPath(call.input);
        if (target) {
          state.touchedFiles.add(target);
        }
      }
      const update = describeTool(part);
      emitProgress(state.onProgress, update.message, update.phase);
      break;
    }
    case "step_finish":
      if (part.reason && part.reason !== "tool-calls") {
        emitProgress(state.onProgress, `Step finished (${part.reason}).`, "finalizing");
      }
      break;
    case "error": {
      const error = event.error ?? {};
      const message = error.message ?? error.data?.message ?? error.name ?? JSON.stringify(error);
      state.error = { ...error, message };
      emitProgress(state.onProgress, `OpenCode error: ${message}`, "failed");
      break;
    }
    default:
      break;
  }
}

export function finalMessageFromState(state) {
  for (let index = state.messageOrder.length - 1; index >= 0; index -= 1) {
    const text = state.messageTexts.get(state.messageOrder[index]).join("").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

export function getOpencodeAvailability(cwd, options = {}) {
  const command = getOpencodeCommand(options.env);
  const versionStatus = binaryAvailable(command, ["--version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const runHelp = runCommand(command, ["run", "--help"], { cwd, env: options.env });
  const helpText = `${runHelp.stdout}\n${runHelp.stderr}`;
  if (runHelp.error || runHelp.status !== 0 || !helpText.includes("--standalone") || !helpText.includes("--format")) {
    return {
      available: false,
      detail: `${versionStatus.detail}; \`opencode run --standalone --format json\` is unavailable (OpenCode v2 is required)`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; non-interactive runtime available`
  };
}

export function ensureOpencodeAvailable(cwd, options = {}) {
  const availability = getOpencodeAvailability(cwd, options);
  if (!availability.available) {
    throw new Error(INSTALL_HINT);
  }
  return availability;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// `opencode models` against a cold server can return an empty list while the model catalog
// is still loading, so retry briefly before reporting that no models are available.
export function listOpencodeModels(cwd, options = {}) {
  const command = getOpencodeCommand(options.env);
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastDetail = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = runCommand(command, ["models"], { cwd, env: options.env });
    if (result.error || result.status !== 0) {
      lastDetail = result.error?.message ?? (cleanStderr(result.stderr) || `exit ${result.status}`);
    } else {
      const models = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (models.length > 0) {
        return { models, detail: null };
      }
      lastDetail = null;
    }
    if (attempt < attempts - 1) {
      sleepSync(options.retryDelayMs ?? 1500);
    }
  }
  return { models: [], detail: lastDetail };
}

export function buildModelArgument(model, effort) {
  const normalizedModel = model ? String(model).trim() : "";
  const normalizedEffort = effort ? String(effort).trim() : "";
  if (!normalizedModel) {
    if (normalizedEffort) {
      throw new Error(
        "`--effort` selects an OpenCode model variant and needs `--model provider/model`. Example: `--model openai/gpt-5.5 --effort high`."
      );
    }
    return null;
  }
  if (!normalizedModel.includes("/")) {
    throw new Error(`Model "${normalizedModel}" must use the OpenCode form provider/model (see \`/opencode:setup\`).`);
  }
  if (!normalizedEffort) {
    return normalizedModel;
  }
  if (normalizedModel.includes("#")) {
    throw new Error(`Model "${normalizedModel}" already selects a variant. Drop either the #variant suffix or --effort.`);
  }
  return `${normalizedModel}#${normalizedEffort}`;
}

export function buildRunArgs(options = {}) {
  const args = ["run", "--standalone", "--format", "json", "--thinking"];
  args.push("--agent", options.readOnly === false ? WRITE_AGENT : READ_ONLY_AGENT);
  const modelArgument = buildModelArgument(options.model, options.effort);
  if (modelArgument) {
    args.push("--model", modelArgument);
  }
  if (options.resumeSessionId) {
    args.push("--session", options.resumeSessionId);
  } else if (options.title) {
    args.push("--title", options.title);
  }
  return args;
}

export async function runOpencodeTurn(cwd, options = {}) {
  ensureOpencodeAvailable(cwd, { env: options.env });

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this OpenCode run.");
  }

  const readOnly = options.readOnly !== false;
  const args = buildRunArgs({ ...options, readOnly });
  const baseEnv = options.env ?? process.env;
  const env = { ...baseEnv };
  if (readOnly) {
    env.OPENCODE_CONFIG_CONTENT = buildRunConfigContent(baseEnv.OPENCODE_CONFIG_CONTENT);
    Object.assign(env, buildGitHardeningEnv(cwd, env));
    delete env.GIT_EXTERNAL_DIFF;
  }

  const state = createRunState({ onProgress: options.onProgress, sessionId: null });
  emitProgress(
    options.onProgress,
    options.resumeSessionId
      ? `Resuming OpenCode session ${options.resumeSessionId}.`
      : `Starting OpenCode ${readOnly ? "read-only" : "write-capable"} run.`,
    "starting"
  );

  const child = spawn(getOpencodeCommand(baseEnv), args, {
    cwd,
    env,
    // Own process group so cancellation can stop OpenCode together with its private server.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  if (child.pid) {
    emitProgress(options.onProgress, `OpenCode process started (pid ${child.pid}).`, "starting", {
      runnerPid: child.pid
    });
  }

  // The child runs in its own process group, so signals sent to this process do not reach it.
  // Forward termination explicitly so an interrupted companion never leaves OpenCode running.
  // Signal the whole group even if the runner itself already exited: tools it started
  // (shell commands, the private server) may still be alive in that group.
  const stopChild = (signal = "SIGTERM") => {
    if (!child.pid) {
      return;
    }
    try {
      if (process.platform === "win32") {
        runCommand("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      } else {
        process.kill(-child.pid, typeof signal === "string" ? signal : "SIGTERM");
      }
    } catch {
      // Already gone.
    }
  };
  const onSignal = (signal) => {
    // Forward the same signal so SIGINT reaches OpenCode's own session-interrupt handling.
    stopChild(signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  process.on("exit", stopChild);
  for (const signal of forwardedSignals) {
    process.on(signal, onSignal);
  }

  let stderr = "";
  let buffer = "";
  const unparsedLines = [];

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      unparsedLines.push(trimmed);
      return;
    }
    applyRunEvent(state, event);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // Prompts go through stdin: review diffs easily exceed command-line length limits.
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
  if (buffer.trim()) {
    handleLine(buffer);
  }

  if (exit.error) {
    throw exit.error;
  }

  const finalMessage = finalMessageFromState(state);
  const failed = exit.code !== 0 || Boolean(state.error);
  if (!state.error && failed) {
    const detail = cleanStderr(stderr) || unparsedLines.join("\n");
    state.error = {
      message: exit.signal
        ? `OpenCode was stopped by ${exit.signal}.`
        : `OpenCode exited with status ${exit.code}${detail ? `: ${shorten(detail, 400)}` : "."}`
    };
  }
  emitProgress(options.onProgress, failed ? "OpenCode run failed." : "OpenCode run completed.", failed ? "failed" : "finalizing");

  return {
    status: failed ? 1 : 0,
    threadId: state.sessionId ?? options.resumeSessionId ?? null,
    finalMessage,
    // OpenCode streams full thinking rather than summaries; keep the rendered summary short.
    // The complete text stays in the job log.
    reasoningSummary: state.reasoningSummary.slice(-MAX_REASONING_SECTIONS).map((text) => shorten(text, MAX_REASONING_CHARS)),
    error: state.error,
    stderr: cleanStderr(stderr),
    touchedFiles: [...state.touchedFiles],
    toolCalls: state.toolCalls,
    exitCode: exit.code,
    signal: exit.signal
  };
}

export function listOpencodeSessions(cwd, options = {}) {
  const command = getOpencodeCommand(options.env);
  const result = runCommand(command, ["session", "list", "--standalone", "--format", "json", "--max-count", "50"], {
    cwd,
    env: options.env
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not list OpenCode sessions: ${result.error?.message ?? (cleanStderr(result.stderr) || `exit ${result.status}`)}`
    );
  }
  const text = result.stdout.trim();
  if (!text) {
    return [];
  }
  const sessions = JSON.parse(text);
  return Array.isArray(sessions) ? sessions : [];
}

export async function findLatestTaskThread(cwd, options = {}) {
  ensureOpencodeAvailable(cwd, { env: options.env });
  const sessions = listOpencodeSessions(cwd, options)
    .filter(
      (session) =>
        typeof session?.title === "string" &&
        session.title.startsWith(TASK_THREAD_PREFIX) &&
        (!session.directory || session.directory === cwd)
    )
    .sort((left, right) => Number(right.updated ?? 0) - Number(left.updated ?? 0));
  return sessions[0] ?? null;
}

export function buildPersistentTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractJsonCandidates(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  const candidates = [text];
  const fences = [];
  const fencePattern = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  let match;
  while ((match = fencePattern.exec(text)) !== null) {
    fences.push(match[1].trim());
  }
  // The final answer is usually the last block; earlier ones tend to be examples.
  candidates.push(...fences.reverse());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(text.slice(first, last + 1));
  }
  return candidates;
}

// OpenCode has no output-schema enforcement, so models may wrap the JSON in prose or fences.
// With `fallback.schema`, a candidate that satisfies the schema wins over one that only parses.
export function parseStructuredOutput(rawOutput, fallback = {}) {
  const { schema, ...rest } = fallback;
  fallback = rest;
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage || "OpenCode did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  let firstError = null;
  let firstParsed = null;
  for (const candidate of extractJsonCandidates(rawOutput)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      firstError ??= error;
      continue;
    }
    const schemaErrors = schema ? validateAgainstSchema(parsed, schema) : [];
    if (schemaErrors.length === 0) {
      return { parsed, parseError: null, schemaErrors, rawOutput, ...fallback };
    }
    firstParsed ??= { parsed, schemaErrors };
  }
  if (firstParsed) {
    return { ...firstParsed, parseError: null, rawOutput, ...fallback };
  }
  return {
    parsed: null,
    parseError: firstError?.message ?? "Could not parse JSON.",
    rawOutput,
    ...fallback
  };
}

function typeMatches(value, type) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

// Validates the subset of JSON Schema used by schemas/review-output.schema.json.
export function validateAgainstSchema(value, schema, at = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") {
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${at} must be ${types.join(" or ")}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  }
  if (typeof value === "string" && Number.isInteger(schema.minLength) && value.length < schema.minLength) {
    errors.push(`${at} must not be empty`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${at} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${at} must be <= ${schema.maximum}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items, `${at}[${index}]`)));
  }
  if (typeMatches(value, "object")) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        errors.push(`${at}.${key} is required`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        errors.push(...validateAgainstSchema(value[key], propertySchema, `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) {
          errors.push(`${at}.${key} is not allowed`);
        }
      }
    }
  }
  return errors;
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
