// Modified from openai/codex-plugin-cc (Apache-2.0): adapted for the OpenCode companion.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
export const COMPANION_DATA_ENV = "OPENCODE_COMPANION_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "opencode-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

// Workers, cancel, and hooks run as separate processes; write through a rename so a reader never
// sees a half-written JSON file.
function writeJsonAtomic(filePath, value) {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = resolvePluginDataDir(process.env);
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

// CLAUDE_PLUGIN_DATA is only reliable inside this plugin's own hooks. In Bash commands it comes
// from the shared session env file, where another plugin (codex-plugin-cc exports the same name)
// may have written its own directory. Prefer the companion-specific variable, and accept the
// shared one only when it points at this plugin's data directory (named "opencode-<marketplace>").
export function resolvePluginDataDir(env = process.env) {
  if (env[COMPANION_DATA_ENV]) {
    return env[COMPANION_DATA_ENV];
  }
  const shared = env[PLUGIN_DATA_ENV];
  if (shared && path.basename(path.resolve(shared)).startsWith("opencode")) {
    return shared;
  }
  return null;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

// A cancel marker always wins over whatever status a job record carries, so readers never show a
// cancelled job as queued or running even if some writer persisted an older copy.
function applyCancelMarker(cwd, job) {
  if (!job?.id || job.status === "cancelled" || !fs.existsSync(path.join(resolveJobsDir(cwd), `${job.id}.cancelled`))) {
    return job;
  }
  return { ...job, status: "cancelled", phase: "cancelled", pid: null, runnerPid: null };
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map((job) => applyCancelMarker(cwd, job)) : []
    };
  } catch {
    return defaultState();
  }
}

const LOCK_DIR_NAME = "state.lock";
const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 10000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Workers, cancel, setup, and hooks all rewrite the shared index; serialize every
// read-modify-write so one process can never write back a stale copy over another's update.
export function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockDir = path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the companion state lock at ${lockDir}.`);
      }
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
    removeFileIfExists(resolveCancelMarkerFile(cwd, job.id));
  }

  writeJsonAtomic(resolveStateFile(cwd), nextState);
  return nextState;
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonAtomic(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile) {
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const marker = jobFile.replace(/\.json$/, ".cancelled");
  if (job?.status !== "cancelled" && marker !== jobFile && fs.existsSync(marker)) {
    return { ...job, status: "cancelled", phase: "cancelled", pid: null, runnerPid: null };
  }
  return job;
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

// Cancellation is recorded in its own marker file because job JSON files are rewritten by the
// worker; a marker can only be created, so a later status write can never erase a cancel.
export function resolveCancelMarkerFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.cancelled`);
}

export function markJobCancelled(cwd, jobId) {
  fs.writeFileSync(resolveCancelMarkerFile(cwd, jobId), `${new Date().toISOString()}\n`, "utf8");
}

export function isJobCancelMarked(cwd, jobId) {
  return fs.existsSync(resolveCancelMarkerFile(cwd, jobId));
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
