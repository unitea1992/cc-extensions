// Runtime for the Pi companion: each task is one `pi --print --mode json` execution.
//
// Pi has no permission system of its own. It never asks for approval and its tools run with the
// permissions of the account that started it, so there is no sandbox setting to override. A
// read-only run is therefore made by handing Pi only the tools that cannot change anything.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { binaryAvailable, runCommand, stopProcessGroup } from "./process.mjs";

export const PI_BIN_ENV = "PI_COMPANION_BIN";
export const IDLE_TIMEOUT_ENV = "PI_COMPANION_IDLE_TIMEOUT_SECONDS";
// Pi has no timeout of its own for a model that accepts the request but never answers. Pi emits an
// event per finished part, so a long tool call or reasoning block can be silent for minutes; keep
// the default generous, as local models are slow.
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TASK_THREAD_PREFIX = "Pi Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session. Pick the next highest-value step and follow through until the task is resolved.";
const MAX_REASONING_SECTIONS = 3;
const MAX_REASONING_CHARS = 400;
const EDIT_TOOLS = new Set(["edit", "write"]);

export { DEFAULT_CONTINUE_PROMPT };

export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "one `pi --print` process per run",
    detail: "Each task starts its own `pi --print --mode json` process and it exits when the run ends."
  };
}

export function getPiCommand(env = process.env) {
  return env[PI_BIN_ENV] || "pi";
}

export function getPiAvailability(cwd, options = {}) {
  const command = getPiCommand(options.env);
  const versionStatus = binaryAvailable(command, ["--version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    return versionStatus;
  }
  const help = runCommand(command, ["--help"], { cwd, env: options.env });
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (help.error || help.status !== 0 || !helpText.includes("--mode") || !helpText.includes("--print")) {
    return {
      available: false,
      detail: `${versionStatus.detail}; this Pi does not support \`--print --mode json\``
    };
  }
  return versionStatus;
}

export function ensurePiAvailable(cwd, options = {}) {
  const availability = getPiAvailability(cwd, options);
  if (!availability.available) {
    throw new Error(
      "Pi is not installed or does not support `--print --mode json`. Install it, then rerun `/pi:setup`."
    );
  }
}

export function listPiModels(cwd, options = {}) {
  const result = runCommand(getPiCommand(options.env), ["--list-models"], { cwd, env: options.env });
  if (result.error || result.status !== 0) {
    return { models: [], detail: result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`) };
  }
  const models = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [provider, model] = line.trim().split(/\s+/);
    if (!provider || !model || (provider === "provider" && model === "model")) {
      continue;
    }
    models.push(`${provider}/${model}`);
  }
  return { models, detail: null };
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

export function buildPersistentTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

export function normalizeThinkingLevel(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!THINKING_LEVELS.includes(normalized)) {
    throw new Error(`Unsupported effort "${effort}". Use one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  return normalized;
}

export function resolveIdleTimeoutMs(value, env = process.env) {
  const raw = value ?? env[IDLE_TIMEOUT_ENV];
  if (raw == null || String(raw).trim() === "") {
    return DEFAULT_IDLE_TIMEOUT_SECONDS * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid idle timeout "${raw}". Use a number of seconds, or 0 to disable.`);
  }
  return Math.round(seconds * 1000);
}

function describeIdleTimeout(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}

export function buildRunArgs(options = {}) {
  const args = ["--print", "--mode", "json"];
  if (options.readOnly !== false) {
    args.push("--tools", READ_ONLY_TOOLS.join(","));
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  const thinking = normalizeThinkingLevel(options.effort);
  if (thinking) {
    args.push("--thinking", thinking);
  }
  if (options.resumeSessionId) {
    args.push("--session", options.resumeSessionId);
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId, "--name", options.title ?? TASK_THREAD_PREFIX);
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

function emitLogEvent(onProgress, options = {}) {
  onProgress?.({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    String(command ?? "")
  );
}

function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function thinkingOf(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part?.type === "thinking" && typeof part.thinking === "string")
    .map((part) => part.thinking)
    .join("\n");
}

export function createRunState(options = {}) {
  return {
    sessionId: options.sessionId ?? null,
    finalMessage: "",
    reasoningSummary: [],
    toolCalls: [],
    touchedFiles: new Set(),
    error: null,
    settled: false,
    onProgress: options.onProgress ?? null
  };
}

function describeToolEnd(event) {
  const tool = event.toolName ?? "tool";
  const args = event.args ?? {};
  const failed = Boolean(event.isError);
  if (tool === "bash") {
    const command = shorten(args.command, 96);
    const phase = looksLikeVerificationCommand(args.command) ? "verifying" : "running";
    return { message: `Command ${failed ? "failed" : "completed"}: ${command}`, phase };
  }
  const target = args.path ?? args.file_path ?? args.filePath ?? args.pattern ?? null;
  if (EDIT_TOOLS.has(tool)) {
    return {
      message: `File change ${failed ? "failed" : "applied"}${target ? `: ${target}` : "."}`,
      phase: "editing"
    };
  }
  return {
    message: `Tool ${tool} ${failed ? "failed" : "completed"}${target ? `: ${shorten(target, 96)}` : "."}`,
    phase: "investigating"
  };
}

export function applyRunEvent(state, event) {
  if (!event || typeof event !== "object") {
    return;
  }
  switch (event.type) {
    case "session":
      if (typeof event.id === "string" && event.id && state.sessionId !== event.id) {
        state.sessionId = event.id;
        emitProgress(state.onProgress, `Session ready (${event.id}).`, "starting", { threadId: event.id });
      }
      break;
    case "tool_execution_start":
      state.pendingTools ??= new Map();
      state.pendingTools.set(event.toolCallId, event.args ?? {});
      break;
    case "tool_execution_end": {
      const args = state.pendingTools?.get(event.toolCallId) ?? event.args ?? {};
      state.pendingTools?.delete(event.toolCallId);
      const call = { tool: event.toolName ?? null, status: event.isError ? "error" : "completed", input: args };
      state.toolCalls.push(call);
      const target = args.path ?? args.file_path ?? args.filePath ?? null;
      if (EDIT_TOOLS.has(event.toolName) && !event.isError && typeof target === "string") {
        state.touchedFiles.add(target);
      }
      const described = describeToolEnd({ ...event, args });
      emitLogEvent(state.onProgress, described);
      break;
    }
    case "message_end": {
      const message = event.message;
      if (message?.role !== "assistant") {
        break;
      }
      const thinking = thinkingOf(message.content).replace(/\s+/g, " ").trim();
      if (thinking && !state.reasoningSummary.includes(thinking)) {
        state.reasoningSummary.push(thinking);
        emitLogEvent(state.onProgress, {
          message: `Reasoning captured: ${shorten(thinking, 96)}`,
          logTitle: "Reasoning",
          logBody: `- ${thinking}`
        });
      }
      const text = textOf(message.content);
      if (text) {
        // Tool-calling turns also carry text; the last assistant message with text is the answer.
        state.finalMessage = text;
        emitLogEvent(state.onProgress, {
          message: `Assistant message captured: ${shorten(text, 96)}`,
          logTitle: "Assistant message",
          logBody: text
        });
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        state.error = { message: message.errorMessage || `Pi stopped the response (${message.stopReason}).` };
      }
      break;
    }
    case "agent_settled":
      state.settled = true;
      break;
    default:
      break;
  }
}

async function runAttempt({ cwd, args, env, prompt, state, options, idleTimeoutMs }) {
  const child = spawn(getPiCommand(env), args, {
    cwd,
    env,
    // Own process group so cancellation can stop Pi together with the commands it started.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  // The child runs in its own process group, so signals sent to this process do not reach it.
  // Forward termination explicitly so an interrupted companion never leaves Pi running.
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
    emitProgress(options.onProgress, `Pi process started (pid ${child.pid}).`, "starting", {
      runnerPid: child.pid
    });
  }

  let stderr = "";
  let buffer = "";
  const unparsedLines = [];

  let idleTimer = null;
  let idleError = null;
  const armIdleTimer = () => {
    if (!idleTimeoutMs || idleError) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleError = {
        message:
          `Pi produced no output for ${describeIdleTimeout(idleTimeoutMs)}, so the run was stopped. ` +
          `Check that ${options.model ?? "the default model"} is loaded and answering requests, then retry. ` +
          `Raise the limit with --idle-timeout <seconds> if the model is just slow.`
      };
      emitProgress(options.onProgress, `Pi idle timeout: ${idleError.message}`, "failed");
      stopChild("SIGINT");
    }, idleTimeoutMs);
  };
  armIdleTimer();

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
    armIdleTimer();
    buffer += chunk;
    // JSONL framing: records end at LF only.
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

  // The prompt goes through stdin so long instructions never hit command-line length limits.
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  clearTimeout(idleTimer);
  if (idleError) {
    state.error = idleError;
  }
  process.off("exit", stopChild);
  for (const signal of forwardedSignals) {
    process.off(signal, onSignal);
  }
  if (buffer.trim()) {
    handleLine(buffer);
  }
  return { exit, stderr, unparsedLines };
}

export async function runPiTurn(cwd, options = {}) {
  ensurePiAvailable(cwd, { env: options.env });

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Pi run.");
  }

  const readOnly = options.readOnly !== false;
  // A new session gets an id of our own, so it can be resumed later without listing sessions.
  const sessionId = options.resumeSessionId ? null : randomUUID();
  const args = buildRunArgs({ ...options, readOnly, sessionId });
  const baseEnv = options.env ?? process.env;
  const idleTimeoutMs = resolveIdleTimeoutMs(options.idleTimeoutSeconds, baseEnv);

  const state = createRunState({ onProgress: options.onProgress, sessionId: null });
  emitProgress(
    options.onProgress,
    options.resumeSessionId
      ? `Resuming Pi session ${options.resumeSessionId}.`
      : `Starting Pi ${readOnly ? "read-only" : "write-capable"} run.`,
    "starting"
  );

  const result = await runAttempt({ cwd, args, env: { ...baseEnv }, prompt, state, options, idleTimeoutMs });
  const { exit, stderr, unparsedLines } = result;
  if (exit.error) {
    throw exit.error;
  }

  const failed = exit.code !== 0 || Boolean(state.error);
  if (!state.error && failed) {
    const detail = cleanStderr(stderr) || unparsedLines.join("\n");
    state.error = {
      message: exit.signal
        ? `Pi was stopped by ${exit.signal}.`
        : `Pi exited with status ${exit.code}${detail ? `: ${shorten(detail, 400)}` : "."}`
    };
  }
  emitProgress(options.onProgress, failed ? "Pi run failed." : "Pi run completed.", failed ? "failed" : "finalizing");

  return {
    status: failed ? 1 : 0,
    threadId: state.sessionId ?? options.resumeSessionId ?? sessionId,
    finalMessage: state.finalMessage,
    reasoningSummary: state.reasoningSummary.slice(-MAX_REASONING_SECTIONS).map((text) => shorten(text, MAX_REASONING_CHARS)),
    error: state.error,
    stderr: cleanStderr(stderr),
    touchedFiles: [...state.touchedFiles],
    toolCalls: state.toolCalls,
    exitCode: exit.code,
    signal: exit.signal
  };
}
