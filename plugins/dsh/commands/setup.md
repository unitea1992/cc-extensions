---
description: Check whether the local DSH (`dst`) is ready and list its models
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" setup --json
```

Output rules:
- Present the setup output to the user, including the list of available models.
- If DSH is unavailable, tell the user to install DSH and make sure the `dst` command is on PATH. Do not install it yourself.
- If DSH is installed but reports no models, tell the user to configure a model provider for DSH (its credential store, or the provider API keys the profile expects) and rerun `/dsh:setup`.
- Never edit the user's DSH settings or credentials yourself.
