# codemode

A Claude Code mod that gives the model a codemode tool, as in
[Pi 1.0](https://earendil.com/posts/pi-1-0/). The model writes a short JavaScript
script that calls Claude Code's tools. The script runs in a QuickJS sandbox, and
only what it prints or returns reaches the model's context.

```js
const files = ['a.ts', 'b.ts', 'c.ts']
const results = await Promise.allSettled(files.map(f => tools.Read({ file_path: f })))
return results.map((r, i) => `${files[i]}: ${r.status === 'fulfilled' ? r.value.split('\n').length + ' lines' : r.reason.message}`)
```

## How it works

- The mod registers one tool, `mcp__codemode__run`, which takes `{ code, timeout_ms? }`.
  `code` is the body of an async function, so top-level `await` and `return` work.
- A hooks module has no WebAssembly, so each script runs in its own `bun` process
  (`runner/run.ts`) using [`@earendil-works/pi-codemode`](https://github.com/earendil-works/pi),
  Pi's QuickJS sandbox. The sandbox has no Node, no file system, no network and no timers.
  The only way out is `tools`.
- Each `tools.<Name>(args)` call travels back to the mod as a line on the runner's stdout.
  The mod runs it with `$.tool.call` and writes the reply to a file in the runner's
  temp dir, where the runner polls for it.
- Every call goes through `$.tool.call`, never through `$.mcp.call`, `$.fs` or `$.process`.
  That means permission rules, dialogs and the auto-mode classifier judge it exactly as
  they would a direct call.
- Scripts also get `ALL_TOOLS`, `text()`, `console.*`, `store()`/`load()`, and
  `searchTools(query, limit?)`, which ranks tools by name and description with BM25.

## Safety

- The reserved keys `tool`, `tool_use_id`, `agentId`, `consent` and `requestMeta` are
  stripped from script arguments. The permission path reads `consent` as the user's own
  words, so a script must never be able to set it.
- Scripts cannot reach the codemode tool itself (no recursion), `Agent`,
  `AskUserQuestion`, or the plan-mode and worktree tools.
- QuickJS isolates the JavaScript, not the effects of the tools a script calls. A script
  can make many calls in one go, and calls already made are not undone when a script fails.
- In auto mode, tool calls that need the classifier's verdict, such as most Bash
  commands, are denied: the classifier cannot see the request that led to them, so it
  fails closed. Reads, read-only commands and MCP tools work.
- Limits: a script has 2 minutes by default and 10 at most. The VM heap is capped at
  256 MB, and output is cut to 30,000 characters.
- A tool call that is already running cannot be cancelled, because the mods API's
  `$.tool.call` takes no abort signal. When a script times out, or returns without
  awaiting a call, that call still runs to its end, and the result lists it with its
  outcome.

## Install

Needs [bun](https://bun.sh) on `PATH` and Claude Code 2.1.287 or later.

```sh
git clone git@github.com:gecm0/codemode-mod.git
cd codemode-mod/runner && bun install
claude --plugin-dir /path/to/codemode-mod
```

## Test

```sh
bun runner/selftest.ts         # the runner's protocol: parallel calls, errors, searchTools
claude plugin validate .
```

## Credits

The sandbox is `@earendil-works/pi-codemode`, and the BM25 ranker is ported from Pi's
tool search. Both are MIT, © Mario Zechner.
