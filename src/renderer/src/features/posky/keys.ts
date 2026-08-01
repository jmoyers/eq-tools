import type { PoskyQuest } from '@shared/types'

export function questKey(q: Pick<PoskyQuest, 'className' | 'name'>): string {
  return `${q.className}::${q.name}`
}
