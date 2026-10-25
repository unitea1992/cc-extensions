import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildDstEnv, FAKE_DST_MODELS, installFakeDst, readFakeDstState } from "./fake-dst-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "dsh");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "dsh-companion.mjs");
const AGENT_MODEL_PATCH = path.join(PLUGIN_ROOT, "scripts", "patches", "agent-model.yml");

function setup(behavior = "ok") {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeDst(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, env: buildDstEnv(binDir) };
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
  const result = run(
    "node",
    [SCRIPT, "task", "--write", "--permission-mode", "danger-full-access", "fix it"],
    { cwd: repo, env }
  );
  assert.equal(result.status, 0, result.stderr);
  const [runState] = readFakeDstState(binDir).runs;
  assert.equal(option(runState.argv, "--permission-mode"), "danger-full-access");

  const invalid = run("node", [SCRIPT, "task", "--write", "--permission-mode", "yolo", "fix it"], { cwd: repo, env });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unsupported permission mode "yolo"/);
  assert.equal(readFakeDstState(binDir).runs.length, 1);
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
        if ((/opencode/i.test(content) || /\bpi\b/i.test(content)) && entry.name !== "NOTICE") {
          offenders.push(path.relative(PLUGIN_ROOT, full));
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});
