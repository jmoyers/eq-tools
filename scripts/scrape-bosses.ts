/**
 * Curated EQ Legends raid-target roster → src/renderer/src/data/eqlegends/bosses.json.
 * Each target's image is pulled from its wiki page via the MediaWiki pageimages API
 * (hotlinked at runtime; the renderer CSP allows https images).
 *
 *   npm run scrape:bosses
 *
 * `match` holds the exact in-log "slain" names used to detect kills.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { BossData, RaidTarget } from '../src/shared/types'

const API = 'https://eqlwiki.com/api.php'
const UA = 'eq-tools-bosses/0.1 (personal raid tracker)'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Curated {
  name: string
  category: string
  page?: string
  match: string[]
  zone?: string
}

const TARGETS: Curated[] = [
  // Plane of Hate
  { name: 'Innoruuk, the Prince of Hate', category: 'Plane of Hate', page: 'Innoruuk', match: ['Innoruuk, the Prince of Hate'], zone: 'Plane of Hate' },
  { name: 'Maestro of Rancor', category: 'Plane of Hate', match: ['Maestro of Rancor'], zone: 'Plane of Hate' },
  { name: 'Lord of Loathing', category: 'Plane of Hate', match: ['Lord of Loathing'], zone: 'Plane of Hate' },
  { name: 'High Priest M`kari', category: 'Plane of Hate', match: ['High Priest M`kari'], zone: 'Plane of Hate' },
  { name: 'Ashenbone Broodmaster', category: 'Plane of Hate', match: ['Ashenbone Broodmaster'], zone: 'Plane of Hate' },
  { name: 'Magi P`tasa', category: 'Plane of Hate', match: ['Magi P`tasa'], zone: 'Plane of Hate' },
  { name: 'Coercer T`vala', category: 'Plane of Hate', match: ['Coercer T`vala'], zone: 'Plane of Hate' },

  // Plane of Fear
  { name: 'Cazic Thule', category: 'Plane of Fear', match: ['Cazic Thule', 'Cazic-Thule'], zone: 'Plane of Fear' },
  { name: 'Dread', category: 'Plane of Fear', match: ['Dread'], zone: 'Plane of Fear' },
  { name: 'Terror', category: 'Plane of Fear', match: ['Terror'], zone: 'Plane of Fear' },
  { name: 'Fright', category: 'Plane of Fear', match: ['Fright'], zone: 'Plane of Fear' },
  { name: 'Phoboplasm', category: 'Plane of Fear', match: ['Phoboplasm'], zone: 'Plane of Fear' },
  { name: 'Corrupter of Life', category: 'Plane of Fear', match: ['Corrupter of Life'], zone: 'Plane of Fear' },

  // Plane of Sky
  { name: 'The Spiroc Lord', category: 'Plane of Sky', page: 'Spiroc Lord', match: ['The Spiroc Lord'], zone: 'Plane of Sky' },
  { name: 'Sister of the Spire', category: 'Plane of Sky', match: ['Sister of the Spire'], zone: 'Plane of Sky' },
  { name: 'Bazzt Zzzt', category: 'Plane of Sky', match: ['Bazzt Zzzt'], zone: 'Plane of Sky' },
  { name: 'Eye of Veeshan', category: 'Plane of Sky', match: ['Eye of Veeshan'], zone: 'Plane of Sky' },

  // Dragons
  { name: 'Lord Nagafen', category: 'Dragons', match: ['Lord Nagafen'], zone: "Nagafen's Lair" },
  { name: 'Lady Vox', category: 'Dragons', match: ['Lady Vox'], zone: 'Permafrost Keep' },
  { name: 'Gorenaire', category: 'Dragons', match: ['Gorenaire'], zone: 'Dreadlands' },
  { name: 'Talendor', category: 'Dragons', match: ['Talendor'], zone: 'Skyfire Mountains' },
  { name: 'Severilous', category: 'Dragons', match: ['Severilous'], zone: 'The Emerald Jungle' },
  { name: 'Faydedar', category: 'Dragons', match: ['Faydedar'], zone: 'Timorous Deep' },
  { name: 'Trakanon', category: 'Dragons', match: ['Trakanon'], zone: 'Old Sebilis' },
  { name: 'Venril Sathir', category: 'Dragons', match: ['Venril Sathir'], zone: "Karnor's Castle" },
  { name: 'Drelzna', category: 'Dragons', match: ['Drelzna'], zone: "Nagafen's Lair" },

  // Other named
  { name: 'Efreeti Lord Djarn', category: 'Other Named', match: ['Efreeti Lord Djarn'], zone: "Solusek's Eye" }
]

const HOST = 'https://eqlwiki.com'

/** Grab the first non-loot-icon content image from the mob's wiki page. */
async function fetchImage(page: string): Promise<string | undefined> {
  const url = `${API}?action=parse&page=${encodeURIComponent(
    page
  )}&prop=text&format=json&formatversion=2&redirects=1`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    const json = (await res.json()) as { parse?: { text?: string }; error?: unknown }
    const html = json.parse?.text
    if (!html) return undefined
    const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1])
    // Prefer a portrait: an /images/ file that isn't a loot-item icon.
    const pick = srcs.find((s) => /\/images\//.test(s) && !/Item_\d+/i.test(s))
    if (!pick) return undefined
    return pick.startsWith('http') ? pick : HOST + pick
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const targets: RaidTarget[] = []
  let withImg = 0
  for (const t of TARGETS) {
    const image = await fetchImage(t.page ?? t.name)
    if (image) withImg++
    targets.push({ name: t.name, category: t.category, match: t.match, zone: t.zone, image })
    console.log(`  ${image ? '🖼 ' : '·  '}${t.name}`)
    await sleep(120)
  }
  const data: BossData = { scrapedAt: new Date().toISOString(), targets }
  const here = dirname(fileURLToPath(import.meta.url))
  const outDir = resolve(here, '../src/renderer/src/data/eqlegends')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, 'bosses.json')
  writeFileSync(outPath, JSON.stringify(data, null, 2))
  console.log(`\nWrote ${targets.length} targets (${withImg} with images) → ${outPath}`)
}

void main()
