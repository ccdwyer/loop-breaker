# Loop Breaker

A Claude Code mod that stops the agent from going round in circles.

- **Repeat failures.** If the same tool call, with exactly the same arguments, fails twice in a row with the same error (timings, temp paths and saved-output paths are ignored when comparing), and nothing in the code has changed since, the third try is refused. The model is told to fix the cause first. Failures from runs that started before the code changed are ignored. These all reset the count, so normal fix-and-retest work is never blocked:
  - a successful Edit, Write or NotebookEdit
  - a shell command that changed files
  - a change made by any agent, including a subagent
  - a different error
  - a success

  Interrupted calls and commands moved to the background are not counted.
- **Oscillation.** An Edit or Write can put a file back to exactly the version it had before the last change. If the whole file keeps flipping between two versions three times in a row, the fourth flip is refused, and the model has to pick a version based on evidence. Small, similar swaps at different places in a file don't count, and a change by anyone else breaks the chain.
- **Stuck meter.** A line above the prompt shows the current streak, starting from the second failure, with an `unstick` button. It only shows the program name and a word or two, never tokens. It is drawn above any other mod's band, without hiding it.
- **`/unstick`** clears all history and runs immediately, even mid-turn. A new prompt from you, `/clear` or a resume also clears it. Background notifications and scheduled prompts do not.

Known limits:
- Calls sent in parallel in one message all run.
- A shell command that writes files and then fails is counted as a plain failure, because its result is only error text.
- Notebook edits reset the streaks but aren't checked for oscillation.
- Very large files (over about 4 MiB, or too big for the host to diff) aren't checked for oscillation.

History is kept per agent, and a subagent's history is dropped when it finishes. It lives in memory only (short hashes, never file contents) and starts over on a hot reload.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install loop-breaker@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```
