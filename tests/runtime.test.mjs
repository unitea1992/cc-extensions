// Modified from openai/codex-plugin-cc (Apache-2.0): ported to the OpenCode companion.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, FAKE_MODELS, installFakeOpencode, readFakeState } from "./fake-opencode-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { loadState, readJobFile, resolveStateDir } from "../plugins/opencode/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "opencode");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

// Jobs live in jobs/<id>.json; state.json may still hold jobs seeded in the older index format.
function readStateSnapshot(stateDir) {
  const stateFile = path.join(stateDir, "state.json");
  const parsed = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  const jobsDir = path.join(stateDir, "jobs");
  const fromFiles = fs.existsSync(jobsDir)
    ? fs.readdirSync(jobsDir).filter((name) => name.endsWith(".json")).map((name) => readJobFile(path.join(jobsDir, name)))
    : [];
  const legacy = new Map((parsed.jobs ?? []).map((job) => [job.id, job]));
  const jobs = fromFiles.map((job) => {
    const merged = { ...(legacy.get(job.id) ?? {}), ...job };
    legacy.delete(job.id);
    return merged;
  });
  return { ...parsed, jobs: [...jobs, ...legacy.values()] };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
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

test("setup reports ready and lists models when fake opencode is installed", () => {
  const binDir = makeTempDir();
  installFakeOpencode(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.opencode.detail, /non-interactive runtime available/);
  assert.deepEqual(payload.models.available, FAKE_MODELS);
  assert.equal(payload.models.defaultModel, null);
  assert.equal(payload.sessionRuntime.mode, "standalone");

  const rendered = run("node", [SCRIPT, "setup"], { cwd: ROOT, env: buildEnv(binDir) });
  assert.match(rendered.stdout, /Default model \(used when `--model` is omitted\): not set/);
});

test("setup shows the default model from the OpenCode config files", () => {
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "default-model");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.deepEqual(payload.models.available, FAKE_MODELS);
  assert.equal(payload.models.defaultModel, "lan/big");

  const rendered = run("node", [SCRIPT, "setup"], { cwd: ROOT, env: buildEnv(binDir) });
  assert.match(rendered.stdout, /Default model \(used when `--model` is omitted\): lan\/big/);
  assert.doesNotMatch(rendered.stdout, /\*\*\*/);
});

test("setup is ready without npm when OpenCode is already installed", () => {
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...buildEnv(binDir),
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.opencode.available, true);
  assert.equal(payload.models.available.length, FAKE_MODELS.length);
});

test("review renders a no-findings result from the structured review JSON", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# OpenCode Review/);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material issues found/);
});

test("review accepts the quoted raw argument style for base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Target: branch diff against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("adversarial review renders structured findings from the OpenCode run", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks OpenCode to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.match(state.lastRun.prompt, /lightweight summary/i);
  assert.match(state.lastRun.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastRun.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when OpenCode streams thinking", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
});

test("review logs reasoning and the assistant output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = readStateSnapshot(stateDir);
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /No material issues found\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "OpenCode Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "OpenCode Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "OpenCode Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      OPENCODE_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-opencode-state.json");
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    OPENCODE_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    OPENCODE_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous OpenCode task session was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.runs.length, 1);
  assert.equal(fakeState.lastRun.session, null);
  assert.equal(fakeState.lastRun.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "OpenCode Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    OPENCODE_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous OpenCode task session was found for this repository\./);
});

test("session start hook exports the Claude session id and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export OPENCODE_COMPANION_SESSION_ID='sess-current'\nexport OPENCODE_COMPANION_DATA='${pluginDataDir}'\n`
  );
});

test("write task output focuses on the OpenCode result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --write --auto passes --auto to OpenCode; without --auto or in read-only mode it does not", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-opencode-state.json");
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const lastFlags = () => JSON.parse(fs.readFileSync(statePath, "utf8")).lastRun;

  const auto = run("node", [SCRIPT, "task", "--write", "--auto", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(auto.status, 0, auto.stderr);
  assert.equal(lastFlags().agent, "build");
  assert.ok(lastFlags().flags.includes("--auto"));
  assert.ok(!lastFlags().prompt.includes("--auto"));

  const plain = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(!lastFlags().flags.includes("--auto"));

  const readOnly = run("node", [SCRIPT, "task", "--auto", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(readOnly.status, 0, readOnly.stderr);
  assert.equal(lastFlags().agent, "cc-companion-readonly");
  assert.ok(!lastFlags().flags.includes("--auto"));
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-opencode-state.json");
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastRun.session, "ses_fake0001");
  assert.equal(fakeState.lastRun.prompt, "follow up");
  assert.equal(fakeState.runs[0].title, "OpenCode Companion Task: initial task");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-opencode-state.json");
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastRun.prompt, "diagnose the flaky test");
});

test("task forwards model selection and effort as an OpenCode model variant", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-opencode-state.json");
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "fake/alpha", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastRun.model, "fake/alpha#low");
});

test("task stops a silent OpenCode run after the idle timeout and reports why", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "silent-hang");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const started = Date.now();
  const result = run("node", [SCRIPT, "task", "--model", "fake/alpha", "--idle-timeout", "1", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.ok(Date.now() - started < 20000, "the run should stop long before the fake gives up");
  assert.match(result.stdout, /no output for 1s/);
  assert.match(result.stdout, /fake\/alpha is loaded/);
  const fakeState = readFakeState(binDir);
  assert.throws(() => process.kill(fakeState.lastRun.pid, 0));
  const state = readStateSnapshot(resolveStateDir(repo));
  assert.equal(state.jobs[0].status, "failed");
});

test("task retries when OpenCode's private server hangs before starting", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "stuck-server-once");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir, { OPENCODE_COMPANION_STARTUP_TIMEOUT_SECONDS: "1" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stderr, /did not start within 1s; retrying \(attempt 2 of 3\)/);
  assert.equal(readFakeState(binDir).attempts, 2);
});

test("task gives up after repeated private server startup hangs", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "stuck-server");
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir, { OPENCODE_COMPANION_STARTUP_TIMEOUT_SECONDS: "0.5" })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /did not start within 1s in 3 attempts/);
  assert.equal(readFakeState(binDir).attempts, 3);
});

test("task reads the idle timeout from the environment and rejects invalid values", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "silent-hang");
  initGitRepo(repo);

  const viaEnv = run("node", [SCRIPT, "task", "diagnose"], {
    cwd: repo,
    env: buildEnv(binDir, { OPENCODE_COMPANION_IDLE_TIMEOUT_SECONDS: "1" })
  });
  assert.notEqual(viaEnv.status, 0);
  assert.match(viaEnv.stdout, /no output for 1s/);

  const invalid = run("node", [SCRIPT, "task", "--idle-timeout", "soon", "diagnose"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be a number of seconds/);
});

test("task logs reasoning and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = readStateSnapshot(stateDir);
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/opencode:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.opencode.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# OpenCode Status/);
  assert.match(status.stdout, /OpenCode Review/);
  assert.match(status.stdout, /completed/);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting OpenCode Review.",
      "[2026-03-18T15:30:01.000Z] Session ready (thr_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "OpenCode Review",
        rendered: "# OpenCode Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "OpenCode Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "OpenCode Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| OpenCode Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/opencode:status review-live`<br>`\/opencode:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: private server per run/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /OpenCode session ID: thr_1/);
  assert.match(result.stdout, /Resume in OpenCode: opencode --session thr_1/);
  assert.match(result.stdout, /Session ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /OpenCode session ID: thr_done/);
  assert.match(result.stdout, /Resume in OpenCode: opencode --session thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "OpenCode Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "OpenCode Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      OPENCODE_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "OpenCode Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "OpenCode Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| OpenCode Adversarial Review/);
  assert.match(result.stdout, /OpenCode session ID: thr_adv_live/);
  assert.match(result.stdout, /OpenCode session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting OpenCode Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "OpenCode Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "OpenCode Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "OpenCode Review",
        rendered: "# OpenCode Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          opencode: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "OpenCode Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nOpenCode session ID: thr_review_finished\nResume in OpenCode: opencode --session thr_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "OpenCode Review",
        threadId: "thr_current",
        result: {
          opencode: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "OpenCode Review",
        threadId: "thr_other",
        result: {
          opencode: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "OpenCode Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "OpenCode Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      OPENCODE_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nOpenCode session ID: thr_current\nResume in OpenCode: opencode --session thr_current\n"
  );
});

test("result for a finished write-capable task returns the raw OpenCode final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /OpenCode session ID: ses_fake0001/);
  assert.match(result.stdout, /Resume in OpenCode: opencode --session ses_fake0001/);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  // The trailing argument stands in for the companion or OpenCode command line that cancel verifies.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "opencode-test-worker"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting OpenCode Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "OpenCode Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "OpenCode Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = readStateSnapshot(stateDir);
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "OpenCode Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    OPENCODE_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active OpenCode jobs to cancel for this session\./);

  const state = readStateSnapshot(stateDir);
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "OpenCode Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    OPENCODE_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = readStateSnapshot(stateDir);
  assert.equal(state.jobs[0].status, "cancelled");
});

test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  // The trailing argument stands in for the companion or OpenCode command line that cancel verifies.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "opencode-test-worker"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "OpenCode Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "OpenCode Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "OpenCode Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      OPENCODE_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  // Only the other session's files remain, plus a tombstone for the stopped running job.
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).filter((name) => !name.endsWith(".cancelled")).sort(),
    [path.basename(otherJobFile), path.basename(otherSessionLog)].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = readStateSnapshot(stateDir);
  assert.deepEqual(state.jobs.map((job) => job.id), ["review-other"]);
  const otherJob = state.jobs[0];
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-opencode-state.json");
  installFakeOpencode(binDir, "stop-block");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /OpenCode stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastRun.prompt, /<task>/i);
  assert.match(fakeState.lastRun.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastRun.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastRun.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      OPENCODE_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /OpenCode Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "OpenCode Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      OPENCODE_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /OpenCode task task-live is still running/i);
  assert.match(blocked.stderr, /\/opencode:status/i);
  assert.match(blocked.stderr, /\/opencode:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when OpenCode is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Hide every OpenCode install, including the real one on this machine, from both calls.
  const env = { ...process.env, PATH: "" };
  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).opencode.available, false);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /OpenCode is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/opencode:setup/i);
});

function initRepoWithReadme() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

const WRITE_ATTEMPTS = [
  ["write notes.txt", "notes.txt"],
  ["shell touch made.txt", "made.txt"],
  ["shell git status > out.txt", "out.txt"],
  ["shell git status | tee t.txt", "t.txt"],
  ["shell git log $(touch sub.txt)", "sub.txt"],
  ["shell git diff --output=o.txt", "o.txt"],
  ["shell git status && touch chained.txt", "chained.txt"]
];

function toolPrompt(lines) {
  return ["Try each tool call below and report the outcome.", ...lines.map((line) => `TOOL ${line}`)].join("\n");
}

test("read-only task cannot edit files or write through the shell", () => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const userConfig = { agents: { mine: { description: "user agent" } }, share: "disabled" };

  const prompt = toolPrompt([
    ...WRITE_ATTEMPTS.map(([line]) => line),
    "shell git difftool",
    "shell git status",
    "shell git diff --stat",
    "read README.md"
  ]);
  const result = run("node", [SCRIPT, "task"], {
    cwd: repo,
    env: { ...buildEnv(binDir), OPENCODE_CONFIG_CONTENT: JSON.stringify(userConfig) },
    input: prompt
  });

  assert.equal(result.status, 0, result.stderr);
  for (const [line, file] of WRITE_ATTEMPTS) {
    assert.equal(fs.existsSync(path.join(repo, file)), false, `${line} must not create ${file}`);
    assert.match(result.stdout, new RegExp(`${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} => denied`));
  }
  assert.match(result.stdout, /shell git difftool => denied/);
  assert.match(result.stdout, /shell git status => allowed/);
  assert.match(result.stdout, /shell git diff --stat => allowed/);
  assert.match(result.stdout, /read README\.md => allowed/);
  assert.equal(run("git", ["status", "--porcelain"], { cwd: repo }).stdout, "");

  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastRun.agent, "cc-companion-readonly");
  assert.ok(fakeState.lastRun.flags.includes("--standalone"));
  assert.ok(fakeState.lastRun.argv.includes("json"));
  const injected = fakeState.lastRun.configContent;
  assert.equal(injected.share, "disabled");
  assert.deepEqual(injected.agents.mine, userConfig.agents.mine);
  assert.deepEqual(injected.agents["cc-companion-readonly"].permissions[0], { action: "*", resource: "*", effect: "deny" });
});

test("write-capable task runs with the build agent and can edit files", () => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);

  const result = run("node", [SCRIPT, "task", "--write"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: toolPrompt(["write notes.txt", "shell touch made.txt"])
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(repo, "notes.txt")), true);
  assert.equal(fs.existsSync(path.join(repo, "made.txt")), true);
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastRun.agent, "build");
  assert.ok(fakeState.lastRun.flags.includes("--standalone"));
  assert.ok(!fakeState.lastRun.flags.includes("--auto"));
});

test("reviews always run with the injected read-only agent", () => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  for (const command of ["review", "adversarial-review"]) {
    const result = run("node", [SCRIPT, command], { cwd: repo, env: buildEnv(binDir) });
    assert.equal(result.status, 0, result.stderr);
  }

  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.runs.length, 2);
  for (const entry of fakeState.runs) {
    assert.equal(entry.agent, "cc-companion-readonly");
    assert.ok(!entry.argv.includes("build"));
    assert.ok(entry.configContent.agents["cc-companion-readonly"]);
    assert.match(entry.prompt, /"next_steps"/);
  }
  assert.equal(run("git", ["status", "--porcelain"], { cwd: repo }).stdout, " M README.md\n");
});

test("review extracts JSON wrapped in prose and Markdown fences", () => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "fenced-json");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: approve/);
  assert.doesNotMatch(result.stdout, /did not return valid structured JSON/);
  assert.doesNotMatch(result.stdout, /Schema warnings/);
});

test("review reports schema mismatches without discarding the result", () => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "schema-mismatch");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "approve");
  assert.deepEqual(payload.schemaErrors, ["$.extra is not allowed"]);

  const rendered = run("node", [SCRIPT, "result"], { cwd: repo, env: buildEnv(binDir) });
  assert.match(rendered.stdout, /Schema warnings/);
  assert.match(rendered.stdout, /\$\.extra is not allowed/);
});

test("review reports invalid JSON with the raw final message", () => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "invalid-json");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /did not return valid structured JSON/);
  assert.match(result.stdout, /not valid json/);
});

for (const [behavior, pattern] of [
  ["run-error", /Provider rejected the request: invalid API key\./],
  ["crash", /exited with status 3: fatal: fake opencode crashed/]
]) {
  test(`task surfaces ${behavior} as a failed job with the error message`, () => {
    const repo = initRepoWithReadme();
    const binDir = makeTempDir();
    installFakeOpencode(binDir, behavior);

    const result = run("node", [SCRIPT, "task", "investigate"], { cwd: repo, env: buildEnv(binDir) });

    assert.equal(result.status, 1);
    assert.match(result.stdout, pattern);
    const state = readStateSnapshot(resolveStateDir(repo));
    assert.equal(state.jobs[0].status, "failed");
    assert.equal(state.jobs[0].runnerPid, null);
  });
}

test("task --effort without --model fails before starting OpenCode", () => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);

  for (const extra of [[], ["--background"]]) {
    const result = run("node", [SCRIPT, "task", ...extra, "--effort", "high", "investigate"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /`--effort` selects an OpenCode model variant and needs `--model provider\/model`/);
  }

  const malformed = run("node", [SCRIPT, "task", "--model", "nomodel", "investigate"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /must use the OpenCode form provider\/model/);

  assert.equal(fs.existsSync(path.join(binDir, "fake-opencode-state.json")), false);
});

test("setup reports not ready when OpenCode lists no models", () => {
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "no-models");

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: ROOT, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.deepEqual(payload.models.available, []);
  assert.ok(payload.nextSteps.some((step) => /opencode auth login/.test(step)));
});

test("setup retries while the OpenCode model catalog is still loading", () => {
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "cold-models");

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: ROOT, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.deepEqual(payload.models.available, FAKE_MODELS);
  assert.equal(readFakeState(binDir).modelCalls, 2);
});

test("setup rejects an OpenCode CLI without the v2 run interface", () => {
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "v1-cli");

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: ROOT, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.opencode.available, false);
  assert.match(payload.opencode.detail, /OpenCode v2 is required/);

  const task = run("node", [SCRIPT, "task", "investigate"], { cwd: ROOT, env: buildEnv(binDir) });
  assert.equal(task.status, 1);
  assert.match(task.stderr, /OpenCode v2/);
});

test("prompts are passed to OpenCode on stdin rather than argv", () => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  const marker = `STDIN_ONLY_${"x".repeat(64)}`;

  const result = run("node", [SCRIPT, "task", `investigate ${marker}`], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(binDir);
  assert.match(fakeState.lastRun.prompt, new RegExp(marker));
  assert.ok(fakeState.lastRun.argv.every((arg) => !arg.includes(marker)));
});

test("cancel stops the OpenCode process group of a running background task", async (t) => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "interruptible-slow-task");
  const env = buildEnv(binDir);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "long running task"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId } = JSON.parse(launched.stdout);

  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const runningJob = await waitFor(() => {
    const job = readStateSnapshot(path.dirname(stateFile)).jobs.find((entry) => entry.id === jobId);
    return job?.status === "running" && job.runnerPid ? job : null;
  }, { timeoutMs: 10000 });
  const fakePid = await waitFor(() => {
    try {
      return readFakeState(binDir).lastRun?.pid ?? null;
    } catch {
      return null;
    }
  });
  assert.equal(fakePid, runningJob.runnerPid);
  t.after(() => {
    try {
      process.kill(fakePid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.runnerStopped, true);

  await waitFor(() => {
    try {
      process.kill(fakePid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const job = readStateSnapshot(path.dirname(stateFile)).jobs.find((entry) => entry.id === jobId);
  assert.equal(job.status, "cancelled");
  assert.equal(job.runnerPid, null);
});

test("stop hook accepts a Markdown-decorated ALLOW verdict", () => {
  const repo = initRepoWithReadme();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "stop-decorated");

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-decorated", last_assistant_message: "Edited src/app.js." })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastRun.agent, "cc-companion-readonly");
  assert.match(fakeState.lastRun.prompt, /Edited src\/app\.js\./);
  assert.ok(fakeState.lastRun.argv.every((arg) => !arg.includes("Edited src/app.js.")));
});


test("result with the id of a running job says it is still running", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const job = { id: "task-live", status: "running", title: "OpenCode Task", jobClass: "task", updatedAt: "2026-03-18T15:30:02.000Z" };
  fs.writeFileSync(path.join(jobsDir, "task-live.json"), JSON.stringify(job), "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }),
    "utf8"
  );

  const result = run("node", [SCRIPT, "result", "task-live"], { cwd: workspace });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Job task-live is still running/);
  assert.doesNotMatch(result.stderr, /No job found/);
});

test("a foreground task cancelled mid-run stays cancelled", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = buildEnv(binDir);

  // Started without `detached`, so the companion is not a process-group leader, as from a shell.
  const child = spawn("node", [SCRIPT, "task", "keep working"], { cwd: repo, env, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const running = await waitFor(() => {
    const state = readStateSnapshot(path.dirname(stateFile));
    return state.jobs.find((job) => job.status === "running" && job.runnerPid) ?? null;
  });

  const cancel = run("node", [SCRIPT, "cancel", running.id, "--json"], { cwd: repo, env });
  assert.equal(cancel.status, 0, cancel.stderr);
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("companion kept running")), 5000))]);

  const stored = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "jobs", `${running.id}.json`), "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.throws(() => process.kill(running.runnerPid, 0), { code: "ESRCH" });
});

test("a background job cancelled before its worker starts never runs", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const job = {
    id: "task-early",
    status: "cancelled",
    phase: "cancelled",
    title: "OpenCode Task",
    jobClass: "task",
    workspaceRoot: repo,
    request: { cwd: repo, prompt: "write things", write: true, jobId: "task-early" }
  };
  fs.writeFileSync(path.join(jobsDir, "task-early.json"), JSON.stringify(job), "utf8");
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }), "utf8");

  const result = run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", "task-early"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(binDir, "fake-opencode-state.json")), false, "OpenCode must not be started");
  const stored = JSON.parse(fs.readFileSync(path.join(jobsDir, "task-early.json"), "utf8"));
  assert.equal(stored.status, "cancelled");
});

test("a worker racing a cancel stops when the cancel marker exists even though the job still looks queued", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const job = {
    id: "task-race",
    status: "queued",
    phase: "queued",
    pid: null,
    title: "OpenCode Task",
    jobClass: "task",
    workspaceRoot: repo,
    request: { cwd: repo, prompt: "write things", write: true, jobId: "task-race" }
  };
  fs.writeFileSync(path.join(jobsDir, "task-race.json"), JSON.stringify(job), "utf8");
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }), "utf8");
  // Cancel has marked the job but not yet saved the cancelled status.
  fs.writeFileSync(path.join(jobsDir, "task-race.cancelled"), "now\n", "utf8");

  run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", "task-race"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(fs.existsSync(path.join(binDir, "fake-opencode-state.json")), false, "OpenCode must not be started");
  assert.equal(readJobFile(path.join(jobsDir, "task-race.json")).status, "cancelled");
  assert.equal(loadState(repo).jobs.find((entry) => entry.id === "task-race").status, "cancelled");
  const status = JSON.parse(run("node", [SCRIPT, "status", "task-race", "--json"], { cwd: repo, env: buildEnv(binDir) }).stdout);
  assert.equal(status.job.status, "cancelled");
});

test("a queued worker whose session already ended never runs", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeOpencode(binDir);
  initGitRepo(repo);
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const job = {
    id: "task-ended",
    status: "queued",
    phase: "queued",
    pid: null,
    sessionId: "sess-ended",
    title: "OpenCode Task",
    jobClass: "task",
    workspaceRoot: repo,
    request: { cwd: repo, prompt: "write things", write: true, jobId: "task-ended" }
  };
  fs.writeFileSync(path.join(jobsDir, "task-ended.json"), JSON.stringify(job), "utf8");

  const hook = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-ended", cwd: repo })
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(fs.existsSync(path.join(jobsDir, "task-ended.json")), false);
  assert.equal(fs.existsSync(path.join(jobsDir, "task-ended.cancelled")), true, "SessionEnd leaves a tombstone");

  // The worker had already read its request before SessionEnd deleted the job file.
  fs.writeFileSync(path.join(jobsDir, "task-ended.json"), JSON.stringify(job), "utf8");
  run("node", [SCRIPT, "task-worker", "--cwd", repo, "--job-id", "task-ended"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(fs.existsSync(path.join(binDir, "fake-opencode-state.json")), false, "OpenCode must not be started");
});

test("cancel keeps a result the worker saved after cancel read the job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  // The job completed and saved its result; cancel arrives with a stale view of it.
  fs.writeFileSync(
    path.join(jobsDir, "task-done.json"),
    JSON.stringify({ id: "task-done", status: "running", title: "OpenCode Task", jobClass: "task", result: { rawOutput: "kept" }, rendered: "kept\n" }),
    "utf8"
  );
  const cancel = run("node", [SCRIPT, "cancel", "task-done", "--json"], { cwd: workspace });
  assert.equal(cancel.status, 0, cancel.stderr);
  const stored = JSON.parse(fs.readFileSync(path.join(jobsDir, "task-done.json"), "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.rendered, "kept\n");
  assert.equal(stored.result.rawOutput, "kept");
});

test("session end also stops a process that survived an earlier cancel", { skip: process.platform === "win32" }, async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const jobsDir = path.join(resolveStateDir(repo), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "opencode-test-runner"], { detached: true, stdio: "ignore" });
  survivor.unref();
  fs.writeFileSync(
    path.join(jobsDir, "task-left.json"),
    JSON.stringify({ id: "task-left", status: "cancelled", sessionId: "sess-left", runnerPid: survivor.pid, pid: null }),
    "utf8"
  );

  const hook = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-left", cwd: repo })
  });
  assert.equal(hook.status, 0, hook.stderr);
  await waitFor(() => {
    try {
      process.kill(survivor.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
  assert.equal(fs.existsSync(path.join(jobsDir, "task-left.json")), false);
});
