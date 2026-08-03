// combo module — which THREE classes was this character running, and when did that change?
// docs/plans/class-combo-inference.md § 5.1. The EqModule shell only; the thinking lives in
// three PURE siblings (comboEvidence / comboScore / comboIntervals) that take plain arrays,
// which is what lets tests/comboWindows.test.mts golden-window this without Electron.
//
// WHY THE FEATURE EXISTS AT ALL. EQ Legends runs up to three classes at once, the displayed
// level is the MINIMUM of their levels, and a loadout swap is NEVER logged — verified twice on
// full-log sweeps. The character's own `/who` row states the loadout outright and there are
// ELEVEN of them in 1.1M lines, none within 33 hours of the swap this log actually contains.
// So the app either infers the combo and labels it inferred, or it says nothing at all.
//
// REGISTERED FIRST in pipeline.ts: within one bus delivery every later module (and the combat
// engine) then sees an already-advanced combo state for the same event. It consumes no derived
// events and emits none, so the order change is purely additive.
//
// RECOMPUTE-FROM-SCRATCH, NOT PATCH-IN-PLACE. A `/who` row typed now re-labels the past hour
// and a user correction re-labels an arbitrary span, so intervals are rebuilt from the retained
// observations whenever anything changes. Interval ids are therefore snapshot-scoped, which is
// exactly why the delta carries `removed` and why persisted corrections key on TIMESTAMPS
// (§ 5.4 / § 7).

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import {
  isClassAbbr,
  type ClassObservation,
  type ComboCorrection,
  type ComboDelta,
  type ComboInterval,
  type ComboSnap
} from '../../shared/classCombo'
import { LAUNCH_MS } from '../log/epochDetector'
import classesJson from '../data/classes.json'
import { classObservation } from './comboEvidence'
import { buildIntervals, type LevelPoint, type WhoRow } from './comboIntervals'

/**
 * Data availability, not health: `classes.json` ships as an empty STUB before the scrape runs
 * (the keep-the-tree-buildable rule), and an empty stance table would silently turn every
 * inference into an unknown slot. The UI shows "not ready" instead of a wall of dashes.
 */
const TABLES_READY = Object.keys(classesJson.stances).length > 0

export class ComboModule implements EqModule<ComboSnap, ComboDelta> {
  readonly id = 'combo'

  private observations: ClassObservation[] = []
  private whoRows: WhoRow[] = []
  private levels: LevelPoint[] = []
  private corrections: ComboCorrection[] = []
  private correctionsProvider: (() => readonly ComboCorrection[]) | null = null
  /** When an item last fired its own effect — the clicky-suppression context (comboEvidence). */
  private lastItemActivateTs: number | null = null
  private seq = 0

  private intervals: ComboInterval[] = []
  private stale = true
  /** What the renderer last saw, by id, so a delta carries only what actually moved. */
  private pushed = new Map<string, string>()

  reset(): void {
    this.observations = []
    this.whoRows = []
    this.levels = []
    this.lastItemActivateTs = null
    this.seq = 0
    this.intervals = []
    this.pushed.clear()
    this.stale = true
  }

  /**
   * Where persisted user corrections come from — installed once at IPC registration
   * (ipc/combo.ts) as `() => getComboCorrections(activeCharId())`.
   *
   * A PULL rather than a push, because corrections are CHARACTER-scoped and this module has no
   * business knowing which character is active: `reset()` runs on every character (re)load and
   * marks the state stale, so the next recompute simply asks again and gets the new
   * character's list. A push would need the module wired into the character-switch path.
   */
  setCorrectionsProvider(provider: () => readonly ComboCorrection[]): void {
    this.correctionsProvider = provider
    this.stale = true
  }

  /** Call after writing a correction: the provider's answer changed. */
  invalidate(): void {
    this.stale = true
  }

  /**
   * Install corrections directly. TEST SEAM — production installs a provider. Pre-launch
   * corrections are dropped here as well as in the store migration: they describe the BETA
   * character that was wiped at the 2026-07-28 launch and shares this log file, and a
   * correction is the one piece of combo state that outlives a replay.
   */
  setCorrections(corrections: readonly ComboCorrection[]): void {
    this.correctionsProvider = null
    this.corrections = corrections.filter((c) => c.startTs >= LAUNCH_MS)
    this.stale = true
  }

  getCorrections(): ComboCorrection[] {
    return [...this.corrections]
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth: every observation before the boundary belongs to a dead character
      // whose loadout has nothing to do with this one. NOTE what is deliberately NOT here — a
      // level-regression epoch trigger. A level drop is a LOADOUT SWAP, which is the entire
      // point of this module (epochDetector.ts says the same thing from the other side).
      const kept = this.corrections
      this.reset()
      this.corrections = kept.filter((c) => c.startTs >= LAUNCH_MS)
      return
    }
    if (ev.kind === 'itemActivate') {
      this.lastItemActivateTs = ev.ts
      return
    }
    if (ev.kind === 'level') {
      this.levels.push({ ts: ev.ts, level: ev.level })
      this.stale = true
      return
    }
    if (ev.kind === 'selfWho') {
      const classes = ev.classes.filter(isClassAbbr)
      if (classes.length > 0) this.whoRows.push({ ts: ev.ts, seq: ev.seq, classes, level: ev.level })
    }
    const observation = classObservation(ev, this.lastItemActivateTs)
    if (!observation) return
    this.observations.push(observation)
    this.stale = true
  }

  /** Rebuild the intervals if anything moved. Cheap enough to do on demand (~30k observations
   *  over the whole log) and correct by construction — see the header. */
  private current(): ComboInterval[] {
    if (!this.stale) return this.intervals
    if (this.correctionsProvider) {
      this.corrections = this.correctionsProvider().filter((c) => c.startTs >= LAUNCH_MS)
    }
    this.intervals = buildIntervals({
      observations: this.observations,
      whoRows: this.whoRows,
      levels: this.levels,
      corrections: this.corrections
    })
    this.stale = false
    return this.intervals
  }

  snapshot(): { seq: number; state: ComboSnap } {
    const intervals = this.current()
    // A snapshot IS the renderer's new baseline, so the delta bookkeeping resets with it —
    // otherwise the next flush would re-send intervals the hydration already carried.
    this.pushed = new Map(intervals.map((i) => [i.id, JSON.stringify(i)]))
    return {
      seq: this.seq,
      state: {
        intervals,
        current: intervals.length > 0 ? intervals[intervals.length - 1] : null,
        ready: TABLES_READY
      }
    }
  }

  flushDelta(): { seq: number; delta: ComboDelta } | null {
    const intervals = this.current()
    const changed: ComboInterval[] = []
    const next = new Map<string, string>()
    for (const interval of intervals) {
      const json = JSON.stringify(interval)
      next.set(interval.id, json)
      if (this.pushed.get(interval.id) !== json) changed.push(interval)
    }
    const removed = [...this.pushed.keys()].filter((id) => !next.has(id))
    if (changed.length === 0 && removed.length === 0) return null
    this.pushed = next
    return { seq: this.seq, delta: { changed, removed } }
  }
}
