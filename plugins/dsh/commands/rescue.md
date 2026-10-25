---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the DSH rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <provider/model>] [--effort <level>] [--write|--read-only] [--permission-mode <mode>] [--timeout <seconds>] [what DSH should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `dsh:dsh-rescue` subagent via the `Agent` tool (`subagent_type: "dsh:dsh-rescue"`), forwarding the raw user request as the prompt.
`dsh:dsh-rescue` is a subagent, not a skill — do not call `Skill(dsh:dsh-rescue)` (no such skill) or `Skill(dsh:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be DSH's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `dsh:dsh-rescue` subagent in the background.
- If the request includes `--wait`, run the `dsh:dsh-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model`, `--effort`, `--write`, `--read-only`, `--permission-mode`, and `--timeout` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- `--permission-mode` and `--write`/`--read-only` are mutually exclusive in `task`. If the request carries both, ask the user to pick one instead of forwarding a contradictory combination.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting DSH, check for a resumable rescue session from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current DSH session or start a new one.
- The two choices must be:
  - `Continue current DSH session`
  - `Start a new DSH session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current DSH session (Recommended)` first.
- Otherwise put `Start a new DSH session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" task ...` and return that command's stdout as-is.
- Return the DSH companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/dsh:status`, fetch `/dsh:result`, call `/dsh:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort. Effort levels are model-specific; DSH rejects an unsupported value when the run starts.
- Leave the model unset unless the user explicitly asks for one. DSH models use the `provider/model` form; `/dsh:setup` lists the available ones.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the `task` command fails because DSH is missing or has no usable setup, it exits non-zero and prints the reason on stderr (the error says to rerun `/dsh:setup`). The subagent returns that error verbatim; do not replace it with a silent empty response, and do not retry with an improvised setup.
- If the user did not supply a request, ask what DSH should investigate or fix.
