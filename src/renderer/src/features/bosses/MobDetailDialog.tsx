// MobDetailDialog (Task #63) — the CLICK layer for a mob, the sibling of loot's
// ItemDetailDialog. Same visual language (a wide MUI dialog: title row with the identity + its
// badges, stat cards, then sourced sections), same role in the interaction model that runs
// through this app: HOVER EXPLAINS, CLICK INVESTIGATES.
//
// WHAT IT ANSWERS, in the order the answers matter:
//   1. DROPS — the wiki's list, which is the DEFINITIVE statement of what this mob can drop.
//      It leads. Each row is annotated with what YOU have actually pulled off it
//      ("seen by you: 3× · last Aug 1"), because corroboration belongs beside the claim.
//   2. ALSO LOOTED BY YOU — anything your own history has that the page doesn't list. Secondary
//      by construction: it is evidence about one mob on one server, not the drop table.
//   3. QUESTS that name this mob, from the local catalog.
//   4. KILLS — what the kills module knows, when the caller has it.
//
// HONESTY (law 1) — every section states which of those three things happened: a source said
// something, a source said nothing, or we could not ask. "No wiki page for this mob" and "the
// page lists no loot" are DIFFERENT facts and are never collapsed into "no drops".
//
// ITEM NAMES ARE LIVE. Every one is a KnownItemTooltip anchor (hover = the EQ-style item window
// plus what it's for) AND clicks through to the loot tab's ItemDetailDialog. That second dialog
// needs the item's own loot history, so the loot module is subscribed inside a component that
// mounts only once an item is actually clicked — a mob card costs zero loot subscriptions until
// you drill into one of its drops.

import { useEffect, useState } from 'react'
import {
  Box,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import type { KillInfo, LootDelta, LootSnap, MobKnowledge, MobSeenDrop } from '@shared/types'
import type { ConsiderFaction } from '@shared/logEvents'
import { CONSIDER_FACTION_COLOR, CONSIDER_FACTION_LABEL, considerDifficultyShort } from '@shared/logEvents'
import { wikiPageUrl } from '@shared/wiki'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { itemCountKey } from '../../lib/itemName'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { useModule } from '../../lib/useModule'
import { getPoskyData } from '../../data'
import { ItemDetailDialog } from '../loot/ItemDetailDialog'
import { tierStyle } from '../../lib/tierChip'

// The Plane of Sky dataset, reused exactly as LootView reads it, so an item drilled into from a
// mob card gets the same "Plane of Sky" badge and offline stat blob it gets from the loot table.
const posky = getPoskyData()
const questItemNames = new Set<string>(posky.quests.flatMap((q) => q.items.map((i) => itemCountKey(i.name))))
const itemStats: Record<string, string> = {}
for (const q of posky.quests) {
  for (const it of q.items) if (it.stats) itemStats[itemCountKey(it.name)] = it.stats
  if (q.reward && q.rewardStats) itemStats[itemCountKey(q.reward)] = q.rewardStats
}

/** The consider facts the caller already has from the log line (absent for a raid-roster card). */
export interface MobConsiderContext {
  faction: ConsiderFaction
  level?: number
  rare: boolean
  /** VERBATIM difficulty clause */
  difficulty: string
  /** how many times we've conned it this session */
  cons?: number
  /** the zone we were in at the time */
  zone?: string
}

/**
 * Fetch the mob's knowledge when the dialog opens. `seed` is whatever the consider module
 * already attached to the row, so the dialog paints instantly and then refreshes — main's
 * lookup is cache-first and local-first, so the refresh is usually free.
 */
function useMobKnowledge(mob: string, open: boolean, seed?: MobKnowledge): {
  data: MobKnowledge | null
  loading: boolean
} {
  const [data, setData] = useState<MobKnowledge | null>(seed ?? null)
  const [loading, setLoading] = useState(!seed)
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    void window.eq
      .lookupMob(mob)
      .then((k) => {
        if (alive) setData(k)
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
  }, [mob, open])
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

/**
 * ONE drop row: the item name (hoverable + clickable), whatever the page said about how often
 * it drops, and — when your own history corroborates it — how many you've had and when.
 */
function DropRow({
  item,
  rarity,
  seen,
  onOpenItem
}: {
  item: string
  rarity?: string
  seen?: MobSeenDrop
  onOpenItem: (item: string) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="baseline" sx={{ py: 0.2, minWidth: 0 }}>
      <KnownItemTooltip name={item}>
        <Box
          component="span"
          role="button"
          tabIndex={0}
          onClick={() => onOpenItem(item)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onOpenItem(item)
          }}
          sx={{
            color: 'text.primary',
            cursor: 'pointer',
            textDecoration: 'underline dotted',
            textUnderlineOffset: 2,
            '&:hover': { color: 'primary.main' }
          }}
        >
          {item}
        </Box>
      </KnownItemTooltip>
      {rarity && (
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          {rarity}
        </Typography>
      )}
      <Box sx={{ flexGrow: 1 }} />
      {seen && (
        <Typography variant="caption" sx={{ color: 'success.main', flexShrink: 0 }}>
          seen by you: {seen.count}× · last {formatDate(seen.lastTs)}
        </Typography>
      )}
    </Stack>
  )
}

/**
 * The nested item drill-down. Mounted ONLY once an item name is clicked, which is what keeps
 * the mob dialog free of the loot module's full history until it is actually needed.
 */
function ItemDrillDown({ item, onClose }: { item: string; onClose: () => void }): JSX.Element {
  const history = useModule<LootSnap, LootDelta>('loot', (s, d) => [...s, ...d.appended])
  const key = itemCountKey(item)
  return (
    <ItemDetailDialog
      open
      onClose={onClose}
      item={item}
      events={(history ?? []).filter((e) => e.item.toLowerCase() === item.toLowerCase())}
      stats={itemStats[key]}
      isQuestItem={questItemNames.has(key)}
    />
  )
}

export function MobDetailDialog({
  open,
  onClose,
  mob,
  seed,
  con,
  kill
}: {
  open: boolean
  onClose: () => void
  /** RAW display name as the log printed it */
  mob: string
  /** knowledge the caller already holds (the consider row's enrichment) */
  seed?: MobKnowledge
  /** the consider facts, when this was opened from a considered mob */
  con?: MobConsiderContext
  /** what the kills module knows about this mob, when the caller has it */
  kill?: Pick<KillInfo, 'count' | 'bestTier' | 'firstTs' | 'lastTs'>
}): JSX.Element {
  const { data, loading } = useMobKnowledge(mob, open, seed)
  const [drillItem, setDrillItem] = useState<string | null>(null)

  const wiki = data?.dropsWiki ?? []
  const seen = data?.dropsSeen ?? []
  const quests = data?.quests ?? []
  const seenByKey = new Map(seen.map((d) => [d.item.toLowerCase(), d]))
  // Observed items the wiki page does NOT list. Kept separate and second: it is evidence, not
  // the drop table, and silently merging it would let one lucky drop read as documented loot.
  const wikiKeys = new Set(wiki.map((d) => d.item.toLowerCase()))
  const extraSeen = seen.filter((d) => !wikiKeys.has(d.item.toLowerCase()))
  const factionColor = con ? CONSIDER_FACTION_COLOR[con.faction] : undefined
  const wikiUrl = wikiPageUrl(data?.page)
  const tier = kill && kill.count > 0 ? tierStyle(kill.bestTier) : null

  return (
    <>
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
        <DialogTitle sx={{ pr: 6 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Box component="span" sx={{ color: factionColor ?? 'text.primary' }}>
              {mob}
            </Box>
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
          {/* The consider sentence, verbatim — the thing the game actually told you. */}
          {con && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
              {considerDifficultyShort(con.difficulty) ?? con.difficulty}
              {con.difficulty && ` — “${con.difficulty}”`}
              {con.zone && ` · ${con.zone}`}
            </Typography>
          )}
          <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>

        <DialogContent dividers>
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            <StatCard
              label="Known drops"
              value={String(wiki.length)}
              hint={data?.page ? 'from the wiki page' : undefined}
            />
            <StatCard label="Looted by you" value={String(seen.length)} hint="distinct items" />
            <StatCard
              label="Kills"
              value={String(kill?.count ?? 0)}
              hint={kill?.lastTs ? `last ${formatDate(kill.lastTs)}` : undefined}
            />
            {con?.cons != null && <StatCard label="Considered" value={`${con.cons}×`} />}
          </Stack>

          {/* Level/zone as the WIKI states them — a range as often as a number. */}
          {(data?.levelText || data?.zone) && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
              {data.zone}
              {data.zone && data.levelText && ' · '}
              {data.levelText && `level ${data.levelText}`}
            </Typography>
          )}

          {/* ---- 1. DROPS (definitive) ---- */}
          <Typography variant="subtitle2" gutterBottom>
            Drops{' '}
            <Typography component="span" variant="caption" color="text.secondary">
              (wiki drop table)
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
                  onOpenItem={setDrillItem}
                />
              ))}
            </Box>
          ) : (
            <Box sx={{ mb: 2 }}>
              {loading && !data && (
                <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
                  <CircularProgress size={14} />
                  <Typography variant="caption">Looking up this mob…</Typography>
                </Stack>
              )}
              {/* Three DIFFERENT facts, never collapsed into one. */}
              {data?.notFound && <Quiet>No wiki page for this mob.</Quiet>}
              {data?.offline && <Quiet>Offline — showing only what&apos;s known locally.</Quiet>}
              {data && !data.notFound && !data.offline && data.page && (
                <Quiet>The wiki page for this mob lists no loot.</Quiet>
              )}
            </Box>
          )}

          {/* ---- 2. ALSO LOOTED BY YOU (corroboration the page doesn't list) ---- */}
          {extraSeen.length > 0 && (
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
                  <DropRow key={d.item} item={d.item} seen={d} onOpenItem={setDrillItem} />
                ))}
              </Box>
            </>
          )}

          {/* ---- 3. QUESTS ---- */}
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

          {/* ---- 4. KILLS ---- */}
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

          {wikiUrl && (
            <Typography variant="caption" color="text.disabled" display="block" sx={{ mt: 2 }}>
              Source:{' '}
              <a href={wikiUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                eqlwiki.com
              </a>
            </Typography>
          )}
        </DialogContent>
      </Dialog>

      {/* One hop deep: the item's own dialog. Mounted only on demand (see ItemDrillDown). */}
      {drillItem && <ItemDrillDown item={drillItem} onClose={() => setDrillItem(null)} />}
    </>
  )
}
