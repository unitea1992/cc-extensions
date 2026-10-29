import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseInvocation, summarizeTask, dispatchKey } from "../plugins/decision-router/scripts/decision-router.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins/decision-router/scripts/pretool-hook.mjs");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-router-test-"));
  const bin = path.join(dir, "fake-d1-route");
  fs.writeFileSync(bin, "#!/usr/bin/env node\n" +
    "const fs=require('fs');\n" +
    "fs.appendFileSync(process.env.FAKE_CALLS, 'call\\n');\n" +
    "if (process.env.FAKE_FAIL==='1') process.exit(1);\n" +
    "console.log(JSON.stringify({ok:true,kind:'routine',effort:'low',risk:'low',suggested_agent:'pi'}));\n",
    { mode: 0o755 });
  const calls = path.join(dir, "calls.log");
  const env = { ...process.env, DECISION_ROUTER_PROVIDER_BIN: bin,
    DECISION_ROUTER_CACHE_DIR: path.join(dir, "cache"), FAKE_CALLS: calls };
  const run = (event, extra = {}) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event), encoding: "utf8", timeout: 2000, env: { ...env, ...extra }
  });
  const dispose = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, calls, env, run, dispose };
}
function event(command, session = "s1") {
  return { session_id: session, cwd: "/tmp", tool_name: "Bash", tool_input: { command } };
}

test("finds a dispatch, ignoring quoted or unrelated mentions", () => {
  assert.equal(parseInvocation("orca-worker-start --name fix-ui --reason 'small UI fix'").name, "fix-ui");
  assert.equal(parseInvocation("cd /repo && /home/me/.local/bin/orca-worker-start --name fix-ui --check-only").name, "fix-ui");
  assert.equal(parseInvocation("echo orca-worker-start --name fix-ui"), null);
  assert.equal(parseInvocation("rg 'orca-worker-start' scripts"), null);
  assert.equal(parseInvocation("orca-worker-start --help"), null);
});

test("uses spec text without executing shell substitutions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-router-spec-"));
  try {
    fs.writeFileSync(path.join(dir, "job.md"), "UI screenshot review");
    const match = parseInvocation("orca-worker-start --name feat-card --title 'Card' --spec-file job.md");
    assert.match(summarizeTask(match, dir), /UI screenshot review/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("first dispatch is denied once with advice, retry is allowed", () => {
  const f = fixture();
  try {
    const first = f.run(event("orca-worker-start --name fix-ui --reason 'small task' --agent codex --effort high --check-only"));
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /suggested_agent=pi/);
    const retry = f.run(event("orca-worker-start --name fix-ui --reason 'small task' --agent pi --effort low"));
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(retry.stdout.trim(), "");
    assert.equal(fs.readFileSync(f.calls, "utf8").trim().split("\n").length, 1);
  } finally { f.dispose(); }
});

test("different Dispatch names cause independent classification", () => {
  const f = fixture();
  try {
    for (const name of ["fix-one", "fix-two"]) {
      assert.match(f.run(event("orca-worker-start --name " + name + " --reason 'task'")).stdout, /"deny"/);
    }
    assert.equal(fs.readFileSync(f.calls, "utf8").trim().split("\n").length, 2);
  } finally { f.dispose(); }
});

test("failed provider, unrelated tools and malformed input fail open", () => {
  const f = fixture();
  try {
    assert.equal(f.run(event("orca-worker-start --name fix-a --reason task"), { FAKE_FAIL: "1" }).stdout.trim(), "");
    assert.equal(f.run(event("echo hi")).stdout.trim(), "");
    const edit = event("orca-worker-start --name fix-b --reason task");
    edit.tool_name = "Edit";
    assert.equal(f.run(edit).stdout.trim(), "");
    const bad = spawnSync(process.execPath, [HOOK], { input: "{", encoding: "utf8", timeout: 2000, env: f.env });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout.trim(), "");
  } finally { f.dispose(); }
});

test("dispatch key ignores model and effort and only uses identity", () => {
  const invocation = { name: "fix-x", task: null, followup: null, specFiles: [] };
  assert.equal(dispatchKey(event("abc"), invocation), dispatchKey(event("different text"), invocation));
});
