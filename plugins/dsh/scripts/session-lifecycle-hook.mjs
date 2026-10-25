#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

// Modified from openai/codex-plugin-cc (Apache-2.0): there is no shared broker to tear down,
// so SessionEnd only stops this session's running DSH jobs.

import { stopProcessGroups } from "./lib/process.mjs";
import {
  COMPANION_DATA_ENV,
  loadState,
  markJobCancelled,
  readJobFileRaw,
  removeJobArtifacts,
  removeLegacySessionJobs,
  resolveJobFile,
  upsertJob
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "DSH_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

// The companion worker (node dsh-companion.mjs) and the DSH runner it started carry different
// command names, so each process group is matched against its own expected command. The runner's
// name is the one it was actually started with (a DSH_COMPANION_BIN replacement may not be
// called `dst`), so each distinct recorded command gets one shared stop call.
function stopSessionProcesses(targets) {
  const workerPids = targets.map((target) => target.pid ?? Number.NaN);
  const runnerEntries = targets.map((target) => ({
    pid: target.runnerPid ?? Number.NaN,
    command: target.runnerCommand || "dst"
  }));
  let workerResults = workerPids.map(() => ({ stopped: false }));
  let runnerResults = runnerEntries.map(() => ({ stopped: true }));
  try {
    workerResults = stopProcessGroups(workerPids, { expectCommand: "dsh-companion", graceMs: 1500, killWaitMs: 1500 });
    runnerResults = stopSessionRunners(runnerEntries);
  } catch {
    // Treat as not stopped; the records below are kept so the processes can still be found.
    workerResults = workerPids.map(() => ({ stopped: false }));
    runnerResults = runnerEntries.map(() => ({ stopped: false }));
  }
  return targets.map((_, index) => ({
    workerStopped: workerResults[index].stopped,
    runnerStopped: runnerResults[index].stopped
  }));
}

// Stops every distinct runner command with one shared grace period each, so the total time stays
// bounded no matter how many groups there are. Entries without a pid are already gone.
function stopSessionRunners(runnerEntries) {
  const results = runnerEntries.map(() => ({ attempted: false, stopped: true, forced: false }));
  const byCommand = new Map();
  runnerEntries.forEach((entry, index) => {
    if (!Number.isFinite(entry.pid)) {
      return;
    }
    if (!byCommand.has(entry.command)) {
      byCommand.set(entry.command, []);
    }
    byCommand.get(entry.command).push(index);
  });
  for (const [command, indexes] of byCommand) {
    const stopped = stopProcessGroups(
      indexes.map((index) => runnerEntries[index].pid),
      { expectCommand: command, graceMs: 1500, killWaitMs: 1500 }
    );
    indexes.forEach((targetIndex, position) => {
      results[targetIndex] = stopped[position];
    });
  }
  return results;
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  // Mark every active job first, then read the pids, mirroring the companion's cancel: a worker
  // that starts concurrently either publishes its pid before the read (and is stopped below) or
  // sees the marker and stops itself. Reading the pids first would miss a pid published in the
  // gap and leave its runner running. The hook has a hard time limit (hooks.json), so the stop
  // uses one shared grace period per command instead of waiting on each job in turn. Cancelled
  // jobs that still hold pids (a process survived an earlier cancel) are stopped again too.
  for (const job of removedJobs) {
    if (job.status === "queued" || job.status === "running") {
      markJobCancelled(workspaceRoot, job.id);
    }
  }

  const targets = [];
  for (const job of removedJobs) {
    const jobFile = resolveJobFile(workspaceRoot, job.id);
    const raw = fs.existsSync(jobFile) ? readJobFileRaw(jobFile) : job;
    const active = job.status === "queued" || job.status === "running";
    const pid = raw.pid ?? job.pid ?? null;
    const runnerPid = raw.runnerPid ?? job.runnerPid ?? null;
    if (!active && !pid && !runnerPid) {
      continue;
    }
    targets.push({ job, pid, runnerPid, runnerCommand: raw.runnerCommand ?? job.runnerCommand ?? null });
  }

  const stopped = stopSessionProcesses(targets);

  // Jobs live in their own files, so removing this session's files cannot touch other sessions.
  // A job with a process that did not exit keeps its record and pids for a later cancel.
  const survivors = new Set();
  targets.forEach((target, index) => {
    const { workerStopped, runnerStopped } = stopped[index];
    if (!workerStopped || !runnerStopped) {
      survivors.add(target.job.id);
      upsertJob(workspaceRoot, {
        id: target.job.id,
        status: "cancelled",
        phase: "cancelled",
        pid: workerStopped ? null : target.pid,
        runnerPid: runnerStopped ? null : target.runnerPid,
        errorMessage: "The Claude session ended, but a process did not exit. Run /dsh:cancel with this job id."
      });
    }
  });
  for (const job of removedJobs) {
    if (!survivors.has(job.id)) {
      removeJobArtifacts(workspaceRoot, job, { keepCancelMarker: true });
    }
  }
  removeLegacySessionJobs(workspaceRoot, sessionId);
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  // Export under a companion-specific name: writing CLAUDE_PLUGIN_DATA to the shared env file
  // would redirect other plugins that read the same variable (and vice versa).
  appendEnvVar(COMPANION_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
