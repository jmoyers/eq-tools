// The combat engine's MUTABLE STATE — every field the old monolithic CombatEngine class
// carried, plus the small helpers that only read/refresh it (the classification ring, the
// presence axis, the two ring appenders, the defender-label resolution).
//
// Extracted so the routing / lifecycle / view modules can be plain functions over one
// explicit state object instead of methods on a 1,400-line class. `CombatEngine` (engine.ts)
// owns exactly one of these and is a thin facade over it — nothing outside this directory
// ever sees it.

import { WorldModel } from './world'
import { Agg } from './aggregate'
import {
  FALLBACK_IDLE_MS,
  MARKER_CAP,
  RECENT_CAP,
  TIMELINE_CAP,
  type Encounter,
  type MarkerRaw,
  type TimelineRaw,
  type ZoneSession
} from './encounter'
import { idKey } from '../log/parser'
import type { ClassifiedLine, CoatSlot } from '../../shared/combat'

export class EngineState {
  /** Canonical name keys of your LIVE PETS — charmed AND summoned alike. Kept in
   *  lockstep with the WorldModel's pet instances so the pure classify() (which only
   *  needs name membership) stays cheap. This is an ATTRIBUTION set, NOT a charm
   *  roster: a summoned class pet (Vebarn, Garer…) belongs here exactly as much as a
   *  charmed mob does, because both attribute as "your pet". The charmed/summoned
   *  distinction lives on WorldModel Instance.petKind — see world.charmedInstances(). */
  petNames = new Set<string>()
  world = new WorldModel()
  /** The player's own proper name key (e.g. "primitive"). Normally INJECTED by
   *  index.ts via setPlayerName() (it knows the character from the tail ref). As a
   *  cheap fallback (guards a mis-parsed injected name) it can also be LEARNED from
   *  heal lines: EQ writes self-heals as "You healed <PlayerName> for N", so a heal
   *  whose healer is You and whose target is neither one of your pets nor an engaged
   *  hostile reveals the player's name. An injected name always wins over a learned
   *  one. Once known, heals targeting that name count as incoming. */
  playerKey?: string
  /** True once setPlayerName() injected the name, so heal-based learning can't
   *  overwrite it. */
  playerKeyInjected = false
  zone?: string
  seq = 0
  current: Encounter | null = null
  history: Encounter[] = []
  zoneAgg = new Agg()
  zoneFinalizedMs = 0
  /** Sum of finalized encounters' activeMs this zone (for the zone active-DPS). */
  zoneActiveMs = 0
  /** First/last attributed-damage ts in the LIVE zone session (0 = none yet). Task #54: drives
   *  the zone-session disambiguation timing (start clock + relative age + span). */
  zoneStartTs = 0
  zoneLastTs = 0
  /** Capped finalized-zone-session history (Task #54). Each entry keeps its FROZEN Agg + timing +
   *  a memoized SegmentView-less summary; the live zoneAgg is NOT in here. Newest last. */
  zoneHistory: ZoneSession[] = []
  zoneSeq = 0
  recent: ClassifiedLine[] = []
  recording = false
  /**
   * HYDRATION (Task #56). True from construction/reset until the historical scan hands off
   * to the live Tailer (`setLive()`, or the first live event as a belt-and-braces fallback).
   * While true, `current` is a fight from the PAST being replayed, so a snapshot's "live"
   * fields are historical — the snapshot carries this flag so the UI renders a loading state
   * instead of a churning fake-live meter.
   */
  hydrating = true
  /** ts of the last encounter-relevant activity (attributed damage OR a CC event).
   *  Drives the FALLBACK_IDLE_MS closure independent of the damage timeline. */
  lastActivityTs = 0
  /** Current combat-modifier pair (Task #51): the last stance/invocation the player
   *  committed to, with the ts of that change. Session-scoped (survives zones/epoch —
   *  a stance is not tied to a zone); reset() clears it. Exposed in the snapshot and
   *  used to open/close timeline stance spans on the current encounter. */
  stance?: { name: string; ts: number }
  invocation?: { name: string; ts: number }
  /**
   * BLADE COATS (Task #64). Two slots because the game has two: `coatUtility` is the ONE
   * active utility poison (a new utility coat replaces it), `coatCombat` holds the combat
   * venoms, which STACK. Session-scoped exactly like the stance pair — a coat survives zoning
   * (the wiki: poisons last until class swap or death) — and cleared by reset().
   */
  coatUtility?: CoatSlot
  coatCombat: CoatSlot[] = []
  /**
   * ROLLING TIME-TO-SLOW samples (Task #64), newest last, capped at SLOW_SAMPLE_CAP. One
   * entry per FINALIZED pull that opened with a slow-capable coat on: the ms to the first
   * slow landing, or null when the pull ended without one. The null entries are the whole
   * reason this is a list of samples and not a running mean — they are COUNTED (`noLand`) and
   * never averaged in as zero (law 5).
   */
  slowSamples: (number | null)[] = []

  /** Enable classification logging (after the historical scan, for the live tail), and
   *  flip HYDRATION off — from here on every snapshot describes the real present. */
  setLive(): void {
    this.recording = true
    this.hydrating = false
  }

  /**
   * Inject the player's own character name (from index.ts's tail ref). This is the
   * authoritative source: called before the scan replay and again on a character
   * switch after reset(). Keyed canonically so it matches the idKey() the heal path
   * uses. Wins over any heal-line-learned name.
   */
  setPlayerName(name: string): void {
    this.playerKey = idKey(name)
    this.playerKeyInjected = true
  }

  reset(): void {
    this.petNames.clear()
    this.world.reset()
    this.playerKey = undefined
    this.playerKeyInjected = false
    this.zone = undefined
    this.current = null
    this.history = []
    this.zoneAgg = new Agg()
    this.zoneFinalizedMs = 0
    this.zoneActiveMs = 0
    this.zoneStartTs = 0
    this.zoneLastTs = 0
    this.zoneHistory = []
    this.zoneSeq = 0
    this.recent = []
    this.recording = false
    // A reset always precedes a fresh full-log scan (startup / character switch), so we're
    // hydrating again until that scan hands off to the tail.
    this.hydrating = true
    this.lastActivityTs = 0
    this.stance = undefined
    this.invocation = undefined
    this.coatUtility = undefined
    this.coatCombat = []
    this.slowSamples = []
  }

  log(ts: number, cat: string, role: ClassifiedLine['role'], text: string): void {
    if (!this.recording) return
    this.recent.push({ ts, cat, role, text })
    if (this.recent.length > RECENT_CAP) this.recent.shift()
  }

  /** The in-progress encounter, but only while it is FRESH — the same rule routeMiss uses so a
   *  non-damage event can attach to the fight it belongs to without reviving a stale one (and
   *  without ever OPENING one: only damage/CC do that). */
  freshEncounter(ts: number): Encounter | null {
    return this.current && ts - this.current.lastTs <= FALLBACK_IDLE_MS ? this.current : null
  }

  /** Append a point annotation to an encounter's marker ring (Task #64), drop-oldest at
   *  MARKER_CAP. Draw-only: no count, DPS or attribution ever reads this. */
  pushMarker(enc: Encounter, m: MarkerRaw): void {
    enc.markers.push(m)
    if (enc.markers.length > MARKER_CAP) enc.markers.shift()
  }

  /** Append one instant to the current encounter's timeline ring (Task #51), capped
   *  drop-oldest at TIMELINE_CAP. Called from route()/routeMiss for attributed events.
   *  `eventsTotal` counts EVERY push, so a fight that outgrows the cap still knows its true
   *  instant count and buildTimeline can declare the loss instead of reporting the ring
   *  length as if it were the fight (law 1). The counter is display metadata only — no
   *  aggregate, DPS or attribution reads it. */
  pushTimeline(enc: Encounter, rec: TimelineRaw): void {
    enc.events.push(rec)
    enc.eventsTotal++
    if (enc.events.length > TIMELINE_CAP) enc.events.shift()
  }

  /**
   * PRESENCE refresh (Task #55) — record that `name` is still in the current fight as of
   * `ts`. This is the liveness axis ONLY: it moves nothing on the damage timeline
   * (enc.lastTs / prevDamageTs / activeMs / lastActivityTs are untouched), so DPS
   * denominators and the fled-mob FALLBACK_IDLE_MS clock are unaffected (AGENTS.md law 8).
   *
   * Deliberately conservative in both directions:
   *   - it never ENGAGES anything: only instances ALREADY in enc.engaged are refreshed,
   *     so a miss/resist still cannot open or join an encounter;
   *   - it never resolves/creates a world instance (it matches the engaged instanceIds
   *     "<nameKey>#gen" by name prefix), so a whiff at a mob we've never damaged has no
   *     side effect on the world model at all.
   * Name-level matching refreshes every engaged twin sharing the name — the log cannot
   * tell twins apart on a miss line, and a retired twin is "gone" via isRetired anyway.
   */
  notePresence(name: string, ts: number): void {
    const enc = this.current
    if (!enc) return
    const key = idKey(name)
    for (const id of enc.engaged) {
      const hash = id.lastIndexOf('#')
      if (hash > 0 && id.slice(0, hash) === key) this.notePresenceId(enc, id, ts)
    }
  }

  /** Presence refresh for an already-resolved engaged instanceId (see notePresence). */
  notePresenceId(enc: Encounter, instanceId: string, ts: number): void {
    if (!enc.engaged.has(instanceId)) return
    const prev = enc.engagedSeen.get(instanceId)
    if (prev === undefined || ts > prev) enc.engagedSeen.set(instanceId, ts)
  }

  /**
   * Learn the player's proper name as a FALLBACK only (injected name wins):
   * "You healed <Player>" where the target is not a pet and not an engaged
   * hostile → that name IS the player. (EQ never writes literal "You" as a heal
   * target; it uses the character name.)
   */
  learnPlayerKey(healerKey: string | null, tKey: string, isYouTgt: boolean, isPetTgt: boolean): void {
    if (
      !this.playerKeyInjected &&
      healerKey === 'you' &&
      !isYouTgt &&
      !isPetTgt &&
      !this.isEngagedHostile(tKey) &&
      this.playerKey === undefined
    ) {
      this.playerKey = tKey
    }
  }

  /** True if `nameKey` currently resolves to an engaged hostile instance. */
  isEngagedHostile(nameKey: string): boolean {
    if (!this.current) return false
    for (const list of [this.current]) {
      for (const id of list.engaged) {
        // engaged ids are instanceIds "<nameKey>#gen"; compare the nameKey prefix.
        const hash = id.lastIndexOf('#')
        if (hash > 0 && id.slice(0, hash) === nameKey) return true
      }
    }
    return false
  }

  /**
   * INSTANCE-RESOLVED defender label for a damage-free instant (miss/resist), Task #58.
   *
   * The damage path labels its defender `world.label(world.resolve(target, ts))`, so twins
   * read as "a deadly black widow (7)" / "(8)". Miss and resist ticks carried the RAW log
   * name instead, so the dashboard's per-mob panel — which groups timeline instants by
   * `target` — grew a bare-named 0-damage ghost row alongside the two real instances.
   *
   * Resolution is GATED on the name already being engaged in this encounter (the same
   * nameKey-prefix scan notePresence uses). That keeps AGENTS.md law 8 intact in both
   * directions: `engaged` membership only ever comes from LANDED damage/heals, so a whiff
   * at a mob we have never damaged still has ZERO world-model side effects (no instance is
   * spawned, no gen counter moves) and simply keeps its raw name — the honest label when no
   * instance exists. When the name IS engaged, resolve() returns the same instance the next
   * landed hit would, so the miss lands on the right twin's row.
   */
  defenderLabel(enc: Encounter, name: string, ts: number): string {
    const key = idKey(name)
    if (key === 'you') return 'You'
    for (const id of enc.engaged) {
      const hash = id.lastIndexOf('#')
      if (hash > 0 && id.slice(0, hash) === key) return this.world.label(this.world.resolve(name, ts))
    }
    return name
  }

  /**
   * Display names of your GENUINELY-CHARMED live pets (mobs bound by a
   * `<mob> has been charmed.` line). SUMMONED class pets are deliberately excluded —
   * they are pets, not charms. Deliberately NOT in the snapshot: no UI needs a charm
   * roster today, and the old snapshot field lied (it was the attribution set). This is
   * the ONLY correct door for one; never reconstruct it from petNames.
   */
  charmedPetNames(): string[] {
    return this.world.charmedInstances().map((i) => i.display)
  }

  /** Display names of ALL your live pets — charmed AND summoned. This is what the DPS
   *  meter attributes to (both kinds produce `kind: 'pet'` source rows). */
  petDisplayNames(): string[] {
    return this.world.petInstances().map((i) => i.display)
  }
}
