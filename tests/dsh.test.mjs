import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildDstEnv, FAKE_DST_MODELS, installFakeDst, readFakeDstState } from "./fake-dst-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveCancelMarkerFile, resolveStateDir } from "../plugins/dsh/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "dsh");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "dsh-companion.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const AGENT_MODEL_PATCH = path.join(PLUGIN_ROOT, "scripts", "patches", "agent-model.yml");

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

// Zombies still answer kill(pid, 0) on Linux, so read /proc and count only live states as alive.
function pidGone(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return true;
  }
  if (process.platform !== "linux") {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state === "Z" || state === "X";
  } catch {
    return true;
  }
}

function killProcessGroupBestEffort(pid) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// Launches a background task and resolves once its dst runner is up, so cancel and SessionEnd
// tests always act on a job with a recorded runner pid.
async function launchRunningBackgroundTask({ repo, env, prompt = "keep running" }) {
  const launch = run(
    "node",
    [SCRIPT, "task", "--background", "--write", "--model", "logfare/glm-5.3", "--json", prompt],
    { cwd: repo, env }
  );
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  const runnerPid = await waitFor(() => {
    const status = run("node", [SCRIPT, "status", jobId, "--json"], { cwd: repo, env });
    assert.equal(status.status, 0, status.stderr);
    const job = JSON.parse(status.stdout).job;
    return job.status === "running" && job.runnerPid ? job.runnerPid : null;
  });
  return { jobId, runnerPid };
}

function setup(behavior = "ok", options = {}) {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeDst(binDir, behavior, { name: options.dstName ?? "dst" });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildDstEnv(binDir);
  if (options.dstName && options.dstName !== "dst") {
    env.DSH_COMPANION_BIN = path.join(binDir, options.dstName);
  }
  return { repo, binDir, env };
}

function option(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

function patchesOf(argv) {
  return argv.filter((value, index) => index > 0 && argv[index - 1] === "--patch");
}

test("setup reports the dst version and models", () => {
  const { repo, env } = setup();
  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.dst.available, true);
  assert.deepEqual(report.models.available, FAKE_DST_MODELS);
});

test("setup falls back to the headless defaults when the dsh-tui profile is missing", () => {
  const { repo, env } = setup("no-profile");
  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.deepEqual(report.models.available, FAKE_DST_MODELS);
  assert.match(report.models.detail, /headless defaults/);
});

test("setup says DSH is unavailable when the command is missing", () => {
  const { repo, env } = setup();
  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env: { ...env, DSH_COMPANION_BIN: path.join(repo, "no-such-dst") }
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.dst.available, false);
  assert.ok(report.nextSteps.length > 0);
});

test("a task sends the prompt on stdin and routes the model through the bundled patch", () => {
  const { repo, binDir, env } = setup();
  const result = run(
    "node",
    [SCRIPT, "task", "--write", "--model", "logfare/glm-5.3-flash", "--effort", "low", "diagnose the failing test"],
    { cwd: repo, env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\n");

  const [runState] = readFakeDstState(binDir).runs;
  assert.deepEqual(runState.argv.slice(0, 2), ["run", "--json"]);
  // The model and effort go through the bundled overlay patch and its environment variables; the
  // --provider/--model flags would drop the effort, so they must never appear.
  assert.deepEqual(patchesOf(runState.argv), [AGENT_MODEL_PATCH]);
  assert.equal(runState.launch.provider, "logfare");
  assert.equal(runState.launch.model, "glm-5.3-flash");
  assert.equal(runState.launch.effort, "low");
  assert.equal(option(runState.argv, "--provider"), null);
  assert.equal(option(runState.argv, "--model"), null);
  // Only the prompt reaches dst, on stdin; the command line stays short.
  assert.equal(runState.prompt, "diagnose the failing test");
  assert.ok(runState.argv.every((arg) => arg !== "diagnose the failing test"));
});

test("a model id may contain slashes itself", () => {
  const { repo, binDir, env } = setup();
  const result = run(
    "node",
    [SCRIPT, "task", "--write", "--model", "openrouter/minimax/m3.1:free", "refactor"],
    { cwd: repo, env }
  );
  assert.equal(result.status, 0, result.stderr);
  const [runState] = readFakeDstState(binDir).runs;
  assert.equal(runState.launch.provider, "openrouter");
  assert.equal(runState.launch.model, "minimax/m3.1:free");
});

test("a task without a model runs DSH's own default model and no agent-model patch", () => {
  const { repo, binDir, env } = setup();
  const result = run("node", [SCRIPT, "task", "--write", "diagnose"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const [runState] = readFakeDstState(binDir).runs;
  assert.deepEqual(patchesOf(runState.argv), []);
  assert.equal(runState.launch.provider, null);
  assert.equal(runState.launch.model, null);
  assert.equal(runState.launch.effort, null);
});

test("the environment route is used when --model is omitted", () => {
  const { repo, binDir, env } = setup();
  const result = run("node", [SCRIPT, "task", "--write", "diagnose"], {
    cwd: repo,
    env: buildDstEnv(binDir, { DSH_LAUNCH_PROVIDER: "logfare", DSH_LAUNCH_MODEL: "glm-5.3" })
  });
  assert.equal(result.status, 0, result.stderr);
  const [runState] = readFakeDstState(binDir).runs;
  assert.deepEqual(patchesOf(runState.argv), [AGENT_MODEL_PATCH]);
  assert.equal(runState.launch.provider, "logfare");
  assert.equal(runState.launch.model, "glm-5.3");
});

test("a bare model name is rejected before dst starts", () => {
  const { repo, binDir, env } = setup();
  const result = run("node", [SCRIPT, "task", "--write", "--model", "glm-5.3", "refactor"], { cwd: repo, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provider\/model form/);
  assert.equal(readFakeDstState(binDir).runs.length, 0);
});

test("an effort without a model is rejected before dst starts", () => {
  const { repo, binDir, env } = setup();
  const result = run("node", [SCRIPT, "task", "--write", "--effort", "high", "refactor"], { cwd: repo, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs a model before an effort/);
  assert.equal(readFakeDstState(binDir).runs.length, 0);
});

test("a read-only task uses the read-only permission mode and a write task keeps dst's default", () => {
  const { repo, binDir, env } = setup();
  const readOnly = run("node", [SCRIPT, "task", "review only"], { cwd: repo, env });
  assert.equal(readOnly.status, 0, readOnly.stderr);
  const [readOnlyRun] = readFakeDstState(binDir).runs;
  assert.equal(option(readOnlyRun.argv, "--permission-mode"), "read-only");

  const write = run("node", [SCRIPT, "task", "--write", "fix it"], { cwd: repo, env });
  assert.equal(write.status, 0, write.stderr);
  const [, writeRun] = readFakeDstState(binDir).runs;
  assert.equal(option(writeRun.argv, "--permission-mode"), null);
});

test("--permission-mode is passed through and rejects unknown modes", () => {
  const { repo, binDir, env } = setup();
  const result = run("node", [SCRIPT, "task", "--permission-mode", "danger-full-access", "fix it"], {
    cwd: repo,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const [runState] = readFakeDstState(binDir).runs;
  assert.equal(option(runState.argv, "--permission-mode"), "danger-full-access");

  const invalid = run("node", [SCRIPT, "task", "--write", "--permission-mode", "yolo", "fix it"], { cwd: repo, env });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unsupported permission mode "yolo"/);
  assert.equal(readFakeDstState(binDir).runs.length, 1);
});

test("--permission-mode cannot be combined with --write or --read-only", () => {
  const { repo, binDir, env } = setup();
  for (const flags of [
    ["--read-only", "--permission-mode", "danger-full-access"],
    ["--write", "--permission-mode", "read-only"],
    ["--write", "--permission-mode", "danger-full-access"]
  ]) {
    const result = run("node", [SCRIPT, "task", ...flags, "fix it"], { cwd: repo, env });
    assert.notEqual(result.status, 0, flags.join(" "));
    assert.match(result.stderr, /Choose either --permission-mode or --write\/--read-only/, flags.join(" "));
  }
  // A stored background request replays through the same rule.
  const launch = run(
    "node",
    [SCRIPT, "task", "--background", "--write", "--permission-mode", "read-only", "--json", "queued work"],
    { cwd: repo, env }
  );
  assert.notEqual(launch.status, 0);
  assert.match(launch.stderr, /Choose either --permission-mode or --write\/--read-only/);
  assert.equal(readFakeDstState(binDir).runs.length, 0);
});

test("--timeout seconds become dst's --timeout milliseconds", () => {
  const { repo, binDir, env } = setup();
  const result = run("node", [SCRIPT, "task", "--write", "--timeout", "5", "fix it"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const [runState] = readFakeDstState(binDir).runs;
  assert.equal(option(runState.argv, "--timeout"), "5000");

  const invalid = run("node", [SCRIPT, "task", "--write", "--timeout", "soon", "fix it"], { cwd: repo, env });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid timeout "soon"/);
});

test("a task fails with a visible error when dst is missing", () => {
  const { repo, env } = setup();
  const result = run("node", [SCRIPT, "task", "--write", "do it"], {
    cwd: repo,
    env: { ...env, DSH_COMPANION_BIN: path.join(repo, "no-such-dst") }
  });
  assert.notEqual(result.status, 0);
  // The failure must be visible, not empty: the rescue agent returns this stderr verbatim and
  // its message is what points an uninstalled environment at /dsh:setup.
  assert.ok(result.stderr.trim().length > 0);
  assert.match(result.stderr, /DSH is not installed/);
  assert.match(result.stderr, /\/dsh:setup/);

  const status = run("node", [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  const failed = JSON.parse(status.stdout).latestFinished;
  assert.equal(failed.status, "failed");
  assert.match(failed.errorMessage, /DSH is not installed/);
});

test("creating the 51st job prunes the oldest finished job records", () => {
  const { repo, env } = setup();
  const jobsDir = path.join(resolveStateDir(repo), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const base = Date.UTC(2026, 0, 1);
  for (let index = 0; index < 50; index += 1) {
    const at = new Date(base + index * 1000).toISOString();
    fs.writeFileSync(
      path.join(jobsDir, `old-${index}.json`),
      JSON.stringify({ id: `old-${index}`, status: "completed", createdAt: at, updatedAt: at })
    );
  }

  const launch = run("node", [SCRIPT, "task", "--background", "--write", "--json", "prune test"], {
    cwd: repo,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  assert.equal(fs.existsSync(path.join(jobsDir, "old-0.json")), false, "the oldest job record is pruned");
  assert.equal(fs.existsSync(path.join(jobsDir, "old-49.json")), true, "newer finished records are kept");
  assert.equal(fs.existsSync(path.join(jobsDir, `${jobId}.json`)), true, "the new job is kept");
});

test("--resume-last continues the previous session by its id", () => {
  const { repo, binDir, env } = setup();
  const first = run("node", [SCRIPT, "task", "--write", "--model", "logfare/glm-5.3-flash", "initial task"], {
    cwd: repo,
    env
  });
  assert.equal(first.status, 0, first.stderr);
  const second = run(
    "node",
    [SCRIPT, "task", "--write", "--model", "logfare/glm-5.3-flash", "--resume-last", "follow up"],
    { cwd: repo, env }
  );
  assert.equal(second.status, 0, second.stderr);

  const [firstRun, secondRun] = readFakeDstState(binDir).runs;
  assert.equal(firstRun.sessionId, "session-fake-1", "the first run records the new session id");
  assert.equal(option(secondRun.argv, "--session-id"), "session-fake-1");
  assert.equal(secondRun.prompt, "follow up");
});

test("--resume-last without an earlier task fails clearly", () => {
  const { repo, env } = setup();
  const result = run("node", [SCRIPT, "task", "--resume-last", "go on"], { cwd: repo, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No previous DSH task session/);
});

test("a background task is tracked and its result is stored", () => {
  const { repo, env } = setup();
  const launch = run(
    "node",
    [SCRIPT, "task", "--background", "--write", "--model", "logfare/glm-5.3", "--json", "slow work"],
    { cwd: repo, env }
  );
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  assert.match(jobId, /^task-/);

  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  const result = run("node", [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task\./);
  assert.match(result.stdout, /Resume in DSH: dst run --session-id /);
});

test("cancel stops an active background job, its worker, and the dst runner", async (t) => {
  const { repo, env } = setup("hang");
  const { jobId, runnerPid } = await launchRunningBackgroundTask({ repo, env });
  t.after(() => killProcessGroupBestEffort(runnerPid));

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.processesStopped, true);

  await waitFor(() => pidGone(runnerPid));

  const status = run("node", [SCRIPT, "status", jobId, "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  const job = JSON.parse(status.stdout).job;
  assert.equal(job.status, "cancelled");
  assert.equal(job.pid, null);
  assert.equal(job.runnerPid, null);
});

test("cancel escalates to SIGKILL when the dst runner ignores SIGTERM", async (t) => {
  const { repo, env } = setup("ignore-term");
  const { jobId, runnerPid } = await launchRunningBackgroundTask({ repo, env });
  t.after(() => killProcessGroupBestEffort(runnerPid));

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.processesStopped, true, "a SIGTERM-swallowing runner is still stopped (SIGKILL)");

  await waitFor(() => pidGone(runnerPid));
});

test("cancel stops a runner started through a differently named DSH_COMPANION_BIN", async (t) => {
  const { repo, env } = setup("hang", { dstName: "deepseek" });
  const { jobId, runnerPid } = await launchRunningBackgroundTask({ repo, env });
  t.after(() => killProcessGroupBestEffort(runnerPid));

  // The job records the command the runner was actually started with; matching against a
  // hard-coded `dst` would report "stopped" without stopping anything.
  const status = run("node", [SCRIPT, "status", jobId, "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.runnerCommand, "deepseek");

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).processesStopped, true);

  await waitFor(() => pidGone(runnerPid));
});

test("session end stops this session's jobs, leaves a tombstone, and keeps other sessions", async (t) => {
  const { repo, env } = setup("hang");
  const sessionEnv = { ...env, DSH_COMPANION_SESSION_ID: "sess-current" };
  const { jobId, runnerPid } = await launchRunningBackgroundTask({ repo, env: sessionEnv });
  t.after(() => killProcessGroupBestEffort(runnerPid));

  const jobsDir = path.join(resolveStateDir(repo), "jobs");
  fs.writeFileSync(
    path.join(jobsDir, "task-other.json"),
    JSON.stringify({
      id: "task-other",
      status: "completed",
      title: "DSH Task",
      sessionId: "sess-other",
      createdAt: "2026-03-18T15:34:00.000Z",
      updatedAt: "2026-03-18T15:35:00.000Z"
    })
  );

  const hook = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: sessionEnv,
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: repo })
  });
  assert.equal(hook.status, 0, hook.stderr);

  await waitFor(() => pidGone(runnerPid));

  assert.equal(fs.existsSync(path.join(jobsDir, `${jobId}.json`)), false, "the session's job record is removed");
  assert.equal(fs.existsSync(path.join(jobsDir, `${jobId}.cancelled`)), true, "the cancel tombstone is kept");
  assert.equal(fs.existsSync(path.join(jobsDir, "task-other.json")), true, "another session's job is untouched");
});

test("a worker whose record was removed after a cancel marker still stops itself", async () => {
  const { repo } = setup();
  const jobsDir = path.join(resolveStateDir(repo), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const jobId = "task-raced";
  // SessionEnd's order is: mark first, then remove the record. A worker that only enforced the
  // marker after finding the file (or that resurrected the record) would run past the cancel.
  fs.writeFileSync(resolveCancelMarkerFile(repo, jobId), `${new Date().toISOString()}\n`, "utf8");

  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        const { createJobProgressUpdater } = await import(${JSON.stringify(
          path.join(PLUGIN_ROOT, "scripts", "lib", "tracked-jobs.mjs")
        )});
        const { resolveWorkspaceRoot } = await import(${JSON.stringify(
          path.join(PLUGIN_ROOT, "scripts", "lib", "workspace.mjs")
        )});
        const updater = createJobProgressUpdater(resolveWorkspaceRoot(process.cwd()), ${JSON.stringify(jobId)});
        updater({ message: "DSH process started (pid 424242).", phase: "starting", runnerPid: 424242 });
        setTimeout(() => process.exit(0), 5000);
      `
    ],
    { cwd: repo, stdio: "ignore" }
  );

  const [, signal] = await new Promise((resolve) => {
    child.on("exit", (code, exitSignal) => resolve([code, exitSignal]));
  });
  assert.equal(signal, "SIGTERM", "the worker enforces the cancel marker on itself");
  assert.equal(
    fs.existsSync(path.join(jobsDir, `${jobId}.json`)),
    false,
    "the tombstone does not resurrect the removed record"
  );
});

test("a failed JSON result fails the task with DSH's error code and message", () => {
  const { repo, env } = setup("fail");
  const result = run("node", [SCRIPT, "task", "--write", "--model", "logfare/glm-5.3", "do it"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /TASK_FAILED: boom from the fake provider/);
});

test("a non-zero exit without JSON fails the task and shows stderr", () => {
  const { repo, env } = setup("exit1");
  const result = run("node", [SCRIPT, "task", "--write", "--model", "logfare/glm-5.3", "do it"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /DSH exited with status 1/);
  assert.match(result.stdout, /Model not found/);
});

test("dst's own deadline exit is reported as a timeout", () => {
  const { repo, env } = setup("deadline");
  const result = run("node", [SCRIPT, "task", "--write", "--model", "logfare/glm-5.3", "--timeout", "1", "do it"], {
    cwd: repo,
    env
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /--timeout deadline/);
});

test("the plugin is registered in the marketplace and ships its own commands, agent and hooks", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const entry = marketplace.plugins.find((plugin) => plugin.name === "dsh");
  assert.equal(entry.source, "./plugins/dsh");
  assert.equal(entry.version, manifest.version);
  for (const file of [
    "agents/dsh-rescue.md",
    "commands/rescue.md",
    "commands/setup.md",
    "commands/status.md",
    "commands/result.md",
    "commands/cancel.md",
    "hooks/hooks.json",
    "skills/dsh-cli-runtime/SKILL.md",
    "skills/dsh-result-handling/SKILL.md",
    "scripts/patches/agent-model.yml"
  ]) {
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, file)), file);
  }
  const agent = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "dsh-rescue.md"), "utf8");
  assert.match(agent, /dsh-companion\.mjs" task/);
  assert.match(agent, /--write/);
  assert.match(agent, /provider\/model/);
});

test("no file in the plugin still refers to Pi or OpenCode", () => {
  const stack = [PLUGIN_ROOT];
  const offenders = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        const content = fs.readFileSync(full, "utf8");
        // NOTICE is excluded because it is the provenance statement: it must name
        // openai/codex-plugin-cc and the opencode plugin whose job-tracking structure dsh
        // reuses. Every other file must speak DSH only.
        if ((/opencode/i.test(content) || /\bpi\b/i.test(content)) && entry.name !== "NOTICE") {
          offenders.push(path.relative(PLUGIN_ROOT, full));
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});
