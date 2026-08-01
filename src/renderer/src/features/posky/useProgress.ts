import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CountSource, LootEvent, PoskyData, PoskyQuest, ProgressState } from '@shared/types'
import poskyRaw from '../../data/posky.json'

const posky = poskyRaw as unknown as PoskyData

const COUNT_SOURCE_KEY = 'eq.countSource'

export function questKey(q: Pick<PoskyQuest, 'className' | 'name'>): string {
  return `${q.className}::${q.name}`
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
    const have = Math.min(need, held[it.name.toLowerCase()] ?? 0)
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
  countSource: CountSource
  setCountSource: (s: CountSource) => void
  reloadInventory: () => Promise<string>
  setQuestComplete: (key: string, complete: boolean) => Promise<void>
  inventoryInfo: ProgressState['inventorySource']
}

export function useProgress(lastLoot: LootEvent | null): UseProgress {
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [character, setCharacter] = useState<string | null>(null)
  const [lootHistory, setLootHistory] = useState<LootEvent[]>([])
  const [countSource, setCountSourceState] = useState<CountSource>(loadCountSource)

  useEffect(() => {
    void window.eq.getProgress().then(setProgress)
    void window.eq.getCharacter().then((c) => setCharacter(c?.name ?? null))
    void window.eq.getLootHistory().then(setLootHistory)
  }, [])

  // Append live loot to the in-memory history.
  useEffect(() => {
    if (lastLoot) setLootHistory((h) => [...h, lastLoot])
  }, [lastLoot])

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

  // Counts derived from the log (everything ever looted).
  const logCounts = useMemo<Record<string, number>>(() => {
    const c: Record<string, number> = {}
    for (const e of lootHistory) {
      const k = e.item.toLowerCase()
      c[k] = (c[k] ?? 0) + 1
    }
    return c
  }, [lootHistory])

  // Held counts per the selected source.
  const held = useMemo<Record<string, number>>(() => {
    const inv = progress?.inventory ?? {}
    if (countSource === 'inventory') return inv
    if (countSource === 'log') return logCounts
    const out: Record<string, number> = { ...inv }
    for (const [k, v] of Object.entries(logCounts)) out[k] = Math.max(out[k] ?? 0, v)
    return out
  }, [progress, logCounts, countSource])

  const quests = useMemo<QuestProgress[]>(() => {
    if (!progress) return []
    const completedSet = new Set(progress.completedQuests)
    return posky.quests.map((q) => computeQuestProgress(q, held, completedSet))
  }, [progress, held])

  const classes = useMemo(() => [...new Set(posky.quests.map((q) => q.className))].sort(), [])

  return {
    character,
    quests,
    classes,
    progress,
    lootHistory,
    countSource,
    setCountSource,
    reloadInventory,
    setQuestComplete,
    inventoryInfo: progress?.inventorySource
  }
}
