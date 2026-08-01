import type { PoskyData } from '@shared/types'
import { DEFAULT_PROFILE } from '@shared/profiles'
import eqlegends from './eqlegends/posky.json'

// Bundled quest datasets keyed by profile id. Add a profile's dataset here after
// scraping it (npm run scrape:posky -- --source <id>).
const DATASETS: Record<string, PoskyData> = {
  eqlegends: eqlegends as unknown as PoskyData
}

const PROFILE_KEY = 'eq.profile'

export function activeProfileId(): string {
  try {
    return localStorage.getItem(PROFILE_KEY) || DEFAULT_PROFILE
  } catch {
    return DEFAULT_PROFILE
  }
}

export function setActiveProfileId(id: string): void {
  localStorage.setItem(PROFILE_KEY, id)
}

export function getPoskyData(profileId: string = activeProfileId()): PoskyData {
  return DATASETS[profileId] ?? { scrapedAt: '', quests: [] }
}
