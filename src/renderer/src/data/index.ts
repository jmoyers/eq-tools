import type { BossData, PoskyData } from '@shared/types'
import { DEFAULT_PROFILE } from '@shared/profiles'
import eqlegends from './eqlegends/posky.json'
import eqlegendsBosses from './eqlegends/bosses.json'

// Bundled quest datasets keyed by profile id. Add a profile's dataset here after
// scraping it (npm run scrape:posky -- --source <id>).
const DATASETS: Record<string, PoskyData> = {
  eqlegends
}

const BOSSES: Record<string, BossData> = {
  eqlegends: eqlegendsBosses
}

const PROFILE_KEY = 'eq.profile'

export function activeProfileId(): string {
  try {
    // `|| DEFAULT` semantics deliberately: an EMPTY stored id is as unusable as a
    // missing one, so both fall back rather than selecting an unknown profile.
    const id = localStorage.getItem(PROFILE_KEY)
    return id === null || id === '' ? DEFAULT_PROFILE : id
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

export function getBossData(profileId: string = activeProfileId()): BossData {
  return BOSSES[profileId] ?? { scrapedAt: '', targets: [] }
}
