// Modified from openai/codex-plugin-cc (Apache-2.0): adapted for the Pi companion.

import fs from "node:fs";
import process from "node:process";

import { isJobCancelMarked, readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "PI_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      runnerPid: Number.isInteger(value.runnerPid) && value.runnerPid > 0 ? value.runnerPid : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    runnerPid: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastRunnerPid = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.runnerPid && normalized.runnerPid !== lastRunnerPid) {
      lastRunnerPid = normalized.runnerPid;
      patch.runnerPid = normalized.runnerPid;
      changed = true;
    }

    if (!changed) {
      return;
    }

    if (!fs.existsSync(resolveJobFile(workspaceRoot, jobId))) {
      return;
    }
    upsertJob(workspaceRoot, patch);
    if (enforceCancelMarker(workspaceRoot, jobId)) {
      // Cancelled while running: stop ourselves. The SIGTERM handler installed by the Pi
      // runner forwards the signal to its process group before exiting.
      process.kill(process.pid, "SIGTERM");
    }
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[pi] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

// Cancel and SessionEnd may finish a job while its runner is still unwinding; their state wins.
function wasCancelled(workspaceRoot, jobId) {
  if (isJobCancelMarked(workspaceRoot, jobId)) {
    return true;
  }
  const stored = readStoredJobOrNull(workspaceRoot, jobId);
  return stored?.status === "cancelled";
}

function restoreCancelledRecord(workspaceRoot, jobId, record) {
  // Keep pid/runnerPid: cancel clears them only after it confirmed the processes exited.
  const cancelled = { status: "cancelled", phase: "cancelled" };
  writeJobFile(workspaceRoot, jobId, { ...record, ...cancelled });
  upsertJob(workspaceRoot, { id: jobId, ...cancelled });
}

// Call right after any write that may carry a stale non-cancelled status. Cancel creates its
// marker before saving `cancelled`, so either cancel's save lands after our write, or the marker
// is already visible here and we put `cancelled` back ourselves.
export function enforceCancelMarker(workspaceRoot, jobId) {
  if (!isJobCancelMarked(workspaceRoot, jobId)) {
    return false;
  }
  restoreCancelledRecord(workspaceRoot, jobId, readStoredJobOrNull(workspaceRoot, jobId) ?? { id: jobId });
  return true;
}

export async function runTrackedJob(job, runner, options = {}) {
  if (wasCancelled(job.workspaceRoot, job.id)) {
    enforceCancelMarker(job.workspaceRoot, job.id);
    throw new Error(`Job ${job.id} was cancelled before it started.`);
  }
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);
  // Cancel marks the job before it looks up the pid to kill. Checking again after publishing our
  // pid closes the window: either cancel saw this pid and will stop us, or we see its marker here.
  if (isJobCancelMarked(job.workspaceRoot, job.id)) {
    // Nothing was started and this process exits right away, so its pid must not stay on record
    // where a later cancel could signal an unrelated process that reused it.
    restoreCancelledRecord(job.workspaceRoot, job.id, { ...runningRecord, pid: null, runnerPid: null });
    upsertJob(job.workspaceRoot, { id: job.id, pid: null, runnerPid: null });
    throw new Error(`Job ${job.id} was cancelled before it started.`);
  }

  try {
    const execution = await runner();
    if (wasCancelled(job.workspaceRoot, job.id)) {
      return execution;
    }
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      runnerPid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      runnerPid: null,
      completedAt
    });
    enforceCancelMarker(job.workspaceRoot, job.id);
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (wasCancelled(job.workspaceRoot, job.id)) {
      throw error;
    }
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      runnerPid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      runnerPid: null,
      errorMessage,
      completedAt
    });
    enforceCancelMarker(job.workspaceRoot, job.id);
    throw error;
  }
}
