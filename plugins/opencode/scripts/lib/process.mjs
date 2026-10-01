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
  return stopProcessGroups([pid], options)[0];
}

// Stops several process groups with one shared grace period: SIGTERM all of them, wait once,
// then SIGKILL every survivor. The total time stays bounded by graceMs + killWaitMs no matter how
// many groups there are, which matters inside hooks with a hard time limit.
export function stopProcessGroups(pids, options = {}) {
  const platform = options.platform ?? process.platform;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  // Injected kill functions (tests) describe liveness themselves; do not consult /proc then.
  const useProc = !options.killImpl;
  const results = pids.map(() => ({ attempted: false, stopped: true, forced: false }));
  const pending = [];

  pids.forEach((pid, index) => {
    if (!Number.isFinite(pid)) {
      return;
    }
    // A stored pid can outlive its process and be reused by the OS. When the caller says what the
    // process should be, skip anything that is no longer it.
    if (options.expectCommand && platform === "linux" && useProc) {
      const leader = readCommandLine(pid);
      if (leader !== null && !leader.includes(options.expectCommand)) {
        results[index] = { attempted: false, stopped: true, forced: false, skipped: "pid no longer belongs to this job" };
        return;
      }
      // `null` means /proc could not be scanned; then fall through and signal rather than assume.
      if (leader === null && linuxGroupAlive(pid) === false) {
        return;
      }
      // Otherwise the leader is ours, or it exited while children remain in its group. Linux does
      // not hand out a pid that is still in use as a process group id, so signalling the group is
      // safe in both cases.
    }
    const first = terminateProcessTree(pid, options);
    results[index] = { attempted: true, stopped: true, forced: false };
    // Not delivered means already gone; on Windows taskkill /T /F is forceful by itself.
    if (first.delivered && platform !== "win32") {
      pending.push(index);
    }
  });

  const waitUntilGone = (indexes, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let alive = indexes;
    for (;;) {
      alive = alive.filter((index) => isAlive(pids[index], killImpl, platform, useProc));
      if (alive.length === 0 || Date.now() >= deadline) {
        return alive;
      }
      sleepSync(50);
    }
  };

  const survivors = waitUntilGone(pending, options.graceMs ?? 3000);
  for (const index of survivors) {
    results[index].forced = true;
    for (const target of [-pids[index], pids[index]]) {
      try {
        killImpl(target, "SIGKILL");
      } catch {
        // Gone in the meantime.
      }
    }
  }
  for (const index of waitUntilGone(survivors, options.killWaitMs ?? 2000)) {
    results[index].stopped = false;
  }
  return results;
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
