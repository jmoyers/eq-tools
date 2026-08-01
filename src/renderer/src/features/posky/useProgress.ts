import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LootEvent, PoskyData, PoskyQuest, ProgressState } from '@shared/types'
import poskyRaw from '../../data/posky.json'

const posky = poskyRaw as unknown as PoskyData

export function questKey(q: Pick<PoskyQuest, 'className' | 'name'>): string {
  return `${q.className}::${q.name}`
}

export interface ItemProgress {
  name: string
  who: string[]
  where: string
  need: number
  have: number
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
  /** 0..1 completion by item count */
  ratio: number
  missing: string[]
  completed: boolean
}

/** Merge held counts (inventory snapshot + live loot) into one lookup. */
function heldCounts(progress: ProgressState): Record<string, number> {
  const out: Record<string, number> = { ...progress.inventory }
  for (const [k, v] of Object.entries(progress.liveLoot)) out[k] = (out[k] ?? 0) + v
  return out
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
    return { name: it.name, who: it.who, where: it.where, need, have }
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
  reloadInventory: () => Promise<string>
  setQuestComplete: (key: string, complete: boolean) => Promise<void>
  inventoryInfo: ProgressState['inventorySource']
}

export function useProgress(lastLoot: LootEvent | null): UseProgress {
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [character, setCharacter] = useState<string | null>(null)

  useEffect(() => {
    void window.eq.getProgress().then(setProgress)
    void window.eq.getCharacter().then((c) => setCharacter(c?.name ?? null))
  }, [])

  // On each live loot event, refresh persisted progress (main already recorded it).
  useEffect(() => {
    if (lastLoot) void window.eq.getProgress().then(setProgress)
  }, [lastLoot])

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

  const quests = useMemo<QuestProgress[]>(() => {
    if (!progress) return []
    const held = heldCounts(progress)
    const completedSet = new Set(progress.completedQuests)
    return posky.quests.map((q) => computeQuestProgress(q, held, completedSet))
  }, [progress])

  const classes = useMemo(
    () => [...new Set(posky.quests.map((q) => q.className))].sort(),
    []
  )

  return {
    character,
    quests,
    classes,
    progress,
    reloadInventory,
    setQuestComplete,
    inventoryInfo: progress?.inventorySource
  }
}
