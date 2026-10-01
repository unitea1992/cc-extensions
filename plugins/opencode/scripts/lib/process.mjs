// Modified from openai/codex-plugin-cc (Apache-2.0): adapted for the OpenCode companion.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    // A foreground companion started from a shell is not a group leader, so `kill(-pid)` reports
    // ESRCH even though the process is alive. Fall back to signalling the pid itself.
    try {
      killImpl(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "process" };
    } catch (innerError) {
      if (innerError?.code === "ESRCH") {
        return { attempted: true, delivered: false, method: "process-group" };
      }
      throw innerError;
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Linux, read /proc so exited-but-unreaped (zombie) processes count as stopped: they hold no
// resources and cannot run anything, but `kill(pid, 0)` still succeeds for them.
function linuxGroupAlive(pid) {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
    // Fields after the parenthesized command: state ppid pgrp ...
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const pgrp = Number(fields[2]);
    if ((Number(entry) === pid || pgrp === pid) && state !== "Z" && state !== "X") {
      return true;
    }
  }
  return false;
}

function isAlive(pid, killImpl, platform, useProc) {
  if (platform === "linux" && useProc) {
    const alive = linuxGroupAlive(pid);
    if (alive !== null) {
      return alive;
    }
  }
  for (const target of [-pid, pid]) {
    try {
      killImpl(target, 0);
      return true;
    } catch (error) {
      if (error?.code === "EPERM") {
        return true;
      }
    }
  }
  return false;
}

// SIGTERM, wait for the process (group) to go away, and escalate to SIGKILL if it does not.
// A delivered SIGTERM alone does not prove anything stopped: OpenCode or a command it started can
// handle or ignore the signal.
// Returns null when the process does not exist (or is a zombie with an empty command line).
function readCommandLine(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline ? cmdline : null;
  } catch {
    return null;
  }
}

export function stopProcessGroup(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, stopped: true, forced: false };
  }
  const platform = options.platform ?? process.platform;
  // A stored pid can outlive its process and be reused by the OS. When the caller says what the
  // process should be, skip anything that is no longer it.
  if (options.expectCommand && platform === "linux" && !options.killImpl) {
    const leader = readCommandLine(pid);
    if (leader !== null && !leader.includes(options.expectCommand)) {
      // The pid is alive but now runs something else: it was reused.
      return { attempted: false, stopped: true, forced: false, skipped: "pid no longer belongs to this job" };
    }
    // `null` means /proc could not be scanned; then fall through and signal rather than assume.
    if (leader === null && linuxGroupAlive(pid) === false) {
      return { attempted: false, stopped: true, forced: false };
    }
    // Otherwise the leader is ours, or it exited while children remain in its group. Linux does
    // not hand out a pid that is still in use as a process group id, so signalling the group is
    // safe in both cases.
  }
  const killImpl = options.killImpl ?? process.kill.bind(process);
  // Injected kill functions (tests) describe liveness themselves; do not consult /proc then.
  const useProc = !options.killImpl;
  const first = terminateProcessTree(pid, options);
  if (!first.delivered || platform === "win32") {
    // Already gone, or taskkill /T /F which is forceful by itself.
    return { attempted: true, stopped: true, forced: false };
  }
  const waitUntilGone = (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid, killImpl, platform, useProc)) {
      if (Date.now() >= deadline) {
        return false;
      }
      sleepSync(50);
    }
    return true;
  };
  if (waitUntilGone(options.graceMs ?? 3000)) {
    return { attempted: true, stopped: true, forced: false };
  }
  for (const target of [-pid, pid]) {
    try {
      killImpl(target, "SIGKILL");
    } catch {
      // Gone in the meantime.
    }
  }
  return { attempted: true, stopped: waitUntilGone(options.killWaitMs ?? 2000), forced: true };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
