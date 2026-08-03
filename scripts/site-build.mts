/**
 * site-build.mts — the BUILD GATE behind scripts/site-screens.mts.
 *
 * Split out of that harness (it had grown past the 400-code-line factoring ceiling) and kept
 * whole: everything here is about producing a trustworthy `out-e2e/` to shoot — waiting for the
 * tree to typecheck, deciding whether the last build is still fresh, and locating the Electron
 * binary. Nothing here drives a window or takes a picture.
 *
 * The bundle lands in `out-e2e/` with an ABSOLUTE `--outDir` (electron-vite resolves a relative
 * one against each section's own root and buries the renderer HTML in src/renderer/), so it can
 * never race the dev watcher's `out/`.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const OUT_DIR = join(ROOT, 'out-e2e')
export const MAIN_ENTRY = join(OUT_DIR, 'main', 'index.js')

/** How long to wait for a sibling agent's in-flight edits to typecheck clean. */
const TYPECHECK_WAIT_MS = 15 * 60_000
const TYPECHECK_POLL_MS = 60_000

/** Both projects, exactly what `npm run typecheck` runs — without needing npm on PATH. */
function typecheckClean(): { ok: boolean; out: string } {
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  let out = ''
  for (const project of ['tsconfig.node.json', 'tsconfig.web.json']) {
    const res = spawnSync(process.execPath, [tsc, '--noEmit', '-p', join(ROOT, project)], {
      cwd: ROOT,
      encoding: 'utf8'
    })
    out += `${res.stdout ?? ''}${res.stderr ?? ''}`
    if (res.status !== 0) return { ok: false, out }
  }
  return { ok: true, out }
}

/**
 * A sibling agent may be mid-edit in src/renderer/src/features/posky/**. Building a broken tree
 * would produce a screenshot of a crashed tab, so wait it out — and if it never clears, say which
 * shot we are giving up on instead of shipping a lie.
 */
export function waitForTypecheck(log: (msg: string) => void): boolean {
  const t0 = Date.now()
  for (;;) {
    const res = typecheckClean()
    if (res.ok) {
      log(`typecheck: clean (${Math.round((Date.now() - t0) / 1000)}s)`)
      return true
    }
    if (Date.now() - t0 >= TYPECHECK_WAIT_MS) {
      log(`typecheck: STILL failing after ${Math.round(TYPECHECK_WAIT_MS / 60_000)}min:`)
      log(res.out.split('\n').slice(0, 12).join('\n'))
      return false
    }
    log(`typecheck: failing (a sibling agent is mid-edit) — retrying in ${TYPECHECK_POLL_MS / 1000}s`)
    spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${TYPECHECK_POLL_MS})`])
  }
}

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs)
  }
  return newest
}

export function buildIfStale(log: (msg: string) => void): void {
  let outMs = 0
  try {
    outMs = statSync(MAIN_ENTRY).mtimeMs
  } catch {
    outMs = 0
  }
  const srcMs = Math.max(
    newestMtime(join(ROOT, 'src')),
    statSync(join(ROOT, 'electron.vite.config.ts')).mtimeMs
  )
  if (outMs > srcMs) {
    log('build: out-e2e/ is fresh — reusing it')
    return
  }
  log('build: electron-vite build --outDir=out-e2e (absolute — a relative one buries the HTML)…')
  const res = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build',
      `--outDir=${OUT_DIR.replace(/\\/g, '/')}`
    ],
    { cwd: ROOT, stdio: 'inherit' }
  )
  if (res.status !== 0) throw new Error(`electron-vite build failed (exit ${res.status})`)
}

export function electronBinary(): string {
  return process.platform === 'win32'
    ? join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
}
