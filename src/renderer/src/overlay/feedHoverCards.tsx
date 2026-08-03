// feedHoverCards — the event overlay's HOVER CARDS: the item card ("what it is", then "what
// it's for") and the mob card (con facts, drop table, quest mentions), plus the fixed-position
// layer that clamps either one inside the window.
//
// Split out of EventLogOverlay so that file is the feed itself (rows, header, footer) and this
// one is everything a row reveals when you point at it.
//
// LAW (do not weaken): the overlay bundle is MUI-FREE except for the ONE lazily-imported
// ItemWindow below. A pinned, locked overlay — and any session where nothing is hovered — never
// pulls MUI into this window at all. Keep the import lazy and keep everything else plain
// React + inline styles.
//
// HONESTY (law 1): each block renders only if that source said something. An item whose lookup
// says nothing renders as its NAME with no "what it's for" block at all — an empty block would
// claim "we checked, there's nothing", which we cannot know.

import { type JSX, Suspense, lazy, useEffect, useState } from 'react'
import type { FeedConsider, ItemKnowledge, MobKnowledge } from '@shared/types'
import { CONSIDER_FACTION_COLOR, CONSIDER_FACTION_LABEL, considerDifficultyShort } from '@shared/logEvents'
import { questUseOutcomes, questUseWhere } from '../lib/itemKnowledgeView'

// The game-style item window is a MUI component; the overlay bundle is otherwise MUI-free by
// design. Loading it LAZILY keeps that promise where it matters — a pinned, locked overlay (and
// any session where the user never hovers a reward) never pulls MUI into this window at all.
const ItemWindow = lazy(() =>
  import('../lib/ItemWindow').then((m) => ({ default: m.ItemWindow }))
)

/** Card palette — the same semantics as EQ_ITEM_COLORS, respelled here so importing it
 *  (from ItemWindow.tsx, which pulls MUI at module scope) can't defeat the lazy import. */
const GOLD = '#d9b25f'
const CARD_TEXT = '#e9eaf2'
const CARD_LABEL = '#a8b0c6'
const CARD_ITEM = '#5fe08a'
const CARD_MONO = '"Consolas","Courier New",monospace'
/** How many quest uses / recipes the card lists before collapsing to "+N more". */
const MAX_LISTED = 4

// ---- item knowledge: ONE fetch per item name, for the whole window's lifetime ----------
//
// Both consumers here ask the same question of the same door (`window.eqOverlay.lookupItem`,
// which is cache-first in main): the tradeskill FILTER asks about every loot row that appears,
// and the hover CARD asks about the row you're pointing at. Sharing one map means a hovered
// loot item is normally already answered — the card paints from memory with no IPC at all —
// and two rows for the same item can never race into two round trips.
const KNOWLEDGE = new Map<string, ItemKnowledge>()
const PENDING = new Map<string, Promise<ItemKnowledge | null>>()

function cachedKnowledge(name: string): ItemKnowledge | undefined {
  return KNOWLEDGE.get(name.toLowerCase())
}

/** Resolve an item's knowledge, at most once per name. Never rejects — a miss resolves null. */
export function lookupItemCached(name: string): Promise<ItemKnowledge | null> {
  const key = name.toLowerCase()
  const hit = KNOWLEDGE.get(key)
  if (hit) return Promise.resolve(hit)
  const inflight = PENDING.get(key)
  if (inflight) return inflight
  const p = window.eqOverlay
    .lookupItem(name)
    .then((k: ItemKnowledge) => {
      KNOWLEDGE.set(key, k)
      PENDING.delete(key)
      return k
    })
    .catch(() => {
      PENDING.delete(key)
      return null
    })
  PENDING.set(key, p)
  return p
}

/**
 * Knowledge for a card that is CURRENTLY OPEN. The card mounts on hover and unmounts on leave,
 * so "on mount" IS "on first hover" — a feed of 100 rows costs zero lookups until one is
 * pointed at, and a second hover of the same row costs nothing at all (the map above).
 */
function useItemKnowledge(name: string): { data: ItemKnowledge | null; loading: boolean } {
  const [data, setData] = useState<ItemKnowledge | null>(() => cachedKnowledge(name) ?? null)
  const [loading, setLoading] = useState(() => !cachedKnowledge(name))

  useEffect(() => {
    const hit = cachedKnowledge(name)
    if (hit) {
      setData(hit)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void lookupItemCached(name).then((k) => {
      if (!alive) return
      setData(k)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [name])

  return { data, loading }
}

const LABEL_STYLE: React.CSSProperties = { color: CARD_LABEL, fontSize: 10, lineHeight: 1.4 }
const TEXT_STYLE: React.CSSProperties = { color: CARD_TEXT, fontSize: 10, lineHeight: 1.4 }

/**
 * "What it's for" — the block BELOW the hairline, mirroring the main window's KnownItemTooltip:
 * quest uses first (the reason an item is notable at all), then the recipes that consume it,
 * which is the honest answer for the big family of QUEST-ITEM-flagged tradeskill components.
 *
 * Outcomes are PLAIN TEXT here, unlike the main window's nested card. This is a compact,
 * always-on-top window with no room to escape a popper chain and no dismiss affordance: ONE
 * card, no hops. Renders nothing when we know nothing (an empty block would read as "checked,
 * nothing there", which a failed lookup can't claim).
 */
function WhatItsFor({ k }: { k: ItemKnowledge }): JSX.Element | null {
  const uses = k.questUses
  const recipes = k.recipes ?? []
  if (uses.length === 0 && recipes.length === 0) return null

  const shownUses = uses.slice(0, MAX_LISTED)
  const shownRecipes = recipes.slice(0, MAX_LISTED)

  return (
    <div
      data-testid="feed-card-uses"
      style={{
        marginTop: 6,
        paddingTop: 5,
        borderTop: '1px solid rgba(255,255,255,0.12)',
        fontFamily: CARD_MONO
      }}
    >
      {shownUses.length > 0 && (
        <div style={{ marginBottom: shownRecipes.length > 0 ? 5 : 0 }}>
          <div style={LABEL_STYLE}>Used in {uses.length === 1 ? 'quest' : 'quests'}:</div>
          {shownUses.map((u) => {
            const where = questUseWhere(u)
            const outcomes = questUseOutcomes(u)
            return (
              <div key={`${u.source}:${u.page ?? ''}:${u.quest}:${u.role ?? ''}`} style={{ marginTop: 2 }}>
                <div style={TEXT_STYLE}>
                  {u.quest}
                  {u.role === 'reward' && <span style={{ color: CARD_LABEL }}> · reward</span>}
                  {where && <span style={{ color: CARD_LABEL }}> · {where}</span>}
                </div>
                {/* Turning it in yields these. Named, never hoverable — see the header above. */}
                {outcomes.length > 0 && (
                  <div style={{ ...LABEL_STYLE, paddingLeft: 8 }}>→ {outcomes.join(', ')}</div>
                )}
              </div>
            )
          })}
          {uses.length > shownUses.length && (
            <div style={LABEL_STYLE}>+{uses.length - shownUses.length} more</div>
          )}
        </div>
      )}

      {shownRecipes.length > 0 && (
        <div>
          <div style={LABEL_STYLE}>Used in {recipes.length === 1 ? 'recipe' : 'recipes'}:</div>
          {shownRecipes.map((r) => {
            const how = [r.tradeskill, r.trivial != null ? String(r.trivial) : null]
              .filter(Boolean)
              .join(' ')
            return (
              <div key={`${r.tradeskill ?? ''}:${r.recipe}`} style={{ ...LABEL_STYLE, marginTop: 2 }}>
                <span style={{ color: CARD_ITEM }}>{r.recipe}</span>
                {how && <> · {how}</>}
              </div>
            )
          })}
          {recipes.length > shownRecipes.length && (
            <div style={LABEL_STYLE}>+{recipes.length - shownRecipes.length} more</div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * THE item hover card — one component behind every hover in this window (a quest's reward item
 * and a loot row's item alike). It answers the two questions a name can't: what it IS (the same
 * game item window the loot dialog and posky tooltip draw) and what it's FOR (WhatItsFor).
 *
 * It prefers a live `lookupItem` result (structured stats + icon, cache-first in main) and falls
 * back to the stat blob the scraped quest data already carries, so a reward renders instantly
 * and offline. Neither available ⇒ ItemWindow shows just the NAME, which is the honest answer.
 */
export function ItemHoverCard({ item, stats }: { item: string; stats?: string }): JSX.Element {
  const { data, loading } = useItemKnowledge(item)
  return (
    <div
      data-testid="feed-item-card"
      data-item={item}
      style={{
        background: 'rgba(15,16,23,0.98)',
        border: `1px solid ${GOLD}`,
        borderRadius: 6,
        padding: 8,
        maxWidth: 300,
        boxShadow: '0 6px 20px rgba(0,0,0,0.6)'
      }}
    >
      <Suspense fallback={<div style={{ fontSize: 11, color: CARD_ITEM, fontFamily: CARD_MONO }}>{item}</div>}>
        <ItemWindow
          name={item}
          stats={data?.stats}
          rawStats={stats ?? data?.statsBlock}
          iconId={data?.iconId}
          flavor={data?.summary}
          compact
        />
      </Suspense>
      {loading && !data && (
        <div style={{ ...LABEL_STYLE, fontFamily: CARD_MONO, marginTop: 4 }}>Looking up…</div>
      )}
      {data && <WhatItsFor k={data} />}
      {data?.offline && (
        <div style={{ ...LABEL_STYLE, fontFamily: CARD_MONO, marginTop: 4 }}>
          offline — showing what&apos;s known locally
        </div>
      )}
    </div>
  )
}

// ---- mob knowledge: ONE fetch per mob name, for the whole window's lifetime ---------------
//
// The same discipline the item map above uses, for the same reason: a feed of 100 rows costs
// zero lookups until one is pointed at, and re-hovering costs nothing at all. `mobs:lookup` is
// cache-first AND local-first in main (your own loot history + the quest catalog answer with no
// network), so the usual case is a single IPC round trip.
const MOB_KNOWLEDGE = new Map<string, MobKnowledge>()
const MOB_PENDING = new Map<string, Promise<MobKnowledge | null>>()

/** Resolve a mob's knowledge, at most once per name. Never rejects — a miss resolves null. */
function lookupMobCached(name: string): Promise<MobKnowledge | null> {
  const key = name.toLowerCase()
  const hit = MOB_KNOWLEDGE.get(key)
  if (hit) return Promise.resolve(hit)
  const inflight = MOB_PENDING.get(key)
  if (inflight) return inflight
  const p = window.eqOverlay
    .lookupMob(name)
    .then((k: MobKnowledge) => {
      MOB_KNOWLEDGE.set(key, k)
      MOB_PENDING.delete(key)
      return k
    })
    .catch(() => {
      MOB_PENDING.delete(key)
      return null
    })
  MOB_PENDING.set(key, p)
  return p
}

/** Knowledge for a mob card that is CURRENTLY OPEN (mount == first hover). */
function useMobKnowledge(name: string): { data: MobKnowledge | null; loading: boolean } {
  const [data, setData] = useState<MobKnowledge | null>(() => MOB_KNOWLEDGE.get(name.toLowerCase()) ?? null)
  const [loading, setLoading] = useState(() => !MOB_KNOWLEDGE.get(name.toLowerCase()))

  useEffect(() => {
    const hit = MOB_KNOWLEDGE.get(name.toLowerCase())
    if (hit) {
      setData(hit)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void lookupMobCached(name).then((k) => {
      if (!alive) return
      setData(k)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [name])

  return { data, loading }
}

/** How many drops a mob card lists before collapsing to "+N more". Kept tight — this window
 *  floats over the game, and a 44-item table (a zol ghoul knight's real page) would swallow it. */
const MAX_DROPS = 6

/**
 * THE mob hover card — what a `/con` was actually asking. It leads with the facts the log line
 * already gave (faction rung, level, rare), then the DROP TABLE.
 *
 * ORDERING IS A CLAIM ABOUT AUTHORITY. The wiki's drop list is the definitive statement of what
 * this mob drops, so it leads; your own loot history is CORROBORATION and rides on the matching
 * row as "×N". Only items your history has that the page does NOT list get their own (secondary)
 * block — one lucky drop is evidence, not a drop table.
 *
 * HONESTY (law 1): each block renders only if that source said something. A mob whose page
 * doesn't exist shows the con facts and "no wiki page" — never an empty drop table dressed up
 * as "drops nothing". Item names are PLAIN TEXT here (the card is `pointerEvents:none` — see
 * HoverCardLayer — so a nested hover is impossible by construction); the main window's card is
 * where item names become KnownItemTooltip anchors and click through to the item dialog.
 */
/** A titled block of card rows, above a hairline. Renders nothing when the source said nothing. */
function CardSection({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div style={{ marginTop: 6, paddingTop: 5, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
      <div style={LABEL_STYLE}>{label}</div>
      {children}
    </div>
  )
}

/** `+N more` under a truncated list. */
function MoreLine({ total, shown }: { total: number; shown: number }): JSX.Element | null {
  if (total <= shown) return null
  return <div style={LABEL_STYLE}>+{total - shown} more</div>
}

/** The con line: faction rung, level and the short difficulty word, exactly as logged. */
function ConLine({ con }: { con?: FeedConsider }): JSX.Element | null {
  if (!con) return null
  return (
    <div style={LABEL_STYLE}>
      {CONSIDER_FACTION_LABEL[con.faction]}
      {con.level != null && ` · Lvl ${con.level}`}
      {` · ${considerDifficultyShort(con.difficulty) ?? con.difficulty}`}
    </div>
  )
}

/** The page's own level/zone, when it states them — a range as often as a number. */
function PageLevelZone({ data }: { data: MobKnowledge | null }): JSX.Element | null {
  if (!data) return null
  if (!data.levelText && !data.zone) return null
  return (
    <div style={LABEL_STYLE}>
      {data.zone}
      {data.zone && data.levelText && ' · '}
      {data.levelText && `lvl ${data.levelText}`}
    </div>
  )
}

/** THE DROP TABLE (definitive), with your own counts riding on the matching rows. */
function WikiDrops({
  wiki,
  seenByKey
}: {
  wiki: { item: string; rarity?: string }[]
  seenByKey: Map<string, { item: string; count: number }>
}): JSX.Element | null {
  if (wiki.length === 0) return null
  return (
    <CardSection label="Drops:">
      {wiki.slice(0, MAX_DROPS).map((d) => {
        const mine = seenByKey.get(d.item.toLowerCase())
        return (
          <div key={d.item} style={TEXT_STYLE}>
            <span style={{ color: CARD_ITEM }}>{d.item}</span>
            {d.rarity && <span style={{ color: CARD_LABEL }}> · {d.rarity}</span>}
            {mine && <span style={{ color: '#7fd8a0' }}> · seen {mine.count}×</span>}
          </div>
        )
      })}
      <MoreLine total={wiki.length} shown={MAX_DROPS} />
    </CardSection>
  )
}

/** Evidence the page doesn't carry — secondary by construction. */
function ExtraSeenDrops({ extraSeen }: { extraSeen: { item: string; count: number }[] }): JSX.Element | null {
  if (extraSeen.length === 0) return null
  return (
    <CardSection label="Also looted by you:">
      {extraSeen.slice(0, MAX_DROPS).map((d) => (
        <div key={d.item} style={TEXT_STYLE}>
          <span style={{ color: CARD_ITEM }}>{d.item}</span>
          <span style={{ color: CARD_LABEL }}> ×{d.count}</span>
        </div>
      ))}
      <MoreLine total={extraSeen.length} shown={MAX_DROPS} />
    </CardSection>
  )
}

/** Quests that name this mob. */
function MobQuests({ quests }: { quests: { quest: string; zone?: string }[] }): JSX.Element | null {
  if (quests.length === 0) return null
  return (
    <CardSection label={`Named by ${quests.length === 1 ? 'quest' : 'quests'}:`}>
      {quests.slice(0, MAX_DROPS).map((q) => (
        <div key={q.quest} style={TEXT_STYLE}>
          {q.quest}
          {q.zone && <span style={{ color: CARD_LABEL }}> · {q.zone}</span>}
        </div>
      ))}
      <MoreLine total={quests.length} shown={MAX_DROPS} />
    </CardSection>
  )
}

/**
 * Say the honest thing when a source came back empty, and ONLY for the source that did (law 1) —
 * "no wiki page" is a different statement from "its wiki page lists no loot".
 */
function MobCardFooter({
  data,
  loading,
  wikiCount
}: {
  data: MobKnowledge | null
  loading: boolean
  wikiCount: number
}): JSX.Element {
  return (
    <>
      {loading && !data && <div style={{ ...LABEL_STYLE, marginTop: 4 }}>Looking up…</div>}
      {data?.notFound && <div style={{ ...LABEL_STYLE, marginTop: 4 }}>no wiki page</div>}
      {data && !data.notFound && !data.offline && wikiCount === 0 && (
        <div style={{ ...LABEL_STYLE, marginTop: 4 }}>its wiki page lists no loot</div>
      )}
      {data?.offline && (
        <div style={{ ...LABEL_STYLE, marginTop: 4 }}>offline — showing what&apos;s known locally</div>
      )}
    </>
  )
}

export function MobHoverCard({ mob, con }: { mob: string; con?: FeedConsider }): JSX.Element {
  const { data, loading } = useMobKnowledge(mob)
  const seen = data?.dropsSeen ?? []
  const wiki = data?.dropsWiki ?? []
  const quests = data?.quests ?? []
  const seenByKey = new Map(seen.map((d) => [d.item.toLowerCase(), d]))
  const wikiKeys = new Set(wiki.map((d) => d.item.toLowerCase()))
  const extraSeen = seen.filter((d) => !wikiKeys.has(d.item.toLowerCase()))
  const factionColor = con ? CONSIDER_FACTION_COLOR[con.faction] : CARD_TEXT

  return (
    <div
      data-testid="feed-mob-card"
      data-mob={mob}
      style={{
        background: 'rgba(15,16,23,0.98)',
        border: `1px solid ${factionColor}`,
        borderRadius: 6,
        padding: 8,
        maxWidth: 300,
        fontFamily: CARD_MONO,
        boxShadow: '0 6px 20px rgba(0,0,0,0.6)'
      }}
    >
      <div style={{ color: factionColor, fontSize: 12, fontWeight: 700 }}>
        {mob}
        {con?.rare && <span style={{ ...LABEL_STYLE, marginLeft: 5 }}>rare</span>}
      </div>
      <ConLine con={con} />
      <PageLevelZone data={data} />

      {/* 1. the definitive drop table, 2. evidence the page doesn't carry, 3. quest mentions. */}
      <WikiDrops wiki={wiki} seenByKey={seenByKey} />
      <ExtraSeenDrops extraSeen={extraSeen} />
      <MobQuests quests={quests} />

      <MobCardFooter data={data} loading={loading} wikiCount={wiki.length} />
    </div>
  )
}
