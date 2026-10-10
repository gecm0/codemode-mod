// Runs one codemode script in pi-codemode's QuickJS sandbox. Spawned per script by the mod,
// because a hooks module has no WebAssembly.
//
// Protocol: stdin is one JSON request { code, timeoutMs, tools: [{ name, description }] }.
// stdout lines: "@@DIR <path>" once, "@@CALL <json>" per tool call, "@@DONE <json>" at the end.
// The mod answers each call by writing <dir>/r<id>.json as { ok, text } or { ok: false, error }.
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Request = { code: string; timeoutMs: number; tools: { name: string; description: string }[] }
type Reply = { ok: true; text: string } | { ok: false; error: string }

const request: Request = JSON.parse(await Bun.stdin.text())
const dir = mkdtempSync(join(tmpdir(), 'codemode-'))
const emit = (kind: string, value: unknown) => process.stdout.write(`@@${kind} ${typeof value === 'string' ? value : JSON.stringify(value)}\n`)

let nextId = 0
// ponytail: 10 ms file polling, fine for tool calls that take far longer; fs.watch if latency matters.
async function awaitReply(id: number, signal: AbortSignal): Promise<Reply> {
  const path = join(dir, `r${id}.json`)
  while (!signal.aborted) {
    try {
      const reply = JSON.parse(readFileSync(path, 'utf8')) as Reply
      rmSync(path, { force: true })
      return reply
    } catch {
      // Missing, or still being written: try again.
      await Bun.sleep(10)
    }
  }
  throw new Error('aborted')
}

// pi-codemode's error for an unknown `tools.x` points to `searchTools(query)`, so provide it.
// Okapi BM25 ported from Pi's tool search (packages/coding-agent/src/extensions/tool-search/tool.ts,
// MIT). Documents are a tool's name and description: the mod has no input schemas to add.
const STOP_WORDS = new Set('a an and are as at be by for from in is it of on or that the this to with'.split(' '))

// Naive singular form, so `issues` matches `issue` and `searches` matches `search`.
function stem(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2)
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1)
  return term
}

// Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words.
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem)
}

const K1 = 1.2
const B = 0.75
const documentTerms = request.tools.map(tool => {
  const counts = new Map<string, number>()
  for (const term of tokenize(`${tool.name} ${tool.name.replaceAll('_', ' ')} ${tool.description}`)) counts.set(term, (counts.get(term) ?? 0) + 1)
  return counts
})
const lengths = documentTerms.map(counts => [...counts.values()].reduce((sum, count) => sum + count, 0))
const averageLength = lengths.reduce((sum, length) => sum + length, 0) / (lengths.length || 1) || 1

function searchTools(query: unknown, limit = 8) {
  const terms = [...new Set(tokenize(String(query ?? '')))]
  const idf = new Map(
    terms.map(term => {
      const frequency = documentTerms.filter(counts => counts.has(term)).length
      return [term, Math.log(1 + (documentTerms.length - frequency + 0.5) / (frequency + 0.5))] as const
    }),
  )
  return request.tools
    .map((tool, index) => {
      let score = 0
      for (const term of terms) {
        const count = documentTerms[index]!.get(term)
        if (!count) continue
        const norm = K1 * (1 - B + (B * lengths[index]!) / averageLength)
        score += idf.get(term)! * ((count * (K1 + 1)) / (count + norm))
      }
      return { name: tool.name, description: tool.description.split('\n')[0]!.slice(0, 200), score }
    })
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ name, description }) => ({ name, description }))
}

const sandbox = new CodemodeSandbox({
  timeoutMs: request.timeoutMs,
  memoryLimitBytes: 256 * 1024 * 1024,
  globals: [
    {
      name: 'searchTools',
      description: 'Find tools by topic.',
      // spread: pi-codemode passes only the first argument otherwise, which would drop `limit`.
      spread: true,
      execute: async (args: unknown) => {
        const [query, limit] = args as [unknown, unknown]
        return searchTools(query, Math.max(1, Math.min(Number(limit) || 8, 50)))
      },
    },
  ],
  tools: request.tools.map(tool => ({
    ...tool,
    execute: async (args: unknown, { signal }: { signal: AbortSignal }) => {
      const id = ++nextId
      emit('CALL', { id, name: tool.name, args })
      const reply = await awaitReply(id, signal)
      if (!reply.ok) throw new Error(reply.error)
      return reply.text
    },
  })),
})

emit('DIR', dir)
try {
  const result = await sandbox.execute(request.code)
  emit('DONE', result)
} finally {
  await sandbox.close()
  rmSync(dir, { recursive: true, force: true })
}
