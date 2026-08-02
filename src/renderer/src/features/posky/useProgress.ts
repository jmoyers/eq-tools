import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CountSource,
  LootDelta,
  LootEvent,
  LootSnap,
  PoskyQuest,
  ProgressState,
  TurnInDelta,
  TurnInEvent,
  TurnInSnap
} from '@shared/types'
import { getPoskyData } from '../../data'
import { itemCountKey, normalizeItemName } from '../../lib/itemName'
import { useModule } from '../../lib/useModule'
import { reconcile, type InventoryRow } from '../inventory/reconcile'
import { questKey } from './keys'
import { ambiguousQuestNames, computeSharedItems, type SharedItemsMap } from './sharedItems'
import { matchTurnIns, newlyCompletedTurnIns } from './turnInCelebration'

const applyLootDelta = (s: LootSnap, d: LootDelta): LootSnap => [...s, ...d.appended]
const applyTurnInDelta = (s: TurnInSnap, d: TurnInDelta): TurnInSnap => [...s, ...d.appended]
const EMPTY_LOOT: LootEvent[] = []
const EMPTY_TURNINS: TurnInEvent[] = []

const posky = getPoskyData()

// "Shared items with" (Task #44): which OTHER quests contend for each quest's
// required items (normalized, Wind Runes excluded). The quest set is static bundled
// data, so this is derived ONCE at module load, not per render.
const sharedItemsMap: SharedItemsMap = computeSharedItems(posky.quests)
const ambiguousNames = ambiguousQuestNames(posky.quests)

// questKey → quest, derived once (static bundled data). Used by the live turn-in
// celebration to resolve a matched key back to its quest for the callback (Task #46).
const questByKey = new Map<string, PoskyQuest>(posky.quests.map((q) => [questKey(q), q]))

const COUNT_SOURCE_KEY = 'eq.countSource'

export { questKey }

function loadCountSource(): CountSource {
  const v = localStorage.getItem(COUNT_SOURCE_KEY)
  return v === 'inventory' || v === 'both' || v === 'log' ? v : 'log'
}

export interface ItemProgress {
  name: string
  who: string[]
  where: string
  need: number
  have: number
  stats?: string
  page?: string
}

export interface QuestProgress {
  key: string
  className: string
  name: string
  giver?: string
  rune?: string
  reward?: string
  rewardStats?: string
  items: ItemProgress[]
  haveCount: number
  needCount: number
  ratio: number
  missing: string[]
  completed: boolean
}

export function computeQuestProgress(
  quest: PoskyQuest,
  held: Record<string, number>,
  completedSet: Set<string>
): QuestProgress {
  const key = questKey(quest)
  const items: ItemProgress[] = quest.items.map((it) => {
    const need = it.count > 0 ? it.count : 1
    const have = Math.min(need, held[itemCountKey(it.name)] ?? 0)
    return { name: it.name, who: it.who, where: it.where, need, have, stats: it.stats, page: it.page }
  })
  const needCount = items.reduce((s, i) => s + i.need, 0)
  const haveCount = items.reduce((s, i) => s + i.have, 0)
  const completed = completedSet.has(key)
  return {
    key,
    className: quest.className,
    name: quest.name,
    giver: quest.giver,
    rune: quest.rune,
    reward: quest.reward,
    rewardStats: quest.rewardStats,
    items,
    haveCount,
    needCount,
    ratio: completed ? 1 : needCount === 0 ? 0 : haveCount / needCount,
    missing: items.filter((i) => i.have < i.need).map((i) => i.name),
    completed
  }
}

export interface UseProgress {
  character: string | null
  quests: QuestProgress[]
  classes: string[]
  progress: ProgressState | null
  lootHistory: LootEvent[]
  inventoryRows: InventoryRow[]
  countSource: CountSource
  setCountSource: (s: CountSource) => void
  reloadInventory: () => Promise<string>
  setQuestComplete: (key: string, complete: boolean) => Promise<void>
  inventoryInfo: ProgressState['inventorySource']
  /** questKey → contested items (other quests sharing each required item). */
  sharedItems: SharedItemsMap
  /** quest names that occur under >1 class (chips class-prefix only these). */
  ambiguousQuestNames: Set<string>
}

export interface UseProgressOptions {
  /**
   * Fired ONCE per quest the instant it transitions to completed via a LIVE detected
   * turn-in (the giver received every required item while the app is open). Mirrors the
   * boss-defeat celebration contract (Task #46 / #24): the historical baseline (quests
   * already completed on load, and turn-ins found in the initial log scan) is seeded
   * SILENTLY on the first snapshot and NEVER fires; only a transition observed after that
   * baseline fires. Manual checkbox completion (setQuestComplete) does NOT route through
   * here, so it never celebrates.
   */
  onQuestComplete?: (quest: PoskyQuest) => void
}

export function useProgress(opts?: UseProgressOptions): UseProgress {
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [character, setCharacter] = useState<string | null>(null)
  const [countSource, setCountSourceState] = useState<CountSource>(loadCountSource)

  const lootHistory = useModule<LootSnap, LootDelta>('loot', applyLootDelta) ?? EMPTY_LOOT
  // Raw (nullable) turn-in snapshot: null until the module hydrates. We gate the
  // celebration baseline on hydration so the historical turn-ins that arrive WITH the
  // snapshot seed the baseline silently instead of looking like live transitions.
  const turnInsRaw = useModule<TurnInSnap, TurnInDelta>('turnins', applyTurnInDelta)
  const turnIns = turnInsRaw ?? EMPTY_TURNINS

  // Baseline of quest keys already satisfied by a turn-in — seeded silently on the FIRST
  // observation so historical turn-ins (in the initial log scan) never celebrate. A key
  // that appears in the matched set AFTER the baseline is a live transition → celebrate
  // exactly once. Kept in a ref (not state) so it never triggers a re-render, mirroring
  // useBossKills' prevRef. Reset on character switch (state re-hydrates from scratch).
  const matchedBaselineRef = useRef<Set<string> | null>(null)
  const onQuestCompleteRef = useRef(opts?.onQuestComplete)
  onQuestCompleteRef.current = opts?.onQuestComplete

  useEffect(() => {
    const off = window.eq.onCharacter(() => {
      matchedBaselineRef.current = null
    })
    return off
  }, [])

  useEffect(() => {
    void window.eq.getProgress().then(setProgress)
    void window.eq.getCharacter().then((c) => setCharacter(c?.name ?? null))
    // Progress can change in main (auto-complete from a turn-in, inventory
    // auto-reload) — stay consistent with those pushes instead of a refetch race.
    const offProgress = window.eq.onProgress(setProgress)
    const offInv = window.eq.onInventoryReload(() => void window.eq.getProgress().then(setProgress))
    const offChar = window.eq.onCharacter((c) => {
      setCharacter(c?.name ?? null)
      void window.eq.getProgress().then(setProgress)
    })
    return () => {
      offProgress()
      offInv()
      offChar()
    }
  }, [])

  // Auto-complete quests whose items were turned in to their giver (from the log), and
  // celebrate ONLY genuine live transitions (never the historical baseline). Gated on the
  // turn-in snapshot being HYDRATED (turnInsRaw != null) so the historical turn-ins that
  // arrive with the first snapshot seed the baseline silently rather than firing.
  useEffect(() => {
    if (!progress || turnInsRaw == null) return
    const matched = matchTurnIns(turnInsRaw, posky.quests)

    // Celebrate any key newly in `matched` vs the last observation — but seed the
    // baseline SILENTLY on the first hydrated run so the initial log scan's historical
    // turn-ins (and already-persisted completions) never fire. This is the boss-defeat
    // baseline rule applied to turn-ins (Task #46).
    for (const key of newlyCompletedTurnIns(matchedBaselineRef.current, matched)) {
      const quest = questByKey.get(key)
      if (quest) onQuestCompleteRef.current?.(quest)
    }
    matchedBaselineRef.current = matched

    const done = new Set(progress.completedQuests)
    const toComplete = [...matched].filter((k) => !done.has(k))
    if (toComplete.length === 0) return
    void Promise.all(toComplete.map((k) => window.eq.setQuestComplete(k, true))).then((results) => {
      if (results.length) setProgress(results[results.length - 1])
    })
  }, [turnInsRaw, progress])

  const setCountSource = useCallback((s: CountSource) => {
    localStorage.setItem(COUNT_SOURCE_KEY, s)
    setCountSourceState(s)
  }, [])

  const reloadInventory = useCallback(async (): Promise<string> => {
    const res = await window.eq.reloadInventory()
    if (res.ok && res.progress) {
      setProgress(res.progress)
      return `Loaded ${res.path}`
    }
    return res.error ?? 'Failed to load inventory'
  }, [])

  const setQuestComplete = useCallback(async (key: string, complete: boolean): Promise<void> => {
    const next = await window.eq.setQuestComplete(key, complete)
    setProgress(next)
  }, [])

  // Counts + display names derived from the log (everything still HELD from looting).
  // Task #40: a 'sold' loot was auto-vendored the instant it dropped — the item is gone, so
  // it must NOT count as held (for either quest progress or inventory reconcile, both of
  // which derive from this one map). 'currency' loots (Wind Runes → the currency tab) and
  // ordinary kept loot (undefined disposition) both count. Turn-in subtraction downstream
  // (reconcile) operates on these held counts, so excluding sold here also keeps it from
  // ever trying to subtract an item that was never held — no double-handling.
  const logCounts = useMemo<Record<string, number>>(() => {
    const c: Record<string, number> = {}
    for (const e of lootHistory) {
      if (e.disposition === 'sold') continue
      // Fold +N variants onto the base counting key (Task #42): `Sphinx Claw` and
      // `Sphinx Claw +1` are two of the same held item for quest purposes.
      const k = itemCountKey(e.item)
      c[k] = (c[k] ?? 0) + 1
    }
    return c
  }, [lootHistory])

  // Display names keyed by the SAME normalized counting key logCounts uses, so the
  // reconcile rows (keyed by counting key) resolve a name. We prefer the BASE
  // (un-suffixed) display when we've seen it, so a `Sphinx Claw` + `Sphinx Claw +1`
  // pool reads as "Sphinx Claw" (the quest item), not the variant.
  const lootNames = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const e of lootHistory) {
      const k = itemCountKey(e.item)
      const base = normalizeItemName(e.item)
      // First writer wins, but a base (un-suffixed) name upgrades a variant one.
      if (m[k] === undefined || (m[k] !== base && base === e.item)) m[k] = base
    }
    return m
  }, [lootHistory])

  // Reconcile held items (log + inventory), subtracting anything consumed by
  // quests that have been turned in.
  const { net, rows: inventoryRows } = useMemo(
    () =>
      reconcile({
        log: logCounts,
        inv: progress?.inventory ?? {},
        lootNames,
        countSource,
        completedKeys: progress?.completedQuests ?? [],
        quests: posky.quests
      }),
    [logCounts, lootNames, progress, countSource]
  )

  const quests = useMemo<QuestProgress[]>(() => {
    if (!progress) return []
    const completedSet = new Set(progress.completedQuests)
    return posky.quests.map((q) => computeQuestProgress(q, net, completedSet))
  }, [progress, net])

  const classes = useMemo(() => [...new Set(posky.quests.map((q) => q.className))].sort(), [])

  return {
    character,
    quests,
    classes,
    progress,
    lootHistory,
    inventoryRows,
    countSource,
    setCountSource,
    reloadInventory,
    setQuestComplete,
    inventoryInfo: progress?.inventorySource,
    sharedItems: sharedItemsMap,
    ambiguousQuestNames: ambiguousNames
  }
}
