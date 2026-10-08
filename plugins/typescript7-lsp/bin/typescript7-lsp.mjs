#!/usr/bin/env node
// Starts the TypeScript 7 language server (`tsc --lsp --stdio`) for Claude Code's LSP tool.
//
// Claude Code can only launch a fixed command, so this wrapper picks the tsc to run: the TypeScript
// 7 or later installed in the workspace first, then the one on PATH. TypeScript below 7 has no
// `--lsp` mode, so it is reported instead of started.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MIN_MAJOR = 7;
// How far below the workspace root to look for a nested install (apps/web, packages/foo, ...).
const NESTED_DEPTH = 2;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Reads the TypeScript package that lives in `packageDir` and returns how to start its tsc.
function inspectPackage(packageDir) {
  const json = readJson(path.join(packageDir, "package.json"));
  if (json?.name !== "typescript") {
    return null;
  }
  const version = parseVersion(json.version);
  const bin = typeof json.bin === "string" ? json.bin : json.bin?.tsc;
  if (!version || !bin) {
    return null;
  }
  return { version, versionText: json.version, script: path.join(packageDir, bin) };
}

function installedAt(dir) {
  return inspectPackage(path.join(dir, "node_modules", "typescript"));
}

function* ancestors(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    yield dir;
    if (dir === path.dirname(dir)) {
      return;
    }
  }
}

function* descendants(root, depth) {
  if (depth === 0) {
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      const dir = path.join(root, entry.name);
      yield dir;
      yield* descendants(dir, depth - 1);
    }
  }
}

function fromPath(env) {
  const names = process.platform === "win32" ? ["tsc.cmd", "tsc.exe", "tsc"] : ["tsc"];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      let real;
      try {
        real = fs.realpathSync(path.join(dir, name));
      } catch {
        continue;
      }
      // A global install is usually a symlink into .../typescript/bin/tsc.
      const found = inspectPackage(path.dirname(path.dirname(real)));
      if (found) {
        return { ...found, source: "PATH" };
      }
      // Anything else (a shim, another wrapper): ask it.
      const result = spawnSync(real, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
      const version = parseVersion(result.stdout);
      if (version) {
        return { version, versionText: version.join("."), command: real, source: "PATH" };
      }
    }
  }
  return null;
}

// Returns { found, rejected }: the tsc to start (version 7 or later), and the older installs seen
// on the way, so the error message can say what was found.
// The workspace is the project Claude Code is open in; the process cwd is only a fallback because
// Claude Code does not document where it starts language servers.
export function resolveTsc({ env = process.env, cwd = env.CLAUDE_PROJECT_DIR || process.cwd() } = {}) {
  const candidates = [];
  for (const dir of ancestors(cwd)) {
    const found = installedAt(dir);
    if (found) {
      candidates.push({ ...found, source: `${dir}` });
      break;
    }
  }
  // A monorepo root usually has no typescript of its own; the packages do.
  const nested = [];
  for (const dir of descendants(path.resolve(cwd), NESTED_DEPTH)) {
    const found = installedAt(dir);
    if (found) {
      nested.push({ ...found, source: dir });
    }
  }
  nested.sort((a, b) => compareVersions(b.version, a.version));
  candidates.push(...nested);
  const usable = (candidate) => candidate.version[0] >= MIN_MAJOR;
  if (!candidates.some(usable)) {
    const onPath = fromPath(env);
    if (onPath) {
      candidates.push(onPath);
    }
  }
  return { found: candidates.find(usable) ?? null, rejected: candidates.filter((candidate) => !usable(candidate)) };
}

export function describeFailure(rejected) {
  const base = `typescript7-lsp needs TypeScript ${MIN_MAJOR} or later, which provides \`tsc --lsp --stdio\`.`;
  if (rejected.length === 0) {
    return `${base} No TypeScript was found in this workspace or on PATH. Install it with \`npm install -D typescript@latest\` (or globally), then restart Claude Code.`;
  }
  const seen = rejected.map((entry) => `${entry.versionText} (${entry.source})`).join(", ");
  return `${base} Only older versions were found: ${seen}. Upgrade TypeScript to ${MIN_MAJOR} or later, or use the typescript-lsp plugin for TypeScript below ${MIN_MAJOR}.`;
}

export function launchCommand(found) {
  return found.script
    ? { command: process.execPath, args: [found.script, "--lsp", "--stdio"] }
    : { command: found.command, args: ["--lsp", "--stdio"] };
}

function main() {
  const { found, rejected } = resolveTsc();
  if (!found) {
    process.stderr.write(`${describeFailure(rejected)}\n`);
    return 1;
  }
  const { command, args } = launchCommand(found);
  const child = spawn(command, args, { stdio: "inherit", shell: !found.script && process.platform === "win32" });
  child.on("error", (error) => {
    process.stderr.write(`typescript7-lsp could not start ${command}: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main();
  if (code !== null) {
    process.exitCode = code;
  }
}
