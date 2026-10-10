import type { Register } from 'claude-code'

// The model's tool. Each script runs in runner/run.ts (QuickJS via pi-codemode) in its own
// process, since a hooks module has no WebAssembly; every tool call the script makes comes
// back here and goes through $.tool.call, so permission rules, dialogs and the auto-mode
// classifier judge it exactly like a direct call.
const NAME = 'run'
const SELF = `mcp__codemode__${NAME}`

// Tools a script may not reach: itself (no recursion) and tools that need the person or
// change the session's mode.
const BLOCKED = new Set([SELF, 'Agent', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree'])

// Keys the engine reads beside a tool's arguments. `consent` is taken as the person's own
// words by the permission path, so a script must never be able to set any of them.
const RESERVED = ['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta']

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_RESULT_CHARS = 30_000

const DESCRIPTION = `Run JavaScript that calls other tools, in a QuickJS sandbox. The input \`code\` is the body of an async function: top-level \`await\` and \`return\` work. No Node, file system, network, or timers: the only way out is \`tools\`.
- \`await tools.<Name>(args)\` calls any tool you can call directly (\`tools.Read({ file_path })\`, \`tools.Bash({ command, description })\`, \`tools.mcp__server__tool({...})\`), with the same arguments, and resolves to the text that call returns. It rejects with an Error when the tool fails or is denied. Each call goes through the normal permission checks. Names with \`-\` are also reachable as \`tools["mcp__a-b__c"]\` or with \`_\`.
- For a deferred tool, load its schema with ToolSearch first, as for a direct call.
- \`text(value)\`, \`console.log(...)\` and \`return\` make the output; \`ALL_TOOLS\` lists the callable tools, and \`await searchTools(query)\` returns the best matches as \`{ name, description }\`.
Use it to batch independent calls (\`Promise.allSettled\`), chain calls, loop, or filter large results so only the summary reaches you. For one or two calls you need to reason between, call the tools directly. Calls already made are not undone when a script fails.`

type CallLine = { id: number; name: string; args: unknown }
type Done = {
  ok: boolean
  value?: unknown
  error?: { kind: string; message: string; stack?: string }
  output: { type: string; text?: string; console?: boolean }[]
  calls: { name: string; status: 'ok' | 'error' | 'cancelled' }[]
}

function clip(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  const half = MAX_RESULT_CHARS / 2
  return `${text.slice(0, half)}\n… [${text.length - MAX_RESULT_CHARS} chars cut] …\n${text.slice(-half)}`
}

function format(done: Done | undefined, late: string[], stderr: string, ms: number): string {
  // A tool call already running cannot be cancelled ($.tool.call takes no signal), so a call
  // the script stopped waiting for runs to its end: say what it did.
  const lateLine = late.length ? `Tool calls that finished after the script stopped waiting for them: ${late.join('; ')}` : ''
  if (!done) return clip([`Script runner ended without a result after ${ms} ms.`, stderr, lateLine].filter(Boolean).join('\n'))
  const lines = [done.ok ? `Script completed in ${ms} ms.` : `Script failed after ${ms} ms (${done.error?.kind}): ${done.error?.message}`]
  if (!done.ok && done.error?.stack) lines.push(done.error.stack)
  const texts = done.output.filter(o => o.type === 'text' && !o.console).map(o => o.text ?? '')
  const logs = done.output.filter(o => o.console).map(o => o.text ?? '')
  if (done.output.some(o => o.type === 'image')) lines.push('(image output is not passed through yet)')
  if (texts.length) lines.push(texts.join('\n'))
  if (done.ok && done.value !== undefined) lines.push(typeof done.value === 'string' ? done.value : JSON.stringify(done.value, null, 2))
  if (logs.length) lines.push(`<console_output>\n${logs.join('\n')}\n</console_output>`)
  if (!done.ok && done.calls.length) lines.push(`Tool calls made before the failure (not undone): ${done.calls.map(c => `${c.name} (${c.status})`).join(', ')}`)
  else if (done.calls.some(c => c.status === 'cancelled')) lines.push(`Calls the script did not wait for: ${done.calls.filter(c => c.status === 'cancelled').map(c => c.name).join(', ')}`)
  if (lateLine) lines.push(lateLine)
  return clip(lines.join('\n'))
}

export const register: Register = on => {
  on('session.start', ($, e, next) =>
    $.tool
      .register({
        name: NAME,
        description: DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'The script: the body of an async function.' },
            timeout_ms: { type: 'number', description: `Deadline for the script. Default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS}. A tool call already running is not cancelled: it finishes, and the result says how.` },
          },
          required: ['code'],
        },
        isDeferred: false,
      })
      .then(() => next(e)),
  )

  on('tool.call', { tool: 'mcp__codemode__run' }, async ($, e) => {
    const { code, timeout_ms } = e as unknown as { code: string; timeout_ms?: number }
    const timeoutMs = Math.min(Math.max(Number(timeout_ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
    const tools = (await $.tool.list()).filter(t => !BLOCKED.has(t.name))
    const allowed = new Set(tools.map(t => t.name))
    const started = Date.now()

    let dir = ''
    let isRunnerGone = false
    const late: string[] = []
    let done: Done | undefined
    let stderr = ''
    let buffer = ''
    const pending: Promise<void>[] = []

    const answer = async ({ id, name, args }: CallLine) => {
      if (!Number.isSafeInteger(id) || id <= 0 || !dir) return
      let reply: { ok: true; text: string } | { ok: false; error: string }
      try {
        if (!allowed.has(name)) throw new Error(`${name} is not callable from codemode`)
        const clean = { ...(args && typeof args === 'object' ? (args as Record<string, unknown>) : {}) }
        for (const key of RESERVED) delete clean[key]
        const r = await $.tool.call({ ...clean, tool: name } as never)
        if (r.deny !== undefined) reply = { ok: false, error: `denied: ${r.deny}` }
        else if (r.isError) reply = { ok: false, error: r.text ?? JSON.stringify(r.result) }
        else reply = { ok: true, text: r.text ?? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result)) }
      } catch (err) {
        reply = { ok: false, error: String(err instanceof Error ? err.message : err) }
      }
      if (isRunnerGone) {
        late.push(`${name}: ${reply.ok ? 'ok' : reply.error.slice(0, 200)}`)
        return
      }
      // The runner may exit between the check and the write; a failed write then means the same.
      await $.fs.write(`${dir}/r${id}.json`, JSON.stringify(reply)).catch(() => {
        late.push(`${name}: ${reply.ok ? 'ok' : reply.error.slice(0, 200)}`)
      })
    }

    const child = $.process.spawn({
      argv: ['bun', `${$.plugin.root}/runner/run.ts`],
      input: JSON.stringify({ code, timeoutMs, tools }),
    })
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        stderr = (stderr + text).slice(-4000)
        continue
      }
      buffer += text
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.startsWith('@@DIR ') && !dir) dir = line.slice(6)
        else if (line.startsWith('@@CALL ')) pending.push(answer(JSON.parse(line.slice(7))))
        else if (line.startsWith('@@DONE ')) done = JSON.parse(line.slice(7))
      }
    }
    // The runner and its temp dir are gone; calls still running finish and are reported as late.
    isRunnerGone = true
    await Promise.allSettled(pending)

    return { result: format(done, late, stderr, Date.now() - started) }
  }).catch(($, e, next) => ({ result: `codemode failed: ${String(next.error?.message ?? 'unknown error')}` }))
}
