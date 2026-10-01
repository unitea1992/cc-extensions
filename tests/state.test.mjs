import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobFile, resolveJobLogFile, resolvePluginDataDir, resolveStateDir, resolveStateFile, saveState } from "../plugins/opencode/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses this plugin's data dir when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = path.join(makeTempDir(), "opencode-cc-extensions");
  const previous = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previous == null) {
      delete process.env.OPENCODE_COMPANION_DATA;
    } else {
      process.env.OPENCODE_COMPANION_DATA = previous;
    }
  }
});

test("another plugin's CLAUDE_PLUGIN_DATA in the shared session env is ignored", () => {
  // codex-plugin-cc exports CLAUDE_PLUGIN_DATA into the same session env file.
  assert.equal(resolvePluginDataDir({ CLAUDE_PLUGIN_DATA: "/data/codex-openai-codex" }), null);
  assert.equal(resolvePluginDataDir({ CLAUDE_PLUGIN_DATA: "/data/opencode-cc-extensions" }), "/data/opencode-cc-extensions");
  assert.equal(
    resolvePluginDataDir({ CLAUDE_PLUGIN_DATA: "/data/codex-openai-codex", OPENCODE_COMPANION_DATA: "/data/opencode-cc-extensions" }),
    "/data/opencode-cc-extensions"
  );
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("a stale write after cancel is reverted to cancelled when the cancel marker exists", async () => {
  const { enforceCancelMarker } = await import("../plugins/opencode/scripts/lib/tracked-jobs.mjs");
  const { markJobCancelled, upsertJob, writeJobFile, readJobFile, loadState } = await import("../plugins/opencode/scripts/lib/state.mjs");
  const workspace = makeTempDir();
  writeJobFile(workspace, "task-x", { id: "task-x", status: "queued", pid: 42 });
  upsertJob(workspace, { id: "task-x", status: "queued", pid: 42 });

  assert.equal(enforceCancelMarker(workspace, "task-x"), false);
  markJobCancelled(workspace, "task-x");
  // A launcher that read the job before cancel finished writes its stale queued copy back.
  writeJobFile(workspace, "task-x", { id: "task-x", status: "queued", pid: 42 });
  assert.equal(enforceCancelMarker(workspace, "task-x"), true);

  assert.equal(readJobFile(resolveJobFile(workspace, "task-x")).status, "cancelled");
  assert.equal(loadState(workspace).jobs.find((job) => job.id === "task-x").status, "cancelled");
});

test("concurrent index updates from separate processes are never lost", async () => {
  const { spawn } = await import("node:child_process");
  const workspace = makeTempDir();
  const stateModule = new URL("../plugins/opencode/scripts/lib/state.mjs", import.meta.url).href;
  const script = `
    const { upsertJob } = await import(${JSON.stringify(stateModule)});
    const [workspace, worker] = process.argv.slice(1);
    for (let index = 0; index < 8; index += 1) {
      upsertJob(workspace, { id: "job-" + worker + "-" + index, status: "running" });
    }
  `;
  await Promise.all(
    Array.from({ length: 5 }, (_, worker) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, workspace, String(worker)], { stdio: "inherit" });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
      })
    )
  );
  const { loadState } = await import("../plugins/opencode/scripts/lib/state.mjs");
  assert.equal(loadState(workspace).jobs.length, 40);
});

test("readers show a marked job as cancelled even if an older index copy says running", async () => {
  const { loadState, markJobCancelled, upsertJob, writeJobFile, readJobFile } = await import("../plugins/opencode/scripts/lib/state.mjs");
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-a", status: "running", pid: 7 });
  writeJobFile(workspace, "task-a", { id: "task-a", status: "running", pid: 7 });
  markJobCancelled(workspace, "task-a");
  assert.equal(loadState(workspace).jobs[0].status, "cancelled");
  assert.equal(readJobFile(resolveJobFile(workspace, "task-a")).status, "cancelled");
});

test("the state lock is reclaimed from a dead owner but never taken from a live one", async () => {
  const { withStateLock } = await import("../plugins/opencode/scripts/lib/state.mjs");
  const { spawnSync } = await import("node:child_process");
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  // A pid that has certainly exited.
  const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, token: "dead" }));
  assert.equal(withStateLock(workspace, () => "ran"), "ran");
  assert.equal(fs.existsSync(lockFile), false);

  // A live owner (this process, other token) keeps its lock: a second process keeps waiting and is
  // killed by the timeout without ever entering the critical section.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: "someone-else" }));
  const waiter = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { withStateLock } = await import(${JSON.stringify(new URL("../plugins/opencode/scripts/lib/state.mjs", import.meta.url).href)});
       withStateLock(${JSON.stringify(workspace)}, () => console.log("acquired"));`
    ],
    { encoding: "utf8", timeout: 1000 }
  );
  assert.equal(waiter.stdout.trim(), "");
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "someone-else");
  fs.rmSync(lockFile);
});

test("readJobFileRaw keeps the real pids of a cancel-marked job for the cancel path", async () => {
  const { markJobCancelled, readJobFileRaw, writeJobFile } = await import("../plugins/opencode/scripts/lib/state.mjs");
  const workspace = makeTempDir();
  writeJobFile(workspace, "task-p", { id: "task-p", status: "running", pid: 11, runnerPid: 12 });
  markJobCancelled(workspace, "task-p");
  const raw = readJobFileRaw(resolveJobFile(workspace, "task-p"));
  assert.equal(raw.pid, 11);
  assert.equal(raw.runnerPid, 12);
});
