import type { PoskyData } from '../../src/shared/types'

/**
 * A quest-data source scrapes Plane of Sky (or equivalent) quest data for a
 * specific server/profile and returns it in the app's normalized shape. Add a new
 * server by implementing this and registering it in ./index.ts.
 */
export interface QuestSource {
  /** must match a profile id in src/shared/profiles.ts */
  id: string
  label: string
  scrape(): Promise<PoskyData>
}
