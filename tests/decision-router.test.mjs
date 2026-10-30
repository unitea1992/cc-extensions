import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseInvocation, summarizeTask, fitToTokenBudget, dispatchKey, readCache, writeCache,
  routeTask, status
} from "../plugins/decision-router/scripts/decision-router.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins/decision-router/scripts/pretool-hook.mjs");
const TRIM_MARKER = "…（中略）…";

function makeProvider(dir) {
  const bin = path.join(dir, "fake-d1-route");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, "call\\n");
if (process.env.FAKE_ARGV) fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify(argv));
if (process.env.FAKE_FAIL === "1") process.exit(1);
if (process.env.FAKE_SLEEP) { const end = Date.now() + Number(process.env.FAKE_SLEEP); while (Date.now() < end) {} }
const task = argv[argv.indexOf("--task") + 1];
const maxChars = Number(process.env.FAKE_MAX_TASK_CHARS || 0);
if (maxChars && Array.from(task).length > maxChars) {
  console.log(JSON.stringify({ ok: false, reason: "HTTPError" }));
  process.exit(1);
}
const mode = process.env.FAKE_MODE || "ok";
if (mode === "missing-agent") console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low" }));
else if (mode === "bad-json") console.log("not json");
else if (mode === "unknown-kind") console.log(JSON.stringify({ ok: true, kind: "nope", effort: "low", risk: "low", suggested_agent: "pi" }));
else if (mode === "secret-agent") console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low", suggested_agent: "SECRET_AGENT_123" }));
else if (mode === "newline-agent") console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low", suggested_agent: "pi\\nSECRET" }));
else if (mode === "high-risk") console.log(JSON.stringify({ ok: true, kind: "critical", effort: "high", risk: "high", suggested_agent: "codex" }));
else if (mode === "echo-extra") console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low", suggested_agent: "pi", model: null, reason: task, echo: task }));
else console.log(JSON.stringify({ ok: true, kind: "routine", effort: "low", risk: "low", suggested_agent: "pi", model: null }));
`, { mode: 0o755 });
  return bin;
}

function makeTokenizer(dir) {
  const bin = path.join(dir, "fake-tokenize");
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
if (process.env.FAKE_TOKENIZE_CALLS) fs.appendFileSync(process.env.FAKE_TOKENIZE_CALLS, "call\\n");
if (process.env.FAKE_TOKENIZE_FAIL === "1") process.exit(1);
const text = fs.readFileSync(0, "utf8");
const ratio = Number(process.env.FAKE_TOKENIZE_RATIO || "0.55");
console.log(JSON.stringify({ tokens: Math.ceil(Array.from(text).length * ratio) }));
`, { mode: 0o755 });
  return bin;
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-router-test-"));
  const bin = makeProvider(dir);
  const tokenizer = makeTokenizer(dir);
  const calls = path.join(dir, "calls.log");
  const tokenCalls = path.join(dir, "tokenize-calls.log");
  const env = { ...process.env, DECISION_ROUTER_PROVIDER_BIN: bin,
    DECISION_ROUTER_TOKENIZE_BIN: tokenizer,
    DECISION_ROUTER_CACHE_DIR: path.join(dir, "cache"),
    FAKE_CALLS: calls, FAKE_TOKENIZE_CALLS: tokenCalls };
  delete env.NODE_OPTIONS;
  delete env.DECISION_ROUTER_TOKENIZER_URL;
  const run = (event, extra = {}, timeout = 3000) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(event), encoding: "utf8", timeout, env: { ...env, ...extra }
  });
  const dispose = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, bin, tokenizer, calls, tokenCalls, env, run, dispose };
}

function event(command, session = "s1", cwd = "/tmp") {
  return { session_id: session, cwd, tool_name: "Bash", tool_input: { command } };
}

function callCount(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").length : 0;
}

function cachedFiles(env) {
  const dir = env.DECISION_ROUTER_CACHE_DIR;
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : [];
}

function taskArgument(f) {
  const argv = JSON.parse(fs.readFileSync(path.join(f.dir, "argv.json"), "utf8"));
  return argv[argv.indexOf("--task") + 1];
}

function reasonOf(result) {
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
}

function assertFailOpen(result) {
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput, undefined);
  assert.match(output.systemMessage, /fail-open/);
}

const ADVICE = { ok: true, kind: "routine", suggested_agent: "pi", effort: "low", risk: "low" };
const BUDGET = 357;

test("finds a dispatch, ignoring quoted or unrelated mentions", () => {
  assert.equal(parseInvocation("orca-worker-start --name fix-ui --reason 'small UI fix'").name, "fix-ui");
  assert.equal(parseInvocation("cd /repo && /home/me/.local/bin/orca-worker-start --name fix-ui --check-only").name, "fix-ui");
  assert.equal(parseInvocation("echo orca-worker-start --name fix-ui"), null);
  assert.equal(parseInvocation("rg 'orca-worker-start' scripts"), null);
  assert.equal(parseInvocation("orca-worker-start --help"), null);
});

test("keeps shell separators inside quoted arguments and finds piped or background dispatches", () => {
  const quoted = parseInvocation("orca-worker-start --name a --reason 'x; y'");
  assert.equal(quoted.name, "a");
  assert.equal(quoted.reason, "x; y");
  assert.equal(parseInvocation("orca-worker-start --name fix --reason \"split && merge; keep\" --title \"a\nb\"").reason,
    "split && merge; keep");
  assert.equal(parseInvocation("printf 'x' | /usr/bin/orca-worker-start --name piped").name, "piped");
  assert.equal(parseInvocation("sleep 1 & orca-worker-start --name bg").name, "bg");
  assert.equal(parseInvocation("echo 'a | orca-worker-start --name z'"), null);
  assert.equal(parseInvocation("echo 'x; orca-worker-start --name z'"), null);
});

test("treats quoted substitutions as data and never executes them", () => {
  const f = fixture();
  try {
    const marker = path.join(f.dir, "pwned");
    const command = "orca-worker-start --name x --reason '$(touch " + marker + ")' --title \"`touch " + marker + ".2`\"";
    const argvFile = path.join(f.dir, "argv.json");
    const result = f.run(event(command), { FAKE_ARGV: argvFile });
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(argv.some((arg) => arg.includes("$(touch " + marker + ")")));
    assert.ok(argv.some((arg) => arg.includes("`touch " + marker + ".2`")));
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(marker + ".2"), false);
  } finally { f.dispose(); }
});

test("uses spec text without executing shell substitutions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-router-spec-"));
  try {
    fs.writeFileSync(path.join(dir, "job.md"), "UI screenshot review\n$(touch pwned)");
    const match = parseInvocation("orca-worker-start --name feat-card --title 'Card' --spec-file job.md");
    const summary = summarizeTask(match, dir);
    assert.match(summary, /UI screenshot review/);
    assert.equal(fs.existsSync(path.join(dir, "pwned")), false);
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
    assert.equal(callCount(f.calls), 1);
  } finally { f.dispose(); }
});

test("different Dispatch names cause independent classification", () => {
  const f = fixture();
  try {
    for (const name of ["fix-one", "fix-two"]) {
      assert.match(f.run(event("orca-worker-start --name " + name + " --reason 'task'")).stdout, /"deny"/);
    }
    assert.equal(callCount(f.calls), 2);
  } finally { f.dispose(); }
});

test("changed spec content is a different Dispatch and a retry is cached", () => {
  const f = fixture();
  try {
    const cwd = f.dir;
    const command = "orca-worker-start --name same --spec-file job.md";
    fs.writeFileSync(path.join(cwd, "job.md"), "first instruction");
    assert.match(f.run(event(command, "s1", cwd)).stdout, /"deny"/);
    fs.writeFileSync(path.join(cwd, "job.md"), "second instruction");
    assert.match(f.run(event(command, "s1", cwd)).stdout, /"deny"/);
    assert.equal(f.run(event(command, "s1", cwd)).stdout.trim(), "");
    assert.equal(callCount(f.calls), 2);
  } finally { f.dispose(); }
});

test("provider responses outside the known contract fail open with a notice", () => {
  const f = fixture();
  try {
    for (const mode of ["missing-agent", "bad-json", "unknown-kind", "secret-agent", "newline-agent"]) {
      const result = f.run(event("orca-worker-start --name x --reason task"), { FAKE_MODE: mode });
      assertFailOpen(result);
    }
    assert.deepEqual(cachedFiles(f.env), []);
    const valid = f.run(event("orca-worker-start --name codex --reason task"), { FAKE_MODE: "high-risk" });
    assert.match(valid.stdout, /suggested_agent=codex/);
  } finally { f.dispose(); }
});

test("a missing provider stays silent, other failures show a fail-open notice", () => {
  const f = fixture();
  try {
    const missing = f.run(event("orca-worker-start --name fix-a --reason task"),
      { DECISION_ROUTER_PROVIDER_BIN: path.join(f.dir, "no-such-d1") });
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout.trim(), "");
    assertFailOpen(f.run(event("orca-worker-start --name fix-a --reason task"), { FAKE_FAIL: "1" }));
  } finally { f.dispose(); }
});

test("provider timeout, unrelated tools and malformed input fail open", () => {
  const f = fixture();
  try {
    const started = Date.now();
    const timeout = f.run(event("orca-worker-start --name slow --reason task"), { FAKE_SLEEP: "7000" }, 9000);
    assertFailOpen(timeout);
    assert.ok(Date.now() - started < 8000);
    assert.equal(f.run(event("echo hi")).stdout.trim(), "");
    for (const tool of ["Edit", "Write"]) {
      const other = event("orca-worker-start --name fix-b --reason task");
      other.tool_name = tool;
      assert.equal(f.run(other).stdout.trim(), "");
    }
    assert.equal(f.run({ session_id: "s", cwd: "/tmp", tool_name: "Bash" }).stdout.trim(), "");
    const bad = spawnSync(process.execPath, [HOOK], { input: "{", encoding: "utf8", timeout: 3000, env: f.env });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout.trim(), "");
  } finally { f.dispose(); }
});

test("short input within the byte bound skips the tokenizer", () => {
  const f = fixture();
  try {
    const result = f.run(event("orca-worker-start --name tiny --reason 'fix typo'"));
    assert.match(result.stdout, /"deny"/);
    assert.equal(callCount(f.tokenCalls), 0);
    assert.equal(callCount(f.calls), 1);
  } finally { f.dispose(); }
});

test("a whitespace-only instruction is not sent to the provider", () => {
  const f = fixture();
  try {
    const result = f.run(event("orca-worker-start --name ws --reason '   '"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
    assert.equal(callCount(f.calls), 0);
  } finally { f.dispose(); }
});

test("a long instruction is trimmed to the measured token budget, keeping both ends", () => {
  const f = fixture();
  try {
    const long = "HEAD\n" + "あ".repeat(20_000) + "\nTAIL";
    const command = "orca-worker-start --name long --reason '" + long + "'";
    const result = f.run(event(command), { FAKE_ARGV: path.join(f.dir, "argv.json"), FAKE_MAX_TASK_CHARS: "700" });
    assert.equal(result.status, 0, result.stderr);
    const reason = reasonOf(result);
    assert.match(reason, /input_truncated=true/);
    assert.match(reason, /risk=medium/);
    assert.doesNotMatch(reason, /risk=low/);
    assert.match(reason, /トークン上限/);
    assert.match(reason, /途中の条件/);
    const task = taskArgument(f);
    assert.ok(task.startsWith("HEAD"), task.slice(0, 40));
    assert.ok(task.endsWith("TAIL"), task.slice(-40));
    assert.ok(task.includes(TRIM_MARKER));
    assert.ok(Math.ceil(Array.from(task).length * 0.55) <= BUDGET);
    assert.equal(callCount(f.tokenCalls) >= 1, true);
    assert.equal(f.run(event(command)).stdout.trim(), "");
    const high = f.run(event("orca-worker-start --name long-high --reason '" + long + "'"), { FAKE_MODE: "high-risk" });
    assert.match(reasonOf(high), /risk=high/);
  } finally { f.dispose(); }
});

test("wide characters are trimmed by tokens, not by a fixed character count", () => {
  const f = fixture();
  try {
    const command = "orca-worker-start --name wide --reason '" + "𠮟".repeat(600) + "'";
    const result = f.run(event(command), { FAKE_ARGV: path.join(f.dir, "argv.json"),
      FAKE_TOKENIZE_RATIO: "4", FAKE_MAX_TASK_CHARS: "90" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(reasonOf(result), /input_truncated=true/);
    const task = taskArgument(f);
    assert.ok(Array.from(task).length <= 90, String(Array.from(task).length));
    assert.ok(Math.ceil(Array.from(task).length * 4) <= BUDGET);
  } finally { f.dispose(); }
});

test("input that fits the token budget is not marked truncated", () => {
  const f = fixture();
  try {
    const body = "word ".repeat(200);
    const result = f.run(event("orca-worker-start --name fits --reason '" + body + "'"),
      { FAKE_ARGV: path.join(f.dir, "argv.json"), FAKE_TOKENIZE_RATIO: "0.25" });
    assert.equal(result.status, 0, result.stderr);
    const reason = reasonOf(result);
    assert.doesNotMatch(reason, /input_truncated=true/);
    assert.match(reason, /risk=low/);
    assert.equal(taskArgument(f), body);
  } finally { f.dispose(); }
});

test("the token budget can be raised to match a larger d1 batch", () => {
  const f = fixture();
  try {
    const body = "あ".repeat(1_000);
    const underDefault = f.run(event("orca-worker-start --name budget-default --reason '" + body + "'"),
      { FAKE_ARGV: path.join(f.dir, "argv.json") });
    assert.equal(underDefault.status, 0, underDefault.stderr);
    assert.match(reasonOf(underDefault), /input_truncated=true/);

    const raised = f.run(event("orca-worker-start --name budget-raised --reason '" + body + "'"),
      { FAKE_ARGV: path.join(f.dir, "argv.json"), DECISION_ROUTER_MAX_TASK_TOKENS: "1200" });
    assert.equal(raised.status, 0, raised.stderr);
    assert.doesNotMatch(reasonOf(raised), /input_truncated=true/);
    assert.equal(taskArgument(f), body);
  } finally { f.dispose(); }
});

test("an out-of-range budget setting is ignored instead of loosening the limit", () => {
  const f = fixture();
  try {
    const body = "あ".repeat(1_000);
    for (const value of ["10", "5000", "abc", "1200.5"]) {
      const result = f.run(event("orca-worker-start --name budget-" + value.replace(".", "-") + " --reason '" + body + "'"),
        { FAKE_ARGV: path.join(f.dir, "argv.json"), DECISION_ROUTER_MAX_TASK_TOKENS: value });
      assert.equal(result.status, 0, result.stderr);
      assert.match(reasonOf(result), /input_truncated=true/, value);
      assert.ok(Math.ceil(Array.from(taskArgument(f)).length * 0.55) <= BUDGET, value);
    }
  } finally { f.dispose(); }
});

test("budget boundaries and empty values behave as documented", () => {
  const f = fixture();
  try {
    const body = "あ".repeat(1_000);
    const cases = [["64", 64], ["4096", 4096], ["100", 100], ["", 357]];
    for (const [value, expected] of cases) {
      const result = f.run(event("orca-worker-start --name edge-" + (value || "empty") + " --reason '" + body + "'"),
        { FAKE_ARGV: path.join(f.dir, "argv.json"), DECISION_ROUTER_MAX_TASK_TOKENS: value });
      assert.equal(result.status, 0, result.stderr);
      const chars = Array.from(taskArgument(f)).length;
      assert.ok(Math.ceil(chars * 0.55) <= expected, value + " -> " + chars);
      if (expected < 550) assert.match(reasonOf(result), /input_truncated=true/, value);
      else assert.doesNotMatch(reasonOf(result), /input_truncated=true/, value);
    }
  } finally { f.dispose(); }
});

test("raising the budget re-judges a dispatch instead of reusing cached advice", () => {
  const f = fixture();
  try {
    const body = "あ".repeat(1_000);
    const command = "orca-worker-start --name budget-cache --reason '" + body + "'";
    const first = f.run(event(command), { FAKE_ARGV: path.join(f.dir, "argv.json") });
    assert.equal(first.status, 0, first.stderr);
    assert.match(reasonOf(first), /input_truncated=true/);
    assert.equal(f.run(event(command), { FAKE_ARGV: path.join(f.dir, "argv.json") }).stdout.trim(), "",
      "the same dispatch inside the cache window must stay silent");

    const raised = f.run(event(command),
      { FAKE_ARGV: path.join(f.dir, "argv.json"), DECISION_ROUTER_MAX_TASK_TOKENS: "1200" });
    assert.equal(raised.status, 0, raised.stderr);
    assert.doesNotMatch(raised.stdout.trim(), /^$/, "a new budget must produce advice, not a cache hit");
    assert.match(reasonOf(raised), /risk=/);
  } finally { f.dispose(); }
});

test("the byte fallback also honours a raised budget", () => {
  const f = fixture();
  try {
    const long = "あ".repeat(2_000);
    const result = f.run(event("orca-worker-start --name bytes-raised --reason '" + long + "'"),
      { FAKE_ARGV: path.join(f.dir, "argv.json"), FAKE_TOKENIZE_FAIL: "1",
        DECISION_ROUTER_MAX_TASK_TOKENS: "900", FAKE_MAX_TASK_CHARS: "5000" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(reasonOf(result), /input_truncated=true/);
    const bytes = Buffer.byteLength(taskArgument(f), "utf8");
    assert.ok(bytes > 357 && bytes <= 900, String(bytes));
  } finally { f.dispose(); }
});

test("an unreachable tokenizer falls back to a guaranteed byte budget", () => {
  const f = fixture();
  try {
    const long = "あ".repeat(3_000);
    const result = f.run(event("orca-worker-start --name bytes --reason '" + long + "'"),
      { FAKE_ARGV: path.join(f.dir, "argv.json"), FAKE_TOKENIZE_FAIL: "1", FAKE_MAX_TASK_CHARS: "121" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(reasonOf(result), /input_truncated=true/);
    const task = taskArgument(f);
    assert.ok(Buffer.byteLength(task, "utf8") <= BUDGET);
    assert.ok(task.includes(TRIM_MARKER));
  } finally { f.dispose(); }
});

test("high-risk terms in a dropped middle still raise risk and effort", () => {
  const f = fixture();
  try {
    const long = "HEAD\n" + "本番にデプロイして課金を止める\n" + "あ".repeat(3_000) + "\nTAIL";
    const result = f.run(event("orca-worker-start --name danger --reason '" + long + "'"),
      { FAKE_MAX_TASK_CHARS: "700" });
    assert.equal(result.status, 0, result.stderr);
    const reason = reasonOf(result);
    assert.match(reason, /risk=high/);
    assert.match(reason, /effort=high/);
    assert.match(reason, /high_risk_input=true/);
    assert.match(reason, /input_truncated=true/);
    assert.doesNotMatch(reason, /risk=low/);
  } finally { f.dispose(); }
});

test("unreadable or oversized spec input is incomplete and never low risk", () => {
  const f = fixture();
  try {
    const cwd = f.dir;
    const missing = "orca-worker-start --name spec-missing --reason 'simple task' --spec-file missing.md";
    const missingReason = reasonOf(f.run(event(missing, "s1", cwd)));
    assert.match(missingReason, /input_incomplete=true/);
    assert.match(missingReason, /risk=medium/);
    assert.doesNotMatch(missingReason, /risk=low/);
    assert.match(missingReason, /読み取れない/);
    assert.equal(f.run(event(missing, "s1", cwd)).stdout.trim(), "");

    fs.writeFileSync(path.join(cwd, "big.md"), "x".repeat(70_000));
    const big = f.run(event("orca-worker-start --name spec-big --reason task --spec-file big.md", "s1", cwd));
    assert.match(reasonOf(big), /input_incomplete=true/);

    fs.mkdirSync(path.join(cwd, "adir"));
    const directory = f.run(event("orca-worker-start --name spec-dir --reason task --spec-file adir", "s1", cwd));
    assert.match(reasonOf(directory), /input_incomplete=true/);
  } finally { f.dispose(); }
});

test("cache keeps only validated advice and no task text or secrets", () => {
  const f = fixture();
  try {
    const secret = "SECRET_MARKER_123";
    const result = f.run(event("orca-worker-start --name secret --reason '" + secret + "'"), { FAKE_MODE: "echo-extra" });
    assert.match(result.stdout, /"deny"/);
    const files = cachedFiles(f.env);
    assert.equal(files.length, 1);
    const raw = fs.readFileSync(files[0], "utf8");
    assert.equal(raw.includes(secret), false);
    const record = JSON.parse(raw);
    assert.deepEqual(Object.keys(record).sort(), ["advice", "when"]);
    assert.deepEqual(Object.keys(record.advice).sort(), ["effort", "kind", "risk", "suggested_agent"]);
    assert.equal(fs.statSync(files[0]).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.env.DECISION_ROUTER_CACHE_DIR).mode & 0o777, 0o700);
  } finally { f.dispose(); }
});

test("cache expires after thirty minutes and ignores malformed records", () => {
  const f = fixture();
  try {
    const invocation = parseInvocation("orca-worker-start --name ttl --reason task");
    const ev = event("orca-worker-start --name ttl --reason task");
    const key = dispatchKey(ev, invocation);
    writeCache(key, { when: Date.now() - 29 * 60_000, advice: ADVICE }, f.env);
    assert.ok(readCache(key, f.env));
    writeCache(key, { when: Date.now() - 30 * 60_000 - 1, advice: ADVICE }, f.env);
    assert.equal(readCache(key, f.env), null);
    writeCache(key, { when: Date.now() + 120_000, advice: ADVICE }, f.env);
    assert.equal(readCache(key, f.env), null);
    writeCache(key, { when: Date.now(), advice: { ok: true } }, f.env);
    assert.equal(readCache(key, f.env), null);

    writeCache(key, { when: Date.now() - 30 * 60_000 - 1, advice: ADVICE }, f.env);
    assert.match(f.run(ev).stdout, /"deny"/);
    writeCache(key, { when: Date.now() - 29 * 60_000, advice: ADVICE }, f.env);
    assert.equal(f.run(ev).stdout.trim(), "");
  } finally { f.dispose(); }
});

test("status reports ready only for a valid advice contract", () => {
  const f = fixture();
  try {
    assert.equal(status(f.env).ready, true);
    assert.equal(status({ ...f.env, DECISION_ROUTER_PROVIDER_BIN: path.join(f.dir, "missing") }).ready, false);
    assert.equal(status({ ...f.env, FAKE_MODE: "missing-agent" }).ready, false);
  } finally { f.dispose(); }
});

test("concurrent dispatches leave one parseable cache record", async () => {
  const f = fixture();
  const runAsync = (name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: f.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event("orca-worker-start --name " + name + " --reason task")));
  });
  try {
    const [one, two] = await Promise.all([runAsync("same"), runAsync("same")]);
    let denied = 0;
    for (const result of [one, two]) {
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout === "" || /"deny"/.test(result.stdout), result.stdout);
      if (/"deny"/.test(result.stdout)) denied += 1;
    }
    assert.ok(denied >= 1);
    const files = cachedFiles(f.env);
    assert.equal(files.length, 1);
    const record = JSON.parse(fs.readFileSync(files[0], "utf8"));
    assert.equal(record.advice.kind, "routine");
    assert.equal(f.run(event("orca-worker-start --name same --reason task")).stdout.trim(), "");
  } finally { f.dispose(); }
});

test("dispatch key ignores model and effort and includes instruction content", () => {
  const invocation = { name: "fix-x", task: null, followup: null, specFiles: [] };
  assert.equal(dispatchKey(event("abc"), invocation), dispatchKey(event("different text"), invocation));
  const withText = { ...invocation, title: "T", reason: "R" };
  assert.notEqual(dispatchKey(event("same"), invocation), dispatchKey(event("same"), withText));
});

// Requires the real local d1 service; run with DECISION_ROUTER_TEST_LOCAL=1.
test("real local d1 accepts the measured token budget", {
  skip: process.env.DECISION_ROUTER_TEST_LOCAL !== "1"
}, () => {
  const text = "READMEの誤字を修正する。".repeat(200).slice(0, 3000);
  const fitted = fitToTokenBudget(text, process.env);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.text.length < text.length);
  const advice = routeTask(fitted.text, process.env);
  assert.ok(advice, "expected advice from the real d1 service");
  assert.ok(["routine", "implementation", "investigation", "visual", "critical"].includes(advice.kind));
});
