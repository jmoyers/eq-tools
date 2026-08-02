import { useCallback, useEffect, useMemo, useState } from 'react'
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

const applyLootDelta = (s: LootSnap, d: LootDelta): LootSnap => [...s, ...d.appended]
const applyTurnInDelta = (s: TurnInSnap, d: TurnInDelta): TurnInSnap => [...s, ...d.appended]
const EMPTY_LOOT: LootEvent[] = []
const EMPTY_TURNINS: TurnInEvent[] = []

const posky = getPoskyData()

const COUNT_SOURCE_KEY = 'eq.countSource'

export { questKey }

/**
 * Match logged turn-ins to quests: a quest is turned in when its giver received
 * (in one trade) every item the quest requires.
 */
function matchTurnIns(turnIns: TurnInEvent[], quests: PoskyQuest[]): Set<string> {
  const matched = new Set<string>()
  for (const t of turnIns) {
    const npc = t.npc.toLowerCase()
    // Normalize the +N variant at the matching boundary: a `You offered 1 Sphinx
    // Claw +1` line should satisfy a quest requiring `Sphinx Claw` (Task #42).
    const offered = new Set(t.items.map((i) => itemCountKey(i)))
    for (const q of quests) {
      if (!q.giver || q.giver.toLowerCase() !== npc) continue
      if (q.items.length > 0 && q.items.every((it) => offered.has(itemCountKey(it.name)))) {
        matched.add(questKey(q))
      }
    }
  }
  return matched
}

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
}

export function useProgress(): UseProgress {
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [character, setCharacter] = useState<string | null>(null)
  const [countSource, setCountSourceState] = useState<CountSource>(loadCountSource)

  const lootHistory = useModule<LootSnap, LootDelta>('loot', applyLootDelta) ?? EMPTY_LOOT
  const turnIns = useModule<TurnInSnap, TurnInDelta>('turnins', applyTurnInDelta) ?? EMPTY_TURNINS

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

  // Auto-complete quests whose items were turned in to their giver (from the log).
  useEffect(() => {
    if (!progress) return
    const matched = matchTurnIns(turnIns, posky.quests)
    const done = new Set(progress.completedQuests)
    const toComplete = [...matched].filter((k) => !done.has(k))
    if (toComplete.length === 0) return
    void Promise.all(toComplete.map((k) => window.eq.setQuestComplete(k, true))).then((results) => {
      if (results.length) setProgress(results[results.length - 1])
    })
  }, [turnIns, progress])

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
    inventoryInfo: progress?.inventorySource
  }
}
