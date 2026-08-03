// MobPage (Task #64) — the ONE detail surface for a mob, app-wide.
//
// It is the grown-up form of Task #63's MobDetailDialog, which this file replaces. The dialog
// was right about the CONTENT and wrong about the container: two different tabs each opened
// their own modal over their own list, so "the mob you're looking at" was a transient thing you
// dismissed rather than a place you were. Now every surface that names a mob — the events
// overlay's con rows, the Mobs tab's search results and considered strip, the Raid Targets
// roster — routes to this page, and the page is where you ARE until you go back.
//
// WHAT IT ANSWERS, in the order the answers matter:
//   1. DROPS — the wiki's list, which is the DEFINITIVE statement of what this mob can drop.
//      It leads, and it is the reason the page exists ("loot listed out, tooltip style"). Each
//      row is annotated with what YOU have actually pulled off it ("seen by you: 3× · last
//      Aug 1"), because corroboration belongs beside the claim.
//   2. ALSO LOOTED BY YOU — anything your own history has that the page doesn't list. Secondary
//      by construction: it is evidence about one mob on one server, not the drop table.
//   3. QUESTS that name this mob, from the local catalog.
//   4. KILLS — what the kills module knows, when the caller has it.
//
// HONESTY (law 1) — every section states which of those three things happened: a source said
// something, a source said nothing, or we could not ask. "No wiki page for this mob" and "the
// page lists no loot" are DIFFERENT facts and are never collapsed into "no drops".
//
// ITEM NAMES ARE LIVE — hover for the EQ-style item window, click to drill into the item's own
// loot history. That half lives in MobDropRow.tsx (`DropRow` / `ItemDrillDown`), which explains
// why the loot module is subscribed only once an item is actually clicked.

import { type JSX, useEffect, useState } from 'react'
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import type { MobDrop, MobEntry, MobKnowledge, MobQuestUse, MobSeenDrop } from '@shared/types'
import { CONSIDER_FACTION_COLOR, CONSIDER_FACTION_LABEL, considerDifficultyShort } from '@shared/logEvents'
import { wikiPageUrl } from '@shared/wiki'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { tierStyle } from '../../lib/tierChip'
import { DropRow, ItemDrillDown } from './MobDropRow'
import { knowledgeFromEntry } from './mobSearch'
import type { MobConsiderContext, MobTarget } from './mobTarget'

/** What the calling surface knew about your kills on this mob, when it knew anything. */
type MobKillFacts = MobTarget['kill']

/**
 * Fetch the mob's knowledge on mount. `seed` is whatever the caller already attached to the row,
 * so the page paints instantly and then refreshes — main's lookup is cache-first and
 * local-first, so the refresh is usually free.
 *
 * `entry` PINS the identity half of the record. A lookup resolves a NAME, and an EQ name can
 * name several pages ("a bandit" is nine mobs in nine zones with nine drop tables); when the
 * user reached this page by clicking a specific catalog row, that row's page/level/zone/drops
 * are what they asked for, and the lookup contributes only what the catalog can't know — your
 * own loot history and the quests that name it. `notFound` is dropped in that case: we are
 * holding the page, so "there is no page" cannot be true.
 */
function useMobKnowledge(
  mob: string,
  seed?: MobKnowledge,
  entry?: MobEntry
): { data: MobKnowledge | null; loading: boolean } {
  const [fetched, setFetched] = useState<MobKnowledge | null>(seed ?? null)
  const [loading, setLoading] = useState(!seed)
  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.eq
      .lookupMob(mob)
      .then((k) => {
        if (alive) setFetched(k)
      })
      .catch(() => {
        /* main never rejects; guard anyway — a null record renders the honest empty states */
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [mob])

  if (!entry) return { data: fetched, loading }
  const pinned = knowledgeFromEntry(entry)
  const data: MobKnowledge = fetched
    ? { ...fetched, ...pinned, notFound: undefined }
    : { ...pinned, name: mob }
  return { data, loading }
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, flex: 1, minWidth: 110 }}>
      <Typography variant="h5" sx={{ color: 'primary.main', lineHeight: 1.1 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.disabled" display="block">
          {hint}
        </Typography>
      )}
    </Paper>
  )
}

/** A quiet, honest empty note — never a claim that a source said "nothing". */
function Quiet({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Typography variant="caption" color="text.disabled" display="block">
      {children}
    </Typography>
  )
}

/** The con-coloured headline plus everything the log line already said about identity. */
function MobIdentity({
  mob,
  con,
  kill
}: {
  mob: string
  con?: MobConsiderContext
  kill?: MobKillFacts
}): JSX.Element {
  const factionColor = con ? CONSIDER_FACTION_COLOR[con.faction] : undefined
  const tier = kill && kill.count > 0 ? tierStyle(kill.bestTier) : null
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="h6" sx={{ color: factionColor ?? 'text.primary' }}>
        {mob}
      </Typography>
      {con && (
        <Chip
          size="small"
          variant="outlined"
          label={CONSIDER_FACTION_LABEL[con.faction]}
          sx={{ height: 22, color: factionColor, borderColor: factionColor }}
        />
      )}
      {con?.rare && <Chip size="small" color="secondary" label="rare" sx={{ height: 22 }} />}
      {con?.level != null && (
        <Chip size="small" variant="outlined" label={`Lvl ${con.level}`} sx={{ height: 22 }} />
      )}
      {tier && (
        <Chip
          size="small"
          label={tier.label}
          sx={{ height: 22, bgcolor: tier.bg, color: tier.fg, fontWeight: 700 }}
        />
      )}
    </Stack>
  )
}

/** The consider sentence, verbatim — the thing the game actually told you. */
function MobConsiderLine({ con }: { con?: MobConsiderContext }): JSX.Element | null {
  if (!con) return null
  return (
    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25, mb: 1.5 }}>
      {considerDifficultyShort(con.difficulty) ?? con.difficulty}
      {con.difficulty && ` — “${con.difficulty}”`}
      {con.zone && ` · ${con.zone}`}
    </Typography>
  )
}

/** The four-up tally strip: what the page lists, what you've seen, kills, considers. */
function MobStats({
  wikiCount,
  seenCount,
  page,
  con,
  kill
}: {
  wikiCount: number
  seenCount: number
  page?: string
  con?: MobConsiderContext
  kill?: MobKillFacts
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2, mt: con ? 0 : 1.5 }}>
      <StatCard label="Known drops" value={String(wikiCount)} hint={page ? 'from the wiki page' : undefined} />
      <StatCard label="Looted by you" value={String(seenCount)} hint="distinct items" />
      <StatCard
        label="Kills"
        value={String(kill?.count ?? 0)}
        hint={kill?.lastTs ? `last ${formatDate(kill.lastTs)}` : undefined}
      />
      {con?.cons != null && <StatCard label="Considered" value={`${con.cons}×`} />}
    </Stack>
  )
}

/** Level/zone as the WIKI states them — a range as often as a number. */
function WikiLevelZone({ zone, levelText }: { zone?: string; levelText?: string }): JSX.Element | null {
  // Deliberately falsiness, not nullishness: an empty string from the page says nothing, so a
  // blank zone AND a blank level renders no line at all (what `zone || levelText` always meant).
  if (!zone && !levelText) return null
  return (
    <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
      {zone}
      {zone && levelText && ' · '}
      {levelText && `level ${levelText}`}
    </Typography>
  )
}

/**
 * What we say when the drop table is empty. Three DIFFERENT facts, never collapsed into one:
 * the lookup is still running, the wiki has no page, we could not reach the wiki, or the page
 * exists and genuinely lists no loot.
 */
function DropsEmptyState({
  data,
  loading
}: {
  data: MobKnowledge | null
  loading: boolean
}): JSX.Element {
  return (
    <Box sx={{ mb: 2 }}>
      {loading && !data && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
          <CircularProgress size={14} />
          <Typography variant="caption">Looking up this mob…</Typography>
        </Stack>
      )}
      {data?.notFound && <Quiet>No wiki page for this mob.</Quiet>}
      {data?.offline && <Quiet>Offline — showing only what&apos;s known locally.</Quiet>}
      {data && !data.notFound && !data.offline && data.page && (
        <Quiet>The wiki page for this mob lists no loot.</Quiet>
      )}
    </Box>
  )
}

/** ---- 1. DROPS (definitive) ---- */
function DropsSection({
  wiki,
  seenByKey,
  data,
  loading,
  onOpenItem
}: {
  wiki: MobDrop[]
  seenByKey: Map<string, MobSeenDrop>
  data: MobKnowledge | null
  loading: boolean
  onOpenItem: (item: string) => void
}): JSX.Element {
  return (
    <>
      <Typography variant="subtitle2" gutterBottom>
        Drops{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          (wiki drop table){wiki.length > 0 && ` · ${wiki.length}`}
        </Typography>
      </Typography>
      {wiki.length > 0 ? (
        <Box sx={{ mb: 2 }}>
          {wiki.map((d) => (
            <DropRow
              key={d.item}
              item={d.item}
              rarity={d.rarity}
              seen={seenByKey.get(d.item.toLowerCase())}
              onOpenItem={onOpenItem}
            />
          ))}
        </Box>
      ) : (
        <DropsEmptyState data={data} loading={loading} />
      )}
    </>
  )
}

/** ---- 2. ALSO LOOTED BY YOU (corroboration the page doesn't list) ---- */
function AlsoLootedSection({
  extraSeen,
  onOpenItem
}: {
  extraSeen: MobSeenDrop[]
  onOpenItem: (item: string) => void
}): JSX.Element | null {
  if (extraSeen.length === 0) return null
  return (
    <>
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="subtitle2" gutterBottom>
        Also looted by you{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          (not listed on the wiki page)
        </Typography>
      </Typography>
      <Box sx={{ mb: 2 }}>
        {extraSeen.map((d) => (
          <DropRow key={d.item} item={d.item} seen={d} onOpenItem={onOpenItem} />
        ))}
      </Box>
    </>
  )
}

/** ---- 3. QUESTS ---- */
function QuestsSection({ quests }: { quests: MobQuestUse[] }): JSX.Element {
  return (
    <>
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="subtitle2" gutterBottom>
        Quests that name it
      </Typography>
      {quests.length > 0 ? (
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
          {quests.map((q) => (
            <Chip
              key={q.quest}
              size="small"
              variant="outlined"
              color="success"
              label={q.zone ? `${q.quest} · ${q.zone}` : q.quest}
              sx={{ height: 22 }}
            />
          ))}
        </Stack>
      ) : (
        <Quiet>No quest in the local catalog names this mob.</Quiet>
      )}
    </>
  )
}

/** ---- 4. KILLS ---- */
function KillsSection({ kill }: { kill?: MobKillFacts }): JSX.Element {
  return (
    <>
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="subtitle2" gutterBottom>
        Your kills
      </Typography>
      {kill && kill.count > 0 ? (
        <Typography variant="caption" color="text.secondary">
          {kill.count} kill{kill.count === 1 ? '' : 's'} · first {formatDateTime(kill.firstTs)} · last{' '}
          {formatDateTime(kill.lastTs)}
        </Typography>
      ) : (
        <Quiet>Nothing recorded yet for this character.</Quiet>
      )}
    </>
  )
}

/** Attribution for whatever the wiki contributed, when it contributed anything. */
function WikiSourceLine({ wikiUrl }: { wikiUrl?: string }): JSX.Element | null {
  if (!wikiUrl) return null
  return (
    <Typography variant="caption" color="text.disabled" display="block" sx={{ mt: 2 }}>
      Source:{' '}
      <a href={wikiUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
        eqlwiki.com
      </a>
    </Typography>
  )
}

/** The mob page. `target` carries everything the calling surface already knew. */
export function MobPage({ target }: { target: MobTarget }): JSX.Element {
  const { mob, seed, entry, con, kill } = target
  const { data, loading } = useMobKnowledge(mob, seed, entry)
  const [drillItem, setDrillItem] = useState<string | null>(null)

  const wiki = data?.dropsWiki ?? []
  const seen = data?.dropsSeen ?? []
  const quests = data?.quests ?? []
  const seenByKey = new Map(seen.map((d) => [d.item.toLowerCase(), d]))
  // Observed items the wiki page does NOT list. Kept separate and second: it is evidence, not
  // the drop table, and silently merging it would let one lucky drop read as documented loot.
  const wikiKeys = new Set(wiki.map((d) => d.item.toLowerCase()))
  const extraSeen = seen.filter((d) => !wikiKeys.has(d.item.toLowerCase()))
  const wikiUrl = wikiPageUrl(data?.page)

  return (
    <>
      <MobIdentity mob={mob} con={con} kill={kill} />
      <MobConsiderLine con={con} />
      <MobStats
        wikiCount={wiki.length}
        seenCount={seen.length}
        page={data?.page}
        con={con}
        kill={kill}
      />
      <WikiLevelZone zone={data?.zone} levelText={data?.levelText} />
      <DropsSection
        wiki={wiki}
        seenByKey={seenByKey}
        data={data}
        loading={loading}
        onOpenItem={setDrillItem}
      />
      <AlsoLootedSection extraSeen={extraSeen} onOpenItem={setDrillItem} />
      <QuestsSection quests={quests} />
      <KillsSection kill={kill} />
      <WikiSourceLine wikiUrl={wikiUrl} />

      {/* One hop deep: the item's own dialog. Mounted only on demand (see ItemDrillDown). */}
      {drillItem && <ItemDrillDown item={drillItem} onClose={() => setDrillItem(null)} />}
    </>
  )
}
