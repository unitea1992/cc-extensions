#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

// Modified from openai/codex-plugin-cc (Apache-2.0): there is no shared broker to tear down,
// so SessionEnd only stops this session's running OpenCode jobs.

import { terminateProcessTree } from "./lib/process.mjs";
import { COMPANION_DATA_ENV, loadState, resolveStateFile, updateState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";
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

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    for (const pid of [job.pid, job.runnerPid]) {
      try {
        terminateProcessTree(pid ?? Number.NaN);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }
  }

  // Re-read under the lock so jobs added or updated meanwhile by other sessions are kept.
  updateState(workspaceRoot, (latest) => {
    latest.jobs = latest.jobs.filter((job) => job.sessionId !== sessionId);
  });
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
