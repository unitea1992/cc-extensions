import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildPiEnv, FAKE_PI_MODELS, installFakePi, readFakePiState } from "./fake-pi-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "pi");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "pi-companion.mjs");

function setup(behavior = "ok") {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakePi(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, env: buildPiEnv(binDir) };
}

function option(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

test("setup reports the Pi version and models", () => {
  const { repo, env } = setup();
  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.pi.available, true);
  assert.deepEqual(report.models.available, FAKE_PI_MODELS);
});

test("setup says Pi is unavailable when the command is missing", () => {
  const { repo, env } = setup();
  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env: { ...env, PI_COMPANION_BIN: path.join(repo, "no-such-pi") }
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.pi.available, false);
  assert.ok(report.nextSteps.length > 0);
});

test("a read-only task gives Pi only the tools that cannot change files and sends the prompt on stdin", () => {
  const { repo, binDir, env } = setup();
  const result = run("node", [SCRIPT, "task", "diagnose the failing test"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\n");

  const [runState] = readFakePiState(binDir).runs;
  assert.equal(option(runState.argv, "--tools"), "read,grep,find,ls");
  assert.deepEqual(runState.argv.slice(0, 3), ["--print", "--mode", "json"]);
  assert.equal(runState.prompt, "diagnose the failing test");
  // Only a short excerpt reaches the command line, as the session name.
  assert.ok(runState.argv.every((arg) => arg !== "diagnose the failing test"));
});

test("a write task leaves Pi's default tools and does not restrict them", () => {
  const { repo, binDir, env } = setup();
  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);

  const [runState] = readFakePiState(binDir).runs;
  assert.equal(option(runState.argv, "--tools"), null);
  assert.ok(!runState.argv.includes("--approve"));
});

test("--model and --effort become Pi's --model and --thinking", () => {
  const { repo, binDir, env } = setup();
  const result = run(
    "node",
    [SCRIPT, "task", "--write", "--model", "spark/Alpha-Flash", "--effort", "high", "refactor"],
    { cwd: repo, env }
  );
  assert.equal(result.status, 0, result.stderr);

  const [runState] = readFakePiState(binDir).runs;
  assert.equal(option(runState.argv, "--model"), "spark/Alpha-Flash");
  assert.equal(option(runState.argv, "--thinking"), "high");
});

test("an unknown --effort is rejected before Pi starts", () => {
  const { repo, binDir, env } = setup();
  const result = run("node", [SCRIPT, "task", "--effort", "extreme", "refactor"], { cwd: repo, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported effort "extreme"/);
  assert.equal(readFakePiState(binDir).runs.length, 0);
});

test("--resume-last continues the previous session by its id", () => {
  const { repo, binDir, env } = setup();
  const first = run("node", [SCRIPT, "task", "--write", "initial task"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const second = run("node", [SCRIPT, "task", "--write", "--resume-last", "follow up"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);

  const [firstRun, secondRun] = readFakePiState(binDir).runs;
  const sessionId = option(firstRun.argv, "--session-id");
  assert.ok(sessionId, "the first run creates a session with an id of our own");
  assert.equal(option(secondRun.argv, "--session"), sessionId);
  assert.equal(option(secondRun.argv, "--session-id"), null);
  assert.equal(secondRun.prompt, "follow up");
});

test("--resume-last without an earlier task fails clearly", () => {
  const { repo, env } = setup();
  const result = run("node", [SCRIPT, "task", "--resume-last", "go on"], { cwd: repo, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No previous Pi task session/);
});

test("a background task is tracked and its result is stored", () => {
  const { repo, env } = setup();
  const launch = run("node", [SCRIPT, "task", "--background", "--write", "--json", "slow work"], { cwd: repo, env });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  assert.match(jobId, /^task-/);

  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  const result = run("node", [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task\./);
  assert.match(result.stdout, /Resume in Pi: pi --session /);
});

test("files Pi wrote are reported as touched", () => {
  const { repo, env } = setup("edit");
  const result = run("node", [SCRIPT, "task", "--write", "--json", "add a file"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.touchedFiles, ["src/app.js"]);
  assert.equal(payload.rawOutput, "Handled the requested task.");
});

test("a provider error in the response fails the task with Pi's message", () => {
  const { repo, env } = setup("api-error");
  const result = run("node", [SCRIPT, "task", "--write", "do it"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /provider returned 500/);
});

test("a non-zero exit from Pi fails the task and shows stderr", () => {
  const { repo, env } = setup("fail");
  const result = run("node", [SCRIPT, "task", "--write", "do it"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Model not found/);
});

test("a silent Pi is stopped by --idle-timeout and reported as failed", () => {
  const { repo, env } = setup("hang");
  const result = run("node", [SCRIPT, "task", "--write", "--idle-timeout", "1", "do it"], { cwd: repo, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Pi produced no output for 1s/);
});

test("the plugin is registered in the marketplace and ships its own commands, agent and hooks", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const entry = marketplace.plugins.find((plugin) => plugin.name === "pi");
  assert.equal(entry.source, "./plugins/pi");
  assert.equal(entry.version, manifest.version);
  for (const file of [
    "agents/pi-rescue.md",
    "commands/rescue.md",
    "commands/setup.md",
    "commands/status.md",
    "commands/result.md",
    "commands/cancel.md",
    "hooks/hooks.json",
    "skills/pi-cli-runtime/SKILL.md",
    "skills/pi-result-handling/SKILL.md"
  ]) {
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, file)), file);
  }
  const agent = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "pi-rescue.md"), "utf8");
  assert.match(agent, /pi-companion\.mjs" task/);
  assert.match(agent, /--write/);
});

test("no file in the plugin still refers to OpenCode", () => {
  const stack = [PLUGIN_ROOT];
  const offenders = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/opencode/i.test(fs.readFileSync(full, "utf8")) && entry.name !== "NOTICE") {
        offenders.push(path.relative(PLUGIN_ROOT, full));
      }
    }
  }
  assert.deepEqual(offenders, []);
});
