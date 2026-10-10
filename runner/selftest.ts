// Self-check of run.ts's protocol, playing the mod's part: `bun runner/selftest.ts`.
// Exits non-zero on the first failed check.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS = [{ name: 'echo', description: 'Echo.' }, { name: 'echo_loud', description: 'Echo loudly.' }]

// Runs one script; `echo` replies `got <v>`, `{ fail }` replies an error, `{ slow }` never replies.
async function run(code: string, timeoutMs = 5000): Promise<any> {
  const child = Bun.spawn(['bun', join(import.meta.dir, 'run.ts')], { stdin: 'pipe', stdout: 'pipe' })
  child.stdin.write(JSON.stringify({ code, timeoutMs, tools: TOOLS }))
  child.stdin.end()
  let dir = ''
  let done: any
  let buffer = ''
  for await (const chunk of child.stdout) {
    buffer += new TextDecoder().decode(chunk)
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.startsWith('@@DIR ')) dir = line.slice(6)
      if (line.startsWith('@@CALL ')) {
        const { id, args } = JSON.parse(line.slice(7))
        if (args.slow) continue
        const reply = args.fail ? { ok: false, error: 'boom' } : { ok: true, text: `got ${args.v}` }
        writeFileSync(join(dir, `r${id}.json`), JSON.stringify(reply))
      }
      if (line.startsWith('@@DONE ')) done = JSON.parse(line.slice(7))
    }
  }
  assert.equal(await child.exited, 0, 'runner exits 0')
  assert.ok(done, 'runner reports @@DONE')
  return done
}

const main = await run(`
  const [a, b] = await Promise.all([tools.echo({ v: 1 }), tools.echo({ v: 2 })])
  let failed = ''
  try { await tools.echo({ fail: true }) } catch (e) { failed = e.message }
  const found = await searchTools('echo', 1)
  let unknown = ''
  try { tools.nope } catch (e) { unknown = e.message }
  return { a, b, failed, found, unknown }
`)
assert.equal(main.ok, true, 'script succeeds')
assert.equal(main.value.a, 'got 1', 'parallel call a')
assert.equal(main.value.b, 'got 2', 'parallel call b')
assert.equal(main.value.failed, 'boom', 'an error reply rejects in the script')
assert.deepEqual(main.value.found.map((t: any) => t.name), ['echo'], 'searchTools ranks and honors limit')
assert.match(main.value.unknown, /searchTools/, 'unknown tool error points to searchTools')

const timedOut = await run('while (true) {}', 500)
assert.equal(timedOut.ok, false)
assert.equal(timedOut.error.kind, 'timeout', 'a CPU loop is cut at the deadline')

// What register.ts reports as "calls the script did not wait for".
const unawaited = await run(`tools.echo({ slow: true }); return 'returned'`)
assert.equal(unawaited.ok, true)
assert.deepEqual(unawaited.calls.map((c: any) => c.status), ['cancelled'], 'an unawaited call is marked cancelled')

console.log('selftest ok')
