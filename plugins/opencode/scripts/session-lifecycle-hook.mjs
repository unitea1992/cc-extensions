#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

// Modified from openai/codex-plugin-cc (Apache-2.0): there is no shared broker to tear down,
// so SessionEnd only stops this session's running OpenCode jobs.

import { stopProcessGroup } from "./lib/process.mjs";
import {
  COMPANION_DATA_ENV,
  loadState,
  markJobCancelled,
  readJobFileRaw,
  removeJobArtifacts,
  removeLegacySessionJobs,
  resolveJobFile
} from "./lib/state.mjs";
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
    // Mark first so a worker that is just starting stops on its own, then stop what is running.
    markJobCancelled(workspaceRoot, job.id);
    const raw = fs.existsSync(resolveJobFile(workspaceRoot, job.id)) ? readJobFileRaw(resolveJobFile(workspaceRoot, job.id)) : job;
    for (const pid of [raw.pid ?? job.pid, raw.runnerPid ?? job.runnerPid]) {
      try {
        stopProcessGroup(pid ?? Number.NaN);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }
  }

  // Jobs live in their own files, so removing this session's files cannot touch other sessions.
  for (const job of removedJobs) {
    removeJobArtifacts(workspaceRoot, job);
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
