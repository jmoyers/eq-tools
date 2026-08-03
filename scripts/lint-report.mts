/**
 * lint-report.mts — the measurement + ratchet generator behind eslint.config.mjs.
 *
 *   npm run lint:measure   MEASURE. Re-runs ESLint with the five factoring rules
 *                          pinned to FLOOR values (max: 0), so every function and
 *                          every file reports its ACTUAL metric instead of a
 *                          pass/fail against a guessed threshold. Prints the
 *                          distribution (n, p50…p99, max), a threshold sweep
 *                          (how many sites each candidate would catch), the worst
 *                          offenders, and the correctness-rule violation counts,
 *                          to stdout and to scripts/lint-measure.txt.
 *                          This is where the threshold argument in
 *                          eslint.config.mjs's header comes from. Re-run it
 *                          before ever changing a threshold.
 *
 *   npm run lint:ratchet   GENERATE. Runs ESLint with the REAL config and the
 *                          ratchet suppressed, then writes:
 *                            eslint.ratchet.mjs  — per-file rule-off overrides
 *                            lint-worklist.md    — the same inventory, grouped
 *                                                  into the five refactor waves
 *                          THIS IS NOT A "make lint green" BUTTON. Regenerating
 *                          wholesale silently widens the ratchet, which is the
 *                          one failure mode the design exists to prevent. Only
 *                          the integrator runs it, and only to seed it or to
 *                          re-baseline after a deliberate rule-set change.
 *
 * Both modes set EQ_LINT_NO_RATCHET=1 before ESLint loads the config, so they
 * always see the TRUE state of the tree.
 */

import { ESLint, type Linter } from 'eslint'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

process.env.EQ_LINT_NO_RATCHET = '1'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The five factoring rules, and how to read the measured value out of a message. */
const FACTORING: Record<string, { label: string; metric: RegExp }> = {
  complexity: { label: 'cyclomatic complexity', metric: /complexity of (\d+)/ },
  'max-depth': { label: 'block nesting depth', metric: /too deeply \((\d+)\)/ },
  'max-lines': { label: 'lines per file', metric: /too many lines \((\d+)\)/ },
  'max-lines-per-function': {
    label: 'lines per function',
    metric: /too many lines \((\d+)\)/,
  },
  'max-params': { label: 'parameters', metric: /too many parameters \((\d+)\)/ },
}

/** Candidate thresholds swept in the report, per rule. */
const SWEEP: Record<string, number[]> = {
  complexity: [8, 10, 12, 15, 20],
  'max-depth': [3, 4, 5, 6],
  'max-lines': [300, 400, 500, 600, 800],
  'max-lines-per-function': [60, 80, 100, 120, 150, 200],
  'max-params': [3, 4, 5, 6],
}

/**
 * Refactor-wave partitions. FIRST match wins, so the ORDER is the partition:
 * the combat engine is carved out of src/main before the rest of src/main, and
 * the combat UI out of src/renderer before the rest of the renderer. The final
 * entry is the catch-all, which is why every file lands in exactly one wave.
 */
const WAVES: { id: string; label: string; test: (rel: string) => boolean }[] = [
  {
    id: 'A',
    label: 'src/main/combat/** — the combat engine',
    test: (f) => f.startsWith('src/main/combat/'),
  },
  {
    id: 'B',
    label: 'src/main/** (rest) — main process',
    test: (f) => f.startsWith('src/main/'),
  },
  {
    id: 'C',
    label: 'src/renderer/src/features/combat/** — combat UI',
    test: (f) => f.startsWith('src/renderer/src/features/combat/'),
  },
  {
    id: 'D',
    label: 'src/renderer/** (rest) + overlay',
    test: (f) => f.startsWith('src/renderer/'),
  },
  {
    id: 'E',
    label: 'src/shared + src/preload + scripts + tests',
    test: () => true,
  },
]

/**
 * Pseudo-rule id for a STALE `eslint-disable` comment. ESLint reports those with
 * a null ruleId (it is a linterOption, not a rule), so they cannot be switched
 * off per-rule; the ratchet suppresses `reportUnusedDisableDirectives` for the
 * file instead. Giving them a name lets them appear in every count like any
 * other violation.
 */
const STALE = 'linterOptions/reportUnusedDisableDirectives'

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/')

const waveOf = (f: string) => WAVES.find((w) => w.test(f)) ?? WAVES[WAVES.length - 1]

async function run(overrideConfig?: Linter.Config[]): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({ cwd: ROOT, overrideConfig, errorOnUnmatchedPattern: false })
  return eslint.lintFiles(['.'])
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i] ?? 0
}

function pad(s: string | number, n: number, left = false): string {
  const t = String(s)
  return left ? t.padStart(n) : t.padEnd(n)
}

// ---------------------------------------------------------------------------
// MEASURE
// ---------------------------------------------------------------------------

interface Site {
  v: number
  file: string
  line: number
  what: string
}

interface Measurements {
  /** factoring rule -> every measured value */
  samples: Map<string, number[]>
  /** factoring rule -> every measured site */
  sites: Map<string, Site[]>
  /** non-factoring rule -> violation count */
  other: Map<string, number>
  /** non-factoring rule -> files touched */
  otherFiles: Map<string, Set<string>>
  fatal: number
}

const FLOOR: Linter.Config[] = [
  {
    rules: {
      complexity: ['error', { max: 0 }],
      'max-depth': ['error', { max: 0 }],
      'max-lines': ['error', { max: 0, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: 0, skipBlankLines: true, skipComments: true },
      ],
      'max-params': ['error', { max: 0 }],
    },
  },
]

function collect(results: ESLint.LintResult[]): Measurements {
  const m: Measurements = {
    samples: new Map(),
    sites: new Map(),
    other: new Map(),
    otherFiles: new Map(),
    fatal: 0,
  }
  for (const r of results) {
    const file = rel(r.filePath)
    for (const msg of r.messages) record(m, file, msg)
  }
  return m
}

function record(m: Measurements, file: string, msg: Linter.LintMessage): void {
  if (!msg.ruleId) {
    // A null ruleId here is either a parse error or a stale disable directive.
    // Measurement only cares about the former; the ratchet handles the latter.
    if (msg.fatal) {
      m.fatal++
      console.error(`FATAL ${file}:${msg.line} ${msg.message}`)
    }
    return
  }
  if (FACTORING[msg.ruleId]) recordFactoring(m, msg.ruleId, file, msg)
  else recordOther(m, msg.ruleId, file)
}

function recordFactoring(
  m: Measurements,
  ruleId: string,
  file: string,
  msg: Linter.LintMessage,
): void {
  const hit = FACTORING[ruleId]?.metric.exec(msg.message)
  if (!hit?.[1]) return
  const v = Number(hit[1])
  const arr = m.samples.get(ruleId) ?? []
  arr.push(v)
  m.samples.set(ruleId, arr)
  const s = m.sites.get(ruleId) ?? []
  // "Function 'foo' has …" / "Arrow function has …" / "File has …"
  s.push({ v, file, line: msg.line, what: /^(.*?) has /.exec(msg.message)?.[1] ?? 'file' })
  m.sites.set(ruleId, s)
}

function recordOther(m: Measurements, ruleId: string, file: string): void {
  m.other.set(ruleId, (m.other.get(ruleId) ?? 0) + 1)
  const fs = m.otherFiles.get(ruleId) ?? new Set<string>()
  fs.add(file)
  m.otherFiles.set(ruleId, fs)
}

type Say = (s?: string) => void

function reportDistributions(m: Measurements, say: Say): void {
  say('='.repeat(78))
  say('FACTORING METRIC DISTRIBUTIONS (floor run: every site reports its value)')
  say('='.repeat(78))
  const cols = ['n', 'p50', 'p75', 'p90', 'p95', 'p99', 'max']
  say(pad('rule', 24) + cols.map((c) => pad(c, 7, true)).join(''))
  for (const ruleId of Object.keys(FACTORING)) {
    const arr = [...(m.samples.get(ruleId) ?? [])].sort((a, b) => a - b)
    const row = [arr.length, ...[50, 75, 90, 95, 99].map((p) => pct(arr, p)), arr.at(-1) ?? 0]
    say(pad(ruleId, 24) + row.map((v) => pad(v, 7, true)).join(''))
  }
}

function reportSweep(m: Measurements, say: Say): void {
  say()
  say('='.repeat(78))
  say('THRESHOLD SWEEP — sites (and files) that would violate at each candidate')
  say('='.repeat(78))
  for (const ruleId of Object.keys(FACTORING)) {
    const s = m.sites.get(ruleId) ?? []
    const parts = (SWEEP[ruleId] ?? []).map((t) => {
      const over = s.filter((x) => x.v > t)
      return `${t}: ${over.length}/${new Set(over.map((x) => x.file)).size}f`
    })
    say(pad(ruleId, 24) + parts.join('   '))
  }
}

function reportOffenders(m: Measurements, say: Say): void {
  say()
  say('='.repeat(78))
  say('WORST OFFENDERS (top 12 per rule)')
  say('='.repeat(78))
  for (const ruleId of Object.keys(FACTORING)) {
    say(`\n-- ${ruleId} (${FACTORING[ruleId]?.label ?? ''})`)
    const s = [...(m.sites.get(ruleId) ?? [])].sort((a, b) => b.v - a.v)
    for (const x of s.slice(0, 12)) say(`   ${pad(x.v, 6, true)}  ${x.file}:${x.line}  ${x.what}`)
  }
}

function reportCorrectness(m: Measurements, say: Say): void {
  say()
  say('='.repeat(78))
  say('CORRECTNESS RULES — violations by rule')
  say('='.repeat(78))
  let total = 0
  for (const [ruleId, n] of [...m.other].sort((a, b) => b[1] - a[1])) {
    total += n
    const files = m.otherFiles.get(ruleId)?.size ?? 0
    say(`${pad(n, 7, true)}  ${pad(files, 5, true)} files  ${ruleId}`)
  }
  say(`${pad(total, 7, true)}  TOTAL correctness violations`)
  if (m.fatal > 0) say(`\n!! ${m.fatal} FATAL parse errors — these cannot be ratcheted.`)
}

async function measure(): Promise<void> {
  const m = collect(await run(FLOOR))
  const out: string[] = []
  const say: Say = (s = '') => {
    out.push(s)
    console.log(s)
  }
  reportDistributions(m, say)
  reportSweep(m, say)
  reportOffenders(m, say)
  reportCorrectness(m, say)
  writeFileSync(path.join(ROOT, 'scripts', 'lint-measure.txt'), `${out.join('\n')}\n`)
  console.log('\nwrote scripts/lint-measure.txt')
}

// ---------------------------------------------------------------------------
// RATCHET
// ---------------------------------------------------------------------------

/** file -> rule -> violation count, for the run against the REAL thresholds. */
type Inventory = Map<string, Map<string, number>>

function inventory(results: ESLint.LintResult[]): Inventory {
  const byFile: Inventory = new Map()
  let fatal = 0
  const bump = (file: string, ruleId: string) => {
    const byRule = byFile.get(file) ?? new Map<string, number>()
    byRule.set(ruleId, (byRule.get(ruleId) ?? 0) + 1)
    byFile.set(file, byRule)
  }
  for (const r of results) {
    const file = rel(r.filePath)
    for (const msg of r.messages) {
      if (msg.ruleId) bump(file, msg.ruleId)
      else if (msg.fatal) {
        fatal++
        console.error(`FATAL ${file}:${msg.line} ${msg.message}`)
      } else bump(file, STALE)
    }
  }
  if (fatal > 0) throw new Error(`${fatal} fatal parse errors — fix these first`)
  return byFile
}

const countFor = (byRule: Map<string, number> | undefined) =>
  [...(byRule?.values() ?? [])].reduce((a, b) => a + b, 0)

function ratchetSource(byFile: Inventory, files: string[]): string {
  const blocks = files.map((f) => {
    const byRule = byFile.get(f)
    const stale = byRule?.get(STALE)
    const rules = [...(byRule?.entries() ?? [])]
      .filter(([r]) => r !== STALE)
      .sort((a, b) => a[0].localeCompare(b[0]))
    const parts = [`    files: ['${f}'],`]
    if (stale) {
      parts.push(
        `    // ${stale} stale eslint-disable comment(s) predating this config.`,
        `    linterOptions: { reportUnusedDisableDirectives: 'off' },`,
      )
    }
    if (rules.length > 0) {
      parts.push(`    rules: {\n${rules.map(([r, n]) => `      '${r}': 'off', // ${n}`).join('\n')}\n    },`)
    }
    return `  {\n${parts.join('\n')}\n  },`
  })

  const entries = files.reduce((n, f) => n + (byFile.get(f)?.size ?? 0), 0)
  const violations = files.reduce((n, f) => n + countFor(byFile.get(f)), 0)

  return `// ============================================================================
// eslint.ratchet.mjs — GENERATED. Do not hand-edit to make a build green.
// ============================================================================
//
// THE RATCHET ONLY SHRINKS.
//
// Every entry below is a rule that a file violates TODAY, turned off for that
// file alone so \`npm run lint\` passes with zero source changes. It is a debt
// register, not a permission slip.
//
//   * A refactor wave DELETES the entries it fixed and re-runs \`npm run lint\`.
//     If the file is clean the deletion sticks; if it is not, lint says so.
//   * ADDING an entry — a new file, or a new rule on an existing file — is the
//     INTEGRATOR's call. Never an executor's, and never the way to land code
//     that does not pass.
//   * Regenerating wholesale (\`npm run lint:ratchet\`) after writing new code
//     silently widens the ratchet and defeats the entire design. Regenerate only
//     to seed it, or to re-baseline after a deliberate rule-set change.
//   * \`EQ_LINT_NO_RATCHET=1 npx eslint .\` shows the true, un-suppressed state.
//   * The worklist for the refactor waves is lint-worklist.md, generated beside
//     this file from the same run.
//
// Baseline: ${files.length} files, ${entries} file×rule entries, ${violations} suppressed violations.
// Generated ${new Date().toISOString().slice(0, 10)} by scripts/lint-report.mts.
// The trailing \`// N\` on each line is that file's violation count for that rule
// at generation time — a size hint for whoever picks the file up, nothing more.
// ============================================================================

/** @type {import('eslint').Linter.Config[]} */
export const ratchet = [
${blocks.join('\n')}
]

export default ratchet
`
}

function worklistMarkdown(byFile: Inventory, files: string[]): string {
  const entries = files.reduce((n, f) => n + (byFile.get(f)?.size ?? 0), 0)
  const violations = files.reduce((n, f) => n + countFor(byFile.get(f)), 0)

  const md: string[] = [
    '# Lint worklist — the refactor waves',
    '',
    'GENERATED by `npm run lint:ratchet` alongside `eslint.ratchet.mjs`. This is the',
    'inventory of everything the ratchet currently suppresses, partitioned into five',
    'waves so refactor agents can work disjoint file sets in parallel.',
    '',
    '**The law for a wave** (see AGENTS.md → Linting): changes are BEHAVIOR-PRESERVING',
    'only; run the full `npm test` + `npm run typecheck` after each wave; engine waves',
    '(A, C) additionally need the byte-identical damage-total regression gate. When a',
    'file comes clean, DELETE its block from `eslint.ratchet.mjs` — the ratchet only',
    'shrinks, and `npm run lint` is what proves the deletion was earned.',
    '',
    `Baseline: **${files.length} files**, **${entries} file×rule entries**, **${violations} violations**.`,
    '',
    '`linterOptions/reportUnusedDisableDirectives` is not a rule — it means the file',
    'carries a stale `eslint-disable` comment written before this config existed.',
    'Deleting the dead comment clears it.',
    '',
  ]

  for (const w of WAVES) {
    const wf = files.filter((f) => waveOf(f)?.id === w.id)
    md.push(`## Wave ${w.id} — ${w.label}`, '')
    if (wf.length === 0) {
      md.push('_clean — nothing suppressed._', '')
      continue
    }
    const wr = wf.reduce((n, f) => n + (byFile.get(f)?.size ?? 0), 0)
    const wv = wf.reduce((n, f) => n + countFor(byFile.get(f)), 0)
    md.push(`${wf.length} files · ${wr} file×rule entries · ${wv} violations`, '')

    const roll = new Map<string, number>()
    for (const f of wf)
      for (const [r, n] of byFile.get(f) ?? []) roll.set(r, (roll.get(r) ?? 0) + n)
    md.push('| rule | violations |', '| --- | ---: |')
    for (const [r, n] of [...roll].sort((a, b) => b[1] - a[1])) md.push(`| \`${r}\` | ${n} |`)
    md.push('')

    md.push('| file | violations | rules |', '| --- | ---: | --- |')
    const ranked = wf
      .map((f) => ({
        f,
        n: countFor(byFile.get(f)),
        rules: [...(byFile.get(f)?.keys() ?? [])].sort(),
      }))
      .sort((a, b) => b.n - a.n)
    for (const x of ranked)
      md.push(`| \`${x.f}\` | ${x.n} | ${x.rules.map((r) => `\`${r}\``).join(', ')} |`)
    md.push('')
  }
  return md.join('\n')
}

async function generateRatchet(): Promise<void> {
  const byFile = inventory(await run())
  const files = [...byFile.keys()].sort()
  writeFileSync(path.join(ROOT, 'eslint.ratchet.mjs'), ratchetSource(byFile, files))
  writeFileSync(path.join(ROOT, 'lint-worklist.md'), worklistMarkdown(byFile, files))
  const entries = files.reduce((n, f) => n + (byFile.get(f)?.size ?? 0), 0)
  const violations = files.reduce((n, f) => n + countFor(byFile.get(f)), 0)
  console.log(`ratchet: ${files.length} files, ${entries} file×rule entries, ${violations} violations`)
  console.log('wrote eslint.ratchet.mjs + lint-worklist.md')
}

if (process.argv[2] === '--ratchet') await generateRatchet()
else await measure()
