import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  describeFailure,
  launchCommand,
  parseVersion,
  resolveTsc
} from "../plugins/typescript7-lsp/bin/typescript7-lsp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(ROOT, "plugins", "typescript7-lsp");
const WRAPPER = path.join(PLUGIN_DIR, "bin", "typescript7-lsp.mjs");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// A stand-in for an installed `typescript` package whose tsc prints the arguments it received.
function installFakeTypeScript(dir, version) {
  const packageDir = path.join(dir, "node_modules", "typescript");
  fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "typescript", version, type: "module", bin: { tsc: "./bin/tsc" } })
  );
  fs.writeFileSync(
    path.join(packageDir, "bin", "tsc"),
    `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, argv: process.argv.slice(2) }));\n`
  );
  return packageDir;
}

function emptyPath() {
  return makeTempDir("typescript7-lsp-empty-path-");
}

test("the plugin declares a stdio TypeScript server through the wrapper", () => {
  const lsp = readJson(path.join(PLUGIN_DIR, ".lsp.json"));
  const servers = Object.values(lsp);
  assert.equal(servers.length, 1);
  const [server] = servers;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/bin/typescript7-lsp.mjs"]);
  assert.deepEqual(Object.keys(server.extensionToLanguage).sort(), [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
  assert.equal(server.extensionToLanguage[".ts"], "typescript");
  assert.equal(server.extensionToLanguage[".tsx"], "typescriptreact");
  assert.equal(server.extensionToLanguage[".jsx"], "javascriptreact");
  assert.ok(fs.existsSync(WRAPPER), "the wrapper named in .lsp.json must exist");
});

test("the marketplace lists the plugin with a manifest of the same name", () => {
  const marketplace = readJson(path.join(ROOT, ".claude-plugin", "marketplace.json"));
  const entry = marketplace.plugins.find((plugin) => plugin.name === "typescript7-lsp");
  assert.ok(entry, "marketplace.json needs a typescript7-lsp entry");
  assert.equal(entry.source, "./plugins/typescript7-lsp");
  const manifest = readJson(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json"));
  assert.equal(manifest.name, entry.name);
  assert.equal(manifest.version, entry.version);
});

test("parseVersion reads tsc --version output and package versions", () => {
  assert.deepEqual(parseVersion("Version 7.0.2"), [7, 0, 2]);
  assert.deepEqual(parseVersion("6.0.3"), [6, 0, 3]);
  assert.equal(parseVersion("not a version"), null);
});

test("the TypeScript 7 in the workspace is started with --lsp --stdio", () => {
  const workspace = makeTempDir("typescript7-lsp-workspace-");
  const packageDir = installFakeTypeScript(workspace, "7.0.2");
  const { found, rejected } = resolveTsc({ cwd: workspace, env: { PATH: emptyPath() } });
  assert.equal(found.versionText, "7.0.2");
  assert.deepEqual(rejected, []);
  assert.deepEqual(launchCommand(found), {
    command: process.execPath,
    args: [path.join(packageDir, "bin", "tsc"), "--lsp", "--stdio"]
  });
});

test("a TypeScript installed in a parent directory of the workspace is found", () => {
  const root = makeTempDir("typescript7-lsp-parent-");
  installFakeTypeScript(root, "7.1.0");
  const workspace = path.join(root, "apps", "web");
  fs.mkdirSync(workspace, { recursive: true });
  assert.equal(resolveTsc({ cwd: workspace, env: { PATH: emptyPath() } }).found.versionText, "7.1.0");
});

test("a monorepo root without TypeScript falls back to the newest nested install", () => {
  const root = makeTempDir("typescript7-lsp-monorepo-");
  installFakeTypeScript(path.join(root, "apps", "web"), "7.0.1");
  installFakeTypeScript(path.join(root, "apps", "api"), "7.0.2");
  installFakeTypeScript(path.join(root, "packages", "legacy"), "5.9.3");
  const { found, rejected } = resolveTsc({ cwd: root, env: { PATH: emptyPath() } });
  assert.equal(found.versionText, "7.0.2");
  assert.deepEqual(rejected.map((entry) => entry.versionText), ["5.9.3"]);
});

test("the workspace install wins over tsc on PATH", () => {
  const workspace = makeTempDir("typescript7-lsp-workspace-");
  installFakeTypeScript(workspace, "7.0.0");
  const globalRoot = makeTempDir("typescript7-lsp-global-");
  const globalPackage = installFakeTypeScript(globalRoot, "7.9.9");
  const binDir = path.join(globalRoot, "bin");
  fs.mkdirSync(binDir);
  fs.symlinkSync(path.join(globalPackage, "bin", "tsc"), path.join(binDir, "tsc"));
  assert.equal(resolveTsc({ cwd: workspace, env: { PATH: binDir } }).found.versionText, "7.0.0");
});

test("tsc on PATH is used when the workspace has no TypeScript", { skip: process.platform === "win32" }, () => {
  const workspace = makeTempDir("typescript7-lsp-bare-");
  const globalRoot = makeTempDir("typescript7-lsp-global-");
  const globalPackage = installFakeTypeScript(globalRoot, "7.9.9");
  const binDir = path.join(globalRoot, "bin");
  fs.mkdirSync(binDir);
  fs.symlinkSync(path.join(globalPackage, "bin", "tsc"), path.join(binDir, "tsc"));
  const { found } = resolveTsc({ cwd: workspace, env: { PATH: binDir } });
  assert.equal(found.versionText, "7.9.9");
  assert.equal(found.source, "PATH");
});

test("TypeScript below 7 is reported, not started", () => {
  const workspace = makeTempDir("typescript7-lsp-old-");
  installFakeTypeScript(workspace, "6.0.3");
  const { found, rejected } = resolveTsc({ cwd: workspace, env: { PATH: emptyPath() } });
  assert.equal(found, null);
  assert.match(describeFailure(rejected), /needs TypeScript 7 or later[\s\S]*6\.0\.3/);
});

test("a missing TypeScript is reported with how to install it", () => {
  const workspace = makeTempDir("typescript7-lsp-none-");
  const { found, rejected } = resolveTsc({ cwd: workspace, env: { PATH: emptyPath() } });
  assert.equal(found, null);
  assert.match(describeFailure(rejected), /No TypeScript was found[\s\S]*npm install/);
});

test("the wrapper hands the workspace's tsc the --lsp --stdio arguments", () => {
  const workspace = makeTempDir("typescript7-lsp-run-");
  installFakeTypeScript(workspace, "7.0.2");
  const result = run(process.execPath, [WRAPPER], {
    cwd: makeTempDir("typescript7-lsp-elsewhere-"),
    env: { ...process.env, CLAUDE_PROJECT_DIR: workspace, PATH: emptyPath() }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { version: "7.0.2", argv: ["--lsp", "--stdio"] });
});

test("the wrapper exits with an explanation when only TypeScript below 7 exists", () => {
  const workspace = makeTempDir("typescript7-lsp-run-old-");
  installFakeTypeScript(workspace, "6.0.3");
  const result = run(process.execPath, [WRAPPER], {
    cwd: workspace,
    env: { ...process.env, CLAUDE_PROJECT_DIR: workspace, PATH: emptyPath() }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs TypeScript 7 or later[\s\S]*6\.0\.3/);
});
