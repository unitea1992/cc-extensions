import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveJobFile, resolveJobLogFile, resolvePluginDataDir, resolveStateDir, resolveStateFile, upsertJob, writeJobFile } from "../plugins/opencode/scripts/lib/state.mjs";

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

test("creating a job prunes the oldest finished jobs beyond the cap and keeps active ones", () => {
  const workspace = makeTempDir();
  const total = 53;
  for (let index = 0; index < total; index += 1) {
    const id = `job-${String(index).padStart(2, "0")}`;
    const logFile = resolveJobLogFile(workspace, id);
    fs.writeFileSync(logFile, "log\n");
    // job-00 stays running even though it is the oldest.
    writeJobFile(workspace, id, { id, status: index === 0 ? "running" : "completed", logFile });
  }
  upsertJob(workspace, { id: "job-new", status: "queued" });

  const remaining = fs.readdirSync(path.dirname(resolveJobFile(workspace, "job-new"))).filter((name) => name.endsWith(".json"));
  assert.equal(remaining.includes("job-00.json"), true, "an active job is never pruned");
  assert.equal(remaining.includes("job-new.json"), true);
  assert.equal(remaining.length, 51);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-01")), false, "pruned jobs lose their log too");
});

test("config updates keep jobs written by older versions in state.json", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [{ id: "old", status: "completed" }] }));
  return import("../plugins/opencode/scripts/lib/state.mjs").then(({ setConfig, loadState }) => {
    setConfig(workspace, "stopReviewGate", true);
    const state = loadState(workspace);
    assert.equal(state.config.stopReviewGate, true);
    assert.deepEqual(state.jobs.map((job) => job.id), ["old"]);
  });
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

test("concurrent job updates from separate processes are never lost", async () => {
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

test("readers show a marked job as cancelled even if a later write says running", async () => {
  const { loadState, markJobCancelled, upsertJob, writeJobFile, readJobFile } = await import("../plugins/opencode/scripts/lib/state.mjs");
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-a", status: "running", pid: 7 });
  writeJobFile(workspace, "task-a", { id: "task-a", status: "running", pid: 7 });
  markJobCancelled(workspace, "task-a");
  assert.equal(loadState(workspace).jobs[0].status, "cancelled");
  assert.equal(readJobFile(resolveJobFile(workspace, "task-a")).status, "cancelled");
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

test("enforcing a cancel marker keeps the pids so cancel can still stop those processes", async () => {
  const { enforceCancelMarker } = await import("../plugins/opencode/scripts/lib/tracked-jobs.mjs");
  const { markJobCancelled, readJobFileRaw } = await import("../plugins/opencode/scripts/lib/state.mjs");
  const workspace = makeTempDir();
  writeJobFile(workspace, "task-k", { id: "task-k", status: "running", pid: 21, runnerPid: 22 });
  markJobCancelled(workspace, "task-k");
  assert.equal(enforceCancelMarker(workspace, "task-k"), true);
  const raw = readJobFileRaw(resolveJobFile(workspace, "task-k"));
  assert.equal(raw.status, "cancelled");
  assert.equal(raw.pid, 21);
  assert.equal(raw.runnerPid, 22);
});
