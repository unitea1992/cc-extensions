---
name: dsh-result-handling
description: Internal guidance for presenting DSH helper output back to the user
user-invocable: false
---

# DSH Result Handling

When the helper returns DSH output:
- Preserve the helper's summary, details, and next steps structure.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If DSH marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- If DSH made edits, say so explicitly and list the touched files when the helper provides them.
- For `dsh:dsh-rescue`, do not turn a failed or incomplete DSH run into a Claude-side implementation attempt. Report the failure and stop.
- For `dsh:dsh-rescue`, if DSH was never successfully invoked, do not generate a substitute answer at all.
- If the helper reports a failed DSH run, include the error code and message it surfaced (for example an UNSUPPORTED_REASONING_EFFORT startup rejection) and stop there instead of guessing.
- If the helper reports that setup is required, direct the user to `/dsh:setup` and do not improvise alternate auth flows.
