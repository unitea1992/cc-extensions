// Modified from openai/codex-plugin-cc (Apache-2.0): adapted for the Pi companion.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
export const COMPANION_DATA_ENV = "PI_COMPANION_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "pi-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

// Workers, cancel, and hooks run as separate processes; write through a rename so a reader never
// sees a half-written JSON file.
function writeJsonAtomic(filePath, value) {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
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
// shared one only when it points at this plugin's data directory (named "pi-<marketplace>").
export function resolvePluginDataDir(env = process.env) {
  if (env[COMPANION_DATA_ENV]) {
    return env[COMPANION_DATA_ENV];
  }
  const shared = env[PLUGIN_DATA_ENV];
  if (shared && path.basename(path.resolve(shared)).startsWith("pi-")) {
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
// cancelled job as queued or running even if a worker persisted an older copy after the cancel.
function applyCancelMarker(cwd, job) {
  if (!job?.id || job.status === "cancelled" || !fs.existsSync(path.join(resolveJobsDir(cwd), `${job.id}.cancelled`))) {
    return job;
  }
  return markedCancelled(job);
}

// The pids are kept on purpose: they are only cleared by a cancel that confirmed the processes
// exited, so a process that slipped past one cancel can still be found and stopped by the next.
function markedCancelled(job) {
  return {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    errorMessage: job.errorMessage ?? "Cancelled by user."
  };
}

function readStateFile(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Each job lives in its own jobs/<id>.json, written atomically. There is no shared job index to
// read-modify-write, so concurrent workers, cancels, and hooks can never overwrite each other's
// jobs. state.json only holds the configuration (and is read for jobs written by older versions).
function listJobFiles(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) {
    return [];
  }
  const jobs = [];
  for (const name of fs.readdirSync(jobsDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      jobs.push(readJobFile(path.join(jobsDir, name)));
    } catch {
      // Ignore a file that vanished or is unreadable; atomic writes never leave partial JSON.
    }
  }
  return jobs;
}

export function loadState(cwd) {
  const parsed = readStateFile(cwd);
  // Older versions split each job between an index entry in state.json and its job file; merge
  // both so jobs recorded before an upgrade keep every field. The job file is newer and wins.
  const legacyById = new Map(
    (Array.isArray(parsed.jobs) ? parsed.jobs : []).filter((job) => job?.id).map((job) => [job.id, job])
  );
  const jobs = listJobFiles(cwd).map((job) => {
    const legacy = legacyById.get(job.id);
    legacyById.delete(job.id);
    return legacy ? applyCancelMarker(cwd, { ...legacy, ...job }) : job;
  });
  for (const legacy of legacyById.values()) {
    jobs.push(applyCancelMarker(cwd, legacy));
  }
  return {
    ...defaultState(),
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    jobs
  };
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already removed by another process.
    }
  }
}

// `keepCancelMarker` leaves the marker as a tombstone so a worker that is just starting cannot
// recreate and run a job whose session already ended.
export function removeJobArtifacts(cwd, job, options = {}) {
  removeFileIfExists(resolveJobFile(cwd, job.id));
  removeFileIfExists(job.logFile);
  if (!options.keepCancelMarker) {
    removeFileIfExists(resolveCancelMarkerFile(cwd, job.id));
  }
}

const TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pruneOrphanCancelMarkers(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  for (const name of fs.readdirSync(jobsDir)) {
    if (!name.endsWith(".cancelled")) {
      continue;
    }
    const marker = path.join(jobsDir, name);
    try {
      const orphan = !fs.existsSync(marker.replace(/\.cancelled$/, ".json"));
      if (orphan && Date.now() - fs.statSync(marker).mtimeMs > TOMBSTONE_MAX_AGE_MS) {
        fs.unlinkSync(marker);
      }
    } catch {
      // Removed concurrently.
    }
  }
}

// Keep the newest MAX_JOBS jobs. Active jobs are never pruned.
function pruneJobs(cwd) {
  const jobs = listJobFiles(cwd).sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  for (const job of jobs.slice(MAX_JOBS)) {
    if (job.status !== "queued" && job.status !== "running") {
      removeJobArtifacts(cwd, job);
    }
  }
  pruneOrphanCancelMarkers(cwd);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  const jobFile = resolveJobFile(cwd, jobPatch.id);
  const existing = fs.existsSync(jobFile) ? readJobFileRaw(jobFile) : null;
  const timestamp = nowIso();
  const next = existing
    ? { ...existing, ...jobPatch, updatedAt: timestamp }
    : { createdAt: timestamp, ...jobPatch, updatedAt: timestamp };
  writeJsonAtomic(jobFile, next);
  if (!existing) {
    pruneJobs(cwd);
  }
  return next;
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

// Only `setup` writes the configuration, so a plain atomic rewrite is enough here.
export function setConfig(cwd, key, value) {
  ensureStateDir(cwd);
  const parsed = readStateFile(cwd);
  const next = {
    ...parsed,
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {}),
      [key]: value
    }
  };
  writeJsonAtomic(resolveStateFile(cwd), next);
  return next;
}

// Older versions kept jobs in state.json; drop a finished session's entries from there too.
export function removeLegacySessionJobs(cwd, sessionId) {
  const parsed = readStateFile(cwd);
  if (!Array.isArray(parsed.jobs) || !parsed.jobs.some((job) => job?.sessionId === sessionId)) {
    return;
  }
  writeJsonAtomic(resolveStateFile(cwd), { ...parsed, jobs: parsed.jobs.filter((job) => job?.sessionId !== sessionId) });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonAtomic(jobFile, { ...payload, id: payload.id ?? jobId, updatedAt: nowIso() });
  return jobFile;
}

// Returns the record exactly as stored, without applying a cancel marker. Cancel needs the real
// pids even after it has marked the job.
export function readJobFileRaw(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function readJobFile(jobFile) {
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const marker = jobFile.replace(/\.json$/, ".cancelled");
  if (job?.status !== "cancelled" && marker !== jobFile && fs.existsSync(marker)) {
    return markedCancelled(job);
  }
  return job;
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
