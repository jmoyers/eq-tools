// EQ INSTALL-DIR DISCOVERY TEST (fresh-machine config feature): the pure, ordered
// candidate-resolution logic that lets a friend's fresh install "just work" with no
// config, plus the fs predicates it relies on.
//
// Two layers, both PURE / injectable so no real registry or C:\ layout is needed:
//   1. discoverEqRoot(probes) — the ordered sweep: extraCandidates (env → registry)
//      FIRST, then <drive> × Daybreak-subpath, first candidate whose Logs dir holds
//      an eqlog_*.txt wins; duplicates probed at most once; null when nothing matches.
//   2. rootHasLogs / countCharacterLogs — exercised against REAL temp fixture dirs
//      (an install root with a Logs\eqlog_*.txt, an empty one, a missing one).
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  discoverEqRoot,
  rootHasLogs,
  countCharacterLogs,
  type DiscoveryProbes
} from '../src/main/log/discovery'

// --- discoverEqRoot ordering (fully injected probes) ------------------------

/** A probe set where `withLogs` is the ONLY root reporting logs. */
function probes(withLogs: Set<string>, drives: string[], extra: string[] = []): DiscoveryProbes {
  return {
    hasLogs: (root) => withLogs.has(root.replace(/[\\/]+$/, '').toLowerCase()),
    extraCandidates: () => extra,
    fixedDrives: () => drives
  }
}

const lc = (s: string): string => s.replace(/[\\/]+$/, '').toLowerCase()

test('discoverEqRoot: default public path on C: is found by the drive sweep', () => {
  const target = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const root = discoverEqRoot(probes(new Set([lc(target)]), ['C:', 'D:']))
  assert.equal(root, target)
})

test('discoverEqRoot: sweeps other fixed drives (install on D:)', () => {
  const target = 'D:\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const root = discoverEqRoot(probes(new Set([lc(target)]), ['C:', 'D:']))
  assert.equal(root, target)
})

test('discoverEqRoot: an extra candidate (env/registry) wins over the drive sweep', () => {
  const reg = 'E:\\Games\\EQL'
  const publicPath = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  // BOTH have logs; the extra candidate is probed first, so it wins.
  const root = discoverEqRoot(probes(new Set([lc(reg), lc(publicPath)]), ['C:'], [reg]))
  assert.equal(root, reg)
})

test('discoverEqRoot: returns null when nothing has logs (fresh machine)', () => {
  const root = discoverEqRoot(probes(new Set(), ['C:', 'D:'], ['Z:\\nope']))
  assert.equal(root, null)
})

test('discoverEqRoot: probes each candidate at most once (dedupe)', () => {
  const seen: string[] = []
  const target = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'
  const p: DiscoveryProbes = {
    hasLogs: (root) => {
      seen.push(root)
      return lc(root) === lc(target)
    },
    // Duplicate the target as an extra candidate + it's also produced by the sweep.
    extraCandidates: () => [target, target],
    fixedDrives: () => ['C:']
  }
  const root = discoverEqRoot(p)
  assert.equal(root, target)
  // The target should appear exactly once in the probe log (found on first hit).
  const hits = seen.filter((s) => lc(s) === lc(target))
  assert.equal(hits.length, 1)
})

// --- rootHasLogs / countCharacterLogs against real temp fixtures ------------

test('rootHasLogs / countCharacterLogs: real fixture dirs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-disc-'))
  try {
    // 1. A proper install root: <root>\Logs\eqlog_*.txt (+ a non-log file).
    const good = join(tmp, 'good')
    mkdirSync(join(good, 'Logs'), { recursive: true })
    writeFileSync(join(good, 'Logs', 'eqlog_Primitive_freeport.txt'), '[Sat] hi\n')
    writeFileSync(join(good, 'Logs', 'eqlog_Alt_halas.txt'), '[Sat] hi\n')
    writeFileSync(join(good, 'Logs', 'MemoryStrategy.txt'), 'not a log\n')

    // 2. A Logs dir with NO character logs.
    const emptyLogs = join(tmp, 'emptyLogs')
    mkdirSync(join(emptyLogs, 'Logs'), { recursive: true })
    writeFileSync(join(emptyLogs, 'Logs', 'dbg.txt'), 'nope\n')

    // 3. A root with no Logs dir at all.
    const noLogsDir = join(tmp, 'noLogs')
    mkdirSync(noLogsDir, { recursive: true })

    assert.equal(rootHasLogs(good), true)
    assert.equal(rootHasLogs(emptyLogs), false)
    assert.equal(rootHasLogs(noLogsDir), false)
    assert.equal(rootHasLogs(join(tmp, 'does-not-exist')), false)

    assert.equal(countCharacterLogs(join(good, 'Logs')), 2)
    assert.equal(countCharacterLogs(join(emptyLogs, 'Logs')), 0)
    assert.equal(countCharacterLogs(join(tmp, 'does-not-exist')), 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('discoverEqRoot: end-to-end with the real rootHasLogs predicate over a temp drive layout', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'eq-disc2-'))
  try {
    // Simulate a "drive" dir that contains the Daybreak public sub-path with logs.
    const install = join(
      tmp,
      'Users',
      'Public',
      'Daybreak Game Company',
      'Installed Games',
      'EverQuest Legends'
    )
    mkdirSync(join(install, 'Logs'), { recursive: true })
    writeFileSync(join(install, 'Logs', 'eqlog_Primitive_freeport.txt'), '[Sat] hi\n')

    // Point the extra-candidate probe at the temp install root directly (the drive
    // sweep uses Windows-only `<drive>\...` paths, so we feed the real predicate a
    // POSIX temp path via extraCandidates to keep the test OS-agnostic).
    const root = discoverEqRoot({
      hasLogs: rootHasLogs,
      extraCandidates: () => [install, join(tmp, 'nope')],
      fixedDrives: () => []
    })
    assert.equal(root, install)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
