# Loop Breaker

A Claude Code mod that stops the agent from going round in circles.

- **Repeat failures.** Suppose the same tool call, with exactly the same arguments, fails twice in a row with the same error, and the code hasn't changed in between. The third try is refused, and the model is told to fix the cause before running it again. A successful edit, a different error or a success all reset the count, so normal fix-and-retest work is never blocked.
- **Edit oscillation.** Suppose edits to one file keep undoing each other (A→B, B→A, A→B). The fourth flip is refused, and the model has to pick a version based on evidence.
- **Stuck meter.** A band above the prompt shows the current streak, starting from the second failure, with an `unstick` button.
- `/unstick` clears all history. It runs immediately, even mid-turn. A new prompt from you also clears it. Background notifications and scheduled prompts do not.

History is kept separately for each agent, so a looping subagent is caught too and doesn't mix with the main thread. Only short hashes are stored, never file contents.

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
