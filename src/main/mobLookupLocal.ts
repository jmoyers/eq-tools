// mobLookupLocal.ts — the COMMITTED-DATASET half of mob knowledge (Task #63).
//
// Split out from mobLookup.ts (which imports electron `app` for the userData cache) so the two
// local-first indexes are importable in the node test runner, exactly the way itemLookupParse.ts
// is split from itemLookup.ts. No network, no cache, no electron: just the two scraped JSON
// datasets and the lookups over them.
//
//   LOCAL 1 — mobs.json  (scripts/scrape-mobs.ts): the DEFINITIVE drop table. The wiki states
//             what a mob can drop; that is static content, so it is scraped once and committed
//             rather than fetched per `/con`. This is why a consider answers instantly and
//             offline, and why `mobLookup`'s live wiki call is only a fallback for mobs the
//             catalog doesn't have yet.
//   LOCAL 2 — quests.json (scripts/scrape-quests.ts): `relatedNpcs`, the quests that name a mob.
//
// Both JSONs are ES-imported so electron-vite INLINES them into the main bundle — a
// path-relative readFile would miss in out/main/ (AGENTS.md toolchain note).

import { mobKey } from './mobLookupParse'
import type { MobData, MobDrop, MobEntry, MobKnowledge, MobQuestUse, QuestData } from '../shared/types'
import mobsJson from '../renderer/src/data/eqlegends/mobs.json'
import questsJson from '../renderer/src/data/eqlegends/quests.json'

// ---- LOCAL 1: the scraped mob catalog (the definitive drop table) ---------------

const mobData = mobsJson as unknown as MobData

/**
 * Index the committed mob catalog by canonical name. Keyed BOTH ways a mob can be named:
 *   - the page's `|name` (the IN-GAME name, which is what a consider line prints), and
 *   - the wiki PAGE TITLE, which for most mobs is the same string title-cased ("A Froglok Gaz
 *     Knight" redirects to "A froglok gaz knight") but is occasionally the only spelling.
 * `mobKey` folds casing and the three apostrophe glyphs, so the two keys collapse for most
 * mobs. The page-title pass runs SECOND and only fills gaps, so a real mob's own name can
 * never be displaced by another page's title.
 */
const mobByName = new Map<string, MobEntry>()
for (const m of mobData.mobs ?? []) {
  const key = mobKey(m.name)
  if (key && !mobByName.has(key)) mobByName.set(key, m)
}
for (const m of mobData.mobs ?? []) {
  const key = mobKey(m.page)
  if (key && !mobByName.has(key)) mobByName.set(key, m)
}

/** The catalog's entry for a mob, or null when it has none (⇒ try the live wiki fallback). */
export function localMobEntry(name: string): MobEntry | null {
  return mobByName.get(mobKey(name)) ?? null
}

/** How many mobs the committed catalog holds (diagnostic / startup log). */
export const MOB_CATALOG_SIZE = mobData.mobs?.length ?? 0

/**
 * Turn a catalog entry into the WIKI half of a knowledge record. The catalog is compact by
 * design (names only — see MobEntry), so a per-drop `rarity` is simply ABSENT here; the live
 * fallback is where one comes from. Absent is honest; a made-up rarity would not be.
 */
export function knowledgeFromCatalog(display: string, e: MobEntry): MobKnowledge {
  const out: MobKnowledge = { name: display, page: e.page, cached: true }
  if (e.level) out.levelText = e.level
  if (e.zones?.length) out.zone = e.zones.join(', ')
  if (e.drops?.length) out.dropsWiki = e.drops.map((item): MobDrop => ({ item }))
  return out
}

// ---- LOCAL 2: quest catalog cross-ref (relatedNpcs) ----------------------------

const questData = questsJson as unknown as QuestData

/**
 * Index the scraped quest catalog by mob name → the quests that name it under "Related NPCs".
 * 764 of the 905 catalog quests list at least one, covering 1,121 distinct NPC names — which is
 * how a conned mob can carry a quest badge with zero network.
 *
 * Keyed by `mobKey` so the catalog's casing ("A Giant Rat") folds onto the log's ("a giant rat")
 * — the same canonicalize-at-the-boundary rule the KillMap uses (world-model law 2).
 */
const questsByMob = new Map<string, MobQuestUse[]>()
for (const q of questData.quests ?? []) {
  for (const npc of q.relatedNpcs ?? []) {
    const key = mobKey(npc)
    if (!key) continue
    const uses = questsByMob.get(key) ?? []
    if (!uses.some((u) => u.quest === q.name)) {
      uses.push({ quest: q.name, page: q.page, giver: q.giver, zone: q.startZone })
    }
    questsByMob.set(key, uses)
  }
}

/** Quests the LOCAL catalog ties to this mob. Null when it knows none (never an empty claim). */
export function localMobQuests(name: string): MobQuestUse[] | null {
  const uses = questsByMob.get(mobKey(name))
  return uses?.length ? uses : null
}
