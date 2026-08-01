/**
 * A "game profile" identifies a server / ruleset. Different EverQuest versions
 * and emulators have wildly different quest rules, item stats, and even log
 * formats, so the app is built around swappable profiles:
 *   - quest data is scraped per profile and bundled under data/<id>/
 *   - log parsing uses a per-profile ruleset (see main/log/rulesets.ts)
 * Adding a new server later (e.g. Project 1999) means adding a profile here, a
 * scraper source (scripts/sources/<id>.ts), and a log ruleset.
 */
export interface GameProfile {
  id: string
  label: string
  description: string
  /** whether quest data has been scraped & bundled for this profile */
  available: boolean
}

export const PROFILES: GameProfile[] = [
  {
    id: 'eqlegends',
    label: 'EverQuest Legends',
    description: 'Daybreak EverQuest Legends server — quest data from eqlwiki.com',
    available: true
  },
  {
    id: 'p99',
    label: 'Project 1999',
    description: 'Classic EQ emulator (wiki.project1999.com) — not yet imported',
    available: false
  }
]

export const DEFAULT_PROFILE = 'eqlegends'

export function getProfile(id: string): GameProfile | undefined {
  return PROFILES.find((p) => p.id === id)
}
