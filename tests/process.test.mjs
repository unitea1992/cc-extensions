import test from "node:test";
import assert from "node:assert/strict";

import { stopProcessGroup, terminateProcessTree } from "../plugins/opencode/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree falls back to the pid when the process is not a group leader", () => {
  const calls = [];
  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push([pid, signal]);
      if (pid < 0) {
        const error = new Error("no such process group");
        error.code = "ESRCH";
        throw error;
      }
    }
  });

  assert.deepEqual(calls, [
    [-4321, "SIGTERM"],
    [4321, "SIGTERM"]
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("stopProcessGroup escalates to SIGKILL when SIGTERM is ignored", () => {
  const sent = [];
  let alive = true;
  const outcome = stopProcessGroup(999, {
    platform: "linux",
    graceMs: 60,
    killWaitMs: 60,
    killImpl(pid, signal) {
      if (signal === 0) {
        if (!alive) {
          const error = new Error("gone");
          error.code = "ESRCH";
          throw error;
        }
        return;
      }
      sent.push([pid, signal]);
      if (signal === "SIGKILL") {
        alive = false;
      }
    }
  });
  assert.deepEqual(sent[0], [-999, "SIGTERM"]);
  assert.ok(sent.some(([, signal]) => signal === "SIGKILL"));
  assert.deepEqual(outcome, { attempted: true, stopped: true, forced: true });
});

test("stopProcessGroup reports a process that survives SIGKILL", () => {
  const outcome = stopProcessGroup(998, { platform: "linux", graceMs: 30, killWaitMs: 30, killImpl() {} });
  assert.equal(outcome.stopped, false);
});

test("stopProcessGroup leaves a reused pid alone when its command line does not match", { skip: process.platform !== "linux" }, async () => {
  const { spawn } = await import("node:child_process");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const outcome = stopProcessGroup(unrelated.pid, { expectCommand: "opencode" });
    assert.equal(outcome.attempted, false);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    process.kill(-unrelated.pid, "SIGKILL");
  }
});
