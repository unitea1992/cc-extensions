import { runCommand } from "./process.mjs";

// The git top-level directory when `cwd` is inside a repository (a worktree gets its own root),
// otherwise `cwd` itself. Job state is kept per workspace root.
export function resolveWorkspaceRoot(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.error || result.status !== 0) {
    return cwd;
  }
  return result.stdout.trim() || cwd;
}
