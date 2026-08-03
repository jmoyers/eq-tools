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

const EQL = 'https://eqlwiki.com'
const P99 = 'https://wiki.project1999.com'
const UA = 'Mozilla/5.0 everquest-companion/0.2 (personal raid tracker)'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Curated {
  name: string
  category: string
  /** eqlwiki page title override */
  page?: string
  /** Project 1999 wiki page title override (better classic NPC portraits) */
  p99?: string
  /** manual image URL override (highest priority) */
  image?: string
  match: string[]
  zone?: string
}

// Classic-only (no Kunark/Velious). Ordered as the EQL progression:
// Nagafen -> Vox -> Yael -> Plane of Fear -> Plane of Hate -> Plane of Sky.
const TARGETS: Curated[] = [
  // Open-world raid targets (early progression). Naggy/Vox are dragons, Yael a
  // lich — grouped as the pre-plane open-world bosses.
  { name: 'Lord Nagafen', category: 'Open World', match: ['Lord Nagafen'], zone: "Nagafen's Lair" },
  { name: 'Lady Vox', category: 'Open World', match: ['Lady Vox'], zone: 'Permafrost Keep' },
  { name: 'Master Yael', category: 'Open World', match: ['Master Yael'], zone: 'The Hole' },

  // Plane of Fear
  { name: 'Cazic Thule', category: 'Plane of Fear', p99: 'Cazic Thule (God)', match: ['Cazic Thule', 'Cazic-Thule'], zone: 'Plane of Fear' },
  { name: 'Dread', category: 'Plane of Fear', match: ['Dread'], zone: 'Plane of Fear' },
  { name: 'Terror', category: 'Plane of Fear', match: ['Terror'], zone: 'Plane of Fear' },
  { name: 'Fright', category: 'Plane of Fear', match: ['Fright'], zone: 'Plane of Fear' },
  { name: 'A dracoliche', category: 'Plane of Fear', page: 'A dracoliche', match: ['a dracoliche', 'A dracoliche'], zone: 'Plane of Fear' },

  // Plane of Hate (Innoruuk + minis)
  { name: 'Innoruuk', category: 'Plane of Hate', page: 'Innoruuk', match: ['Innoruuk, the Prince of Hate', 'Innoruuk'], zone: 'Plane of Hate' },
  { name: 'Maestro of Rancor', category: 'Plane of Hate', match: ['Maestro of Rancor'], zone: 'Plane of Hate' },
  { name: 'Lord of Loathing', category: 'Plane of Hate', match: ['Lord of Loathing'], zone: 'Plane of Hate' },
  { name: 'Lord of Ire', category: 'Plane of Hate', match: ['Lord of Ire'], zone: 'Plane of Hate' },
  { name: 'Master of Spite', category: 'Plane of Hate', match: ['Master of Spite'], zone: 'Plane of Hate' },
  { name: 'Mistress of Scorn', category: 'Plane of Hate', match: ['Mistress of Scorn'], zone: 'Plane of Hate' },
  { name: 'High Priest M`kari', category: 'Plane of Hate', match: ['High Priest M`kari'], zone: 'Plane of Hate' },
  { name: 'Magi P`tasa', category: 'Plane of Hate', match: ['Magi P`tasa'], zone: 'Plane of Hate' },
  { name: 'Coercer T`vala', category: 'Plane of Hate', match: ['Coercer T`vala'], zone: 'Plane of Hate' },
  { name: 'Grandmaster R`Tal', category: 'Plane of Hate', match: ['Grandmaster R`Tal'], zone: 'Plane of Hate' },
  { name: 'Ashenbone Broodmaster', category: 'Plane of Hate', match: ['Ashenbone Broodmaster'], zone: 'Plane of Hate' },
  { name: 'Avatar of Abhorrence', category: 'Plane of Hate', match: ['Avatar of Abhorrence'], zone: 'Plane of Hate' },

  // Plane of Sky (island bosses, in island order)
  { name: 'Thunder Spirit Princess', category: 'Plane of Sky', match: ['Thunder Spirit Princess'], zone: 'Plane of Sky — Island 1' },
  { name: 'Noble Dojorn', category: 'Plane of Sky', match: ['Noble Dojorn'], zone: 'Plane of Sky — Island 1.5' },
  { name: 'Protector of Sky', category: 'Plane of Sky', match: ['Protector of Sky'], zone: 'Plane of Sky — Island 2' },
  { name: 'Gorgalosk', category: 'Plane of Sky', match: ['Gorgalosk'], zone: 'Plane of Sky — Island 3' },
  { name: 'Keeper of Souls', category: 'Plane of Sky', match: ['Keeper of Souls'], zone: 'Plane of Sky — Island 4' },
  { name: 'The Spiroc Lord', category: 'Plane of Sky', page: 'Spiroc Lord', match: ['The Spiroc Lord'], zone: 'Plane of Sky — Island 5' },
  { name: 'Bazzt Zzzt', category: 'Plane of Sky', match: ['Bazzt Zzzt'], zone: 'Plane of Sky — Island 6' },
  { name: 'Sister of the Spire', category: 'Plane of Sky', match: ['Sister of the Spire'], zone: 'Plane of Sky — Island 7' },
  { name: 'Eye of Veeshan', category: 'Plane of Sky', match: ['Eye of Veeshan'], zone: 'Plane of Sky — Island 8' },

  // Plane of Sky — the Efreeti Cycle (a spawn chain that FOLLOWS Eye in the
  // wiki's boss listing). Noble Dojorn (Island 1.5, above) is the "first kill in
  // the Efreeti Cycle"; killing him spawns the Overseer of Air (the wiki's
  // "second boss in the Efreeti Cycle", up on Island 4), whose death spawns the
  // Hand of Veeshan back on Island 8 (the final Efreeti-Cycle kill, sharing the
  // island with the Eye). These were missing from the roster — the log shows
  // both killed ('Overseer of Air has been slain by …', 'The Hand of Veeshan has
  // been slain by …'). The Hand's log name carries a leading 'the'/'The'
  // (lowercase mid-sentence, capitalized on the slain-by line) — bossStatus's
  // matchKey strips a single leading article, so 'hand of veeshan' matches both.
  { name: 'Overseer of Air', category: 'Plane of Sky', match: ['Overseer of Air'], zone: 'Plane of Sky — Efreeti Cycle (Island 4)' },
  { name: 'The Hand of Veeshan', category: 'Plane of Sky', page: 'The Hand of Veeshan', match: ['The Hand of Veeshan', 'the Hand of Veeshan'], zone: 'Plane of Sky — Efreeti Cycle (Island 8)' }
]

async function pageHtml(apiBase: string, page: string): Promise<string | undefined> {
  const url = `${apiBase}/api.php?action=parse&page=${encodeURIComponent(
    page
  )}&prop=text&format=json&redirects=1`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    const json = (await res.json()) as { parse?: { text?: string | { '*'?: string } }; error?: unknown }
    if (json.error) return undefined
    const t = json.parse?.text
    return typeof t === 'string' ? t : t?.['*']
  } catch {
    return undefined
  }
}

function imgSrcs(html: string): string[] {
  return [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => s.includes('/images/'))
}

/** Project 1999 wiki: prefer the "Npc_*" portrait convention. */
async function p99Image(page: string): Promise<string | undefined> {
  const html = await pageHtml(P99, page)
  if (!html) return undefined
  const srcs = imgSrcs(html)
  const pick = srcs.find((s) => /Npc_/i.test(s)) ?? srcs.find((s) => !/Item_|WarningIcon|\.svg/i.test(s))
  if (!pick) return undefined
  return pick.startsWith('http') ? pick : P99 + pick
}

/** EQ Legends wiki fallback: first non-loot-icon image. */
async function eqlImage(page: string): Promise<string | undefined> {
  const html = await pageHtml(EQL, page)
  if (!html) return undefined
  const pick = imgSrcs(html).find((s) => !/Item_\d+/i.test(s))
  if (!pick) return undefined
  return pick.startsWith('http') ? pick : EQL + pick
}

/** Multi-source image resolution: manual override → P99 portrait → eqlwiki. */
async function fetchImage(t: Curated): Promise<string | undefined> {
  if (t.image) return t.image
  const p99 = await p99Image(t.p99 ?? t.name)
  if (p99) return p99
  await sleep(80)
  return eqlImage(t.page ?? t.name)
}

async function main(): Promise<void> {
  const targets: RaidTarget[] = []
  let withImg = 0
  for (const t of TARGETS) {
    const image = await fetchImage(t)
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
