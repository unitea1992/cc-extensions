---
description: Check whether the local OpenCode CLI is ready, list its models, and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json $ARGUMENTS
```

If the result says OpenCode is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install OpenCode now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install OpenCode (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
curl -fsSL https://opencode.ai/install | bash
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json $ARGUMENTS
```

If OpenCode is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user, including the list of available models.
- If installation was skipped, present the original setup output.
- If OpenCode is installed but reports no models, preserve the guidance to run `!opencode auth login` or to add a provider (including local models) to the OpenCode config.
- Never edit the user's OpenCode config files yourself.
