import type { QuestSource } from './types'
import { eqlegendsSource } from './eqlegends'

/** Registry of quest-data sources, keyed by profile id. */
export const SOURCES: Record<string, QuestSource> = {
  [eqlegendsSource.id]: eqlegendsSource
}

export function getSource(id: string): QuestSource | undefined {
  return SOURCES[id]
}
