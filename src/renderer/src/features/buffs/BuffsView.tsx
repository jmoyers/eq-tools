import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  Collapse,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography
} from '@mui/material'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import type {
  ActiveBuff,
  BuffClass,
  BuffStat,
  BuffsDelta,
  BuffsSnap,
  MessageOverlay,
  OverlayVerdict
} from '@shared/types'
import { useModule } from '../../lib/useModule'
import {
  fmtDuration,
  remainingFraction,
  isOverdue,
  classAccent,
  groupKey,
  groupLabel
} from './format'

// Stats-table sections: buffs first, then debuffs (Task #35 — a spell property).
const CLASS_ORDER: BuffClass[] = ['buff', 'debuff']
const CLASS_LABEL: Record<BuffClass, string> = { buff: 'Buffs', debuff: 'Debuffs' }

// Stable empty reference so hooks don't churn before hydration.
const EMPTY_BUFFS: BuffsSnap = { active: [], stats: {} }

// The buffs module ships its whole (small) snapshot each flush, so the delta simply
// replaces state — no incremental merge needed.
const applyBuffsDelta = (_state: BuffsSnap, delta: BuffsDelta): BuffsSnap => delta

/** One active-buff row: name, elapsed, estimated remaining bar, ± spread, n. */
function ActiveRow({ buff, now }: { buff: ActiveBuff; now: number }): JSX.Element {
  const elapsed = Math.max(0, now - buff.startedTs)
  const hasEst = buff.estimatedMs != null && buff.estimatedMs > 0
  const remaining = hasEst ? Math.max(0, (buff.estimatedMs as number) - elapsed) : null
  const frac = hasEst ? remainingFraction(elapsed, buff.estimatedMs as number) : null
  // ± spread from the p25/p75 IQR around the estimate.
  const spread =
    buff.p25 != null && buff.p75 != null ? (buff.p75 - buff.p25) / 2 : null
  // Overdue (Task #30 + #34): run past the estimated window → show "past estimate" instead
  // of a bottomed-out countdown. For mined estimates this needs n≥2 past p75; for a DB
  // (authoritative) estimate, being past the DB duration itself is enough (expiry is now
  // message-driven, so a DB buff sits "past estimate" until its wear-off line lands).
  const overdue =
    isOverdue(elapsed, buff.p75, buff.n) ||
    (buff.durationSource === 'db' && buff.estimatedMs != null && elapsed > buff.estimatedMs)
  // Provisional (Task #30): shown optimistically the instant we saw the cast begin,
  // before the land timeout confirms it. Dim the row + show a "casting…" hint.
  const provisional = buff.provisional === true

  // Debuff target is INFERRED (castBegin carries no target) — surface it honestly as a
  // "target: inferred" chip, never a silent guess (Task #32 rule 5c).
  const inferred = buff.inferredTarget === true

  // Permanent illusion (Task #34): a self-cast illusion buff while the Permanent Illusion
  // AA is owned lasts forever — no countdown, an explicit "permanent · illusion AA" state.
  const permanent = buff.permanent === true
  // Estimate provenance (Task #34): 'db' (authoritative wiki duration) vs 'observed'
  // (recency-weighted max of mined samples). Shown as a small chip on the bar caption.
  const source = buff.durationSource

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        opacity: provisional ? 0.6 : 1,
        borderStyle: provisional ? 'dashed' : 'solid',
        // Class accent: red-ish left border for debuffs, green for pet, gold for self.
        borderLeft: '3px solid',
        borderLeftColor: classAccent(buff.cls)
      }}
    >
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {buff.spell}
        </Typography>
        {inferred ? (
          <Tooltip title="Target inferred from the pet's current fight target — castBegin carries no target, so this is a best guess, not a confirmed target.">
            <Chip
              size="small"
              label={buff.target ? `target: ${buff.target} (inferred)` : 'target: inferred'}
              variant="outlined"
              color="warning"
              sx={{ height: 18, fontSize: 11, maxWidth: 180, '& .MuiChip-label': { px: 0.75 } }}
            />
          </Tooltip>
        ) : null}
        {provisional && (
          <Chip
            size="small"
            label="casting…"
            variant="outlined"
            color="info"
            sx={{ height: 18, fontSize: 11 }}
          />
        )}
        {buff.messageDriven && !provisional && (
          <Tooltip title="Confirmed by an exact chat message (its landing/heal line), not inferred from cast timing.">
            <Chip
              size="small"
              label="message"
              variant="outlined"
              color="success"
              sx={{ height: 18, fontSize: 11 }}
            />
          </Tooltip>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {fmtDuration(elapsed)} elapsed
        </Typography>
      </Stack>

      {permanent ? (
        // Permanent illusion (Task #34): a full, steady bar and an explicit label — no
        // countdown, because a self-cast illusion under the Permanent Illusion AA never fades.
        <>
          <LinearProgress
            variant="determinate"
            value={100}
            sx={{ height: 8, borderRadius: 1, '& .MuiLinearProgress-bar': { bgcolor: 'warning.main' } }}
          />
          <Typography variant="caption" color="warning.main">
            permanent · illusion AA
          </Typography>
        </>
      ) : hasEst ? (
        <>
          <LinearProgress
            variant="determinate"
            value={(frac as number) * 100}
            sx={{
              height: 8,
              borderRadius: 1,
              // Fade toward warning as the estimated window empties / runs overdue.
              '& .MuiLinearProgress-bar': {
                bgcolor: overdue || (frac as number) < 0.2 ? 'warning.main' : 'primary.main'
              }
            }}
          />
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="caption" color={overdue ? 'warning.main' : 'text.secondary'}>
              {overdue
                ? 'past estimate · awaiting wear-off'
                : `~${fmtDuration(remaining as number)} left`}
              {!overdue && spread != null && spread > 1000 ? ` (± ${fmtDuration(spread)})` : ''}
            </Typography>
            <Stack direction="row" spacing={0.5} alignItems="center">
              {/* Estimate provenance (Task #34): authoritative DB duration vs mined max. */}
              {source && (
                <Tooltip
                  title={
                    source === 'db'
                      ? 'Duration from the spell database (authoritative wiki value).'
                      : 'Duration estimated from observed casts (recency-weighted max of samples).'
                  }
                >
                  <Chip
                    size="small"
                    label={source === 'db' ? 'db' : 'observed'}
                    variant="outlined"
                    sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
                  />
                </Tooltip>
              )}
              <Typography variant="caption" color="text.disabled">
                n={buff.n}
              </Typography>
            </Stack>
          </Stack>
        </>
      ) : (
        <>
          <LinearProgress
            variant="indeterminate"
            sx={{ height: 8, borderRadius: 1, opacity: 0.5 }}
          />
          <Typography variant="caption" color="text.disabled">
            unknown duration (no samples yet)
          </Typography>
        </>
      )}
    </Paper>
  )
}

/** The dense per-spell stats table for ONE class, sorted by sample count. */
function StatsTable({ stats, cls }: { stats: Record<string, BuffStat>; cls: BuffClass }): JSX.Element {
  const rows = useMemo(
    () =>
      Object.values(stats)
        .filter((s) => s.cls === cls)
        .sort((a, b) => b.n - a.n || a.spell.localeCompare(b.spell)),
    [stats, cls]
  )
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No {CLASS_LABEL[cls].toLowerCase()} durations mined yet.
      </Typography>
    )
  }
  return (
    <Table size="small" sx={{ '& td, & th': { py: 0.5 } }}>
      <TableHead>
        <TableRow>
          <TableCell>Spell</TableCell>
          <TableCell align="right">estimate</TableCell>
          <TableCell align="right">n</TableCell>
          <TableCell align="right">median</TableCell>
          <TableCell align="right">IQR (p25–p75)</TableCell>
          <TableCell align="right">min–max</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((s) => {
          // The estimate the app uses (Task #34): DB duration when known ("db"), else the
          // recency-weighted max of samples ("observed"). Falls back to median for older
          // deltas without the field.
          const estMs = s.estimateMs ?? s.dbDurationMs ?? s.medianMs
          const estSrc = s.estimatorSource ?? (s.dbDurationMs != null ? 'db' : s.medianMs != null ? 'observed' : undefined)
          return (
            <TableRow key={s.spell} hover>
              <TableCell>{s.spell}</TableCell>
              <TableCell align="right">
                {estMs != null ? (
                  <Tooltip
                    title={
                      estSrc === 'db'
                        ? 'Authoritative duration from the spell database.'
                        : 'Recency-weighted max of observed casts.'
                    }
                  >
                    <span>
                      {fmtDuration(estMs)}
                      {estSrc ? (
                        <Chip
                          size="small"
                          label={estSrc === 'db' ? 'db' : 'obs'}
                          variant="outlined"
                          sx={{ ml: 0.5, height: 15, fontSize: 9, '& .MuiChip-label': { px: 0.4 } }}
                        />
                      ) : null}
                    </span>
                  </Tooltip>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell align="right">
                {s.n === 0 ? (
                  <Tooltip title="Seen fading but no clean cast→fade pair yet">
                    <span style={{ opacity: 0.5 }}>0</span>
                  </Tooltip>
                ) : (
                  s.n
                )}
              </TableCell>
              <TableCell align="right">{fmtDuration(s.medianMs)}</TableCell>
              <TableCell align="right" style={{ opacity: 0.8 }}>
                {s.p25 != null && s.p75 != null ? `${fmtDuration(s.p25)} – ${fmtDuration(s.p75)}` : '—'}
              </TableCell>
              <TableCell align="right" style={{ opacity: 0.65 }}>
                {s.minMs != null && s.maxMs != null ? `${fmtDuration(s.minMs)} – ${fmtDuration(s.maxMs)}` : '—'}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

// Verdict → chip color + label for the overlay audit table (Task #36).
const VERDICT_COLOR: Record<OverlayVerdict, 'success' | 'info' | 'error' | 'default'> = {
  verified: 'success',
  shared: 'info',
  'contradicts-wiki': 'error',
  unknown: 'default'
}
const VERDICT_LABEL: Record<OverlayVerdict, string> = {
  verified: 'verified',
  shared: 'shared',
  'contradicts-wiki': 'contradicts wiki',
  unknown: 'unknown'
}

/**
 * The observed-message overlay diagnostics (Task #36) — a dense, read-only, collapsible
 * audit of what the app LEARNED about the game's cast messages by mining the log: which
 * messages VERIFY a single spell, which are SHARED/GENERIC (can't name a spell — e.g. "You
 * feel different." for every illusion), and which CONTRADICT the wiki (its msg_* field is
 * wrong — e.g. Symbol of Pinzarn). This is the auditability the user asked for: a future
 * agent (or the user) can see the effective DB = spells.json + overlay, overlay wins.
 */
function OverlayDiagnostics({ overlay }: { overlay: MessageOverlay }): JSX.Element {
  const [open, setOpen] = useState(false)
  const { stats } = overlay
  // Show the actionable rows first: contradictions, then verified, then shared. Skip the
  // low-signal UNKNOWN bulk. Cap so the table stays dense/scannable.
  const rows = useMemo(
    () => overlay.messages.filter((m) => m.verdict !== 'unknown').slice(0, 200),
    [overlay.messages]
  )
  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ cursor: 'pointer' }}
        onClick={() => setOpen((v) => !v)}
      >
        <Typography variant="subtitle2">Message overlay (learned)</Typography>
        <Chip
          size="small"
          variant="outlined"
          color="success"
          label={`${stats.verified} verified`}
          sx={{ height: 18, fontSize: 11 }}
        />
        <Chip
          size="small"
          variant="outlined"
          color="info"
          label={`${stats.shared} shared`}
          sx={{ height: 18, fontSize: 11 }}
        />
        <Chip
          size="small"
          variant="outlined"
          color="error"
          label={`${stats.contradictions} contradict wiki`}
          sx={{ height: 18, fontSize: 11 }}
        />
        <Box sx={{ flexGrow: 1 }} />
        <IconButton size="small">{open ? <ExpandLessIcon /> : <ExpandMoreIcon />}</IconButton>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        What we learned by mining the log about the messages each spell prints — augmenting the
        wiki spell database ("effective DB = spells.json + overlay, overlay wins"). A{' '}
        <b>shared</b> message can't identify a spell on its own (resolve via cast history); a{' '}
        <b>contradicts wiki</b> row means the wiki's cast message for that spell is wrong.
      </Typography>
      <Collapse in={open} unmountOnExit>
        <Paper variant="outlined" sx={{ mt: 1, p: 1, maxHeight: 380, overflow: 'auto' }}>
          <Table size="small" sx={{ '& td, & th': { py: 0.4, fontSize: 12 } }}>
            <TableHead>
              <TableRow>
                <TableCell>Message</TableCell>
                <TableCell>role</TableCell>
                <TableCell>verdict</TableCell>
                <TableCell align="right">n</TableCell>
                <TableCell>spell(s) · count</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={`${m.role}:${m.text}`} hover>
                  <TableCell sx={{ fontFamily: 'monospace', maxWidth: 320 }}>{m.text}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{m.role}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={VERDICT_COLOR[m.verdict]}
                      label={VERDICT_LABEL[m.verdict]}
                      sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
                    />
                  </TableCell>
                  <TableCell align="right">{m.total}</TableCell>
                  <TableCell sx={{ color: 'text.secondary', maxWidth: 340 }}>
                    {m.verdict === 'contradicts-wiki' && m.wikiConflict ? (
                      <Tooltip title={`wiki claims: "${m.wikiConflict.wikiText}"`}>
                        <span>
                          {m.spells.map((s) => `${s.spell}:${s.count}`).join(', ')}{' '}
                          <span style={{ opacity: 0.6 }}>(wiki ≠ observed)</span>
                        </span>
                      </Tooltip>
                    ) : (
                      m.spells
                        .slice(0, 8)
                        .map((s) => `${s.spell}:${s.count}`)
                        .join(', ') + (m.spells.length > 8 ? ' …' : '')
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      </Collapse>
    </Box>
  )
}

export default function BuffsView(): JSX.Element {
  const snap = useModule<BuffsSnap, BuffsDelta>('buffs', applyBuffsDelta) ?? EMPTY_BUFFS
  // Tick once a second so active-buff elapsed/remaining stay live between deltas.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const active = snap.active
  const minedCount = Object.values(snap.stats).filter((s) => s.n > 0).length

  // PRIORITY layout (Task #35): "Your buffs" (self) FIRST, then one group per bound entity
  // sorted by liveliness/recency (most-recently-refreshed entity first — the current pet
  // naturally tops this). Buff vs debuff is a per-row style (classAccent), not a group.
  const activeGroups = useMemo(() => {
    const byKey = new Map<string, ActiveBuff[]>()
    for (const b of active) {
      const k = groupKey(b)
      const list = byKey.get(k)
      if (list) list.push(b)
      else byKey.set(k, [b])
    }
    const recency = (list: ActiveBuff[]): number => Math.max(...list.map((b) => b.startedTs))
    return [...byKey.entries()]
      .sort((a, b) => {
        if (a[0] === 'self') return -1 // self always first
        if (b[0] === 'self') return 1
        return recency(b[1]) - recency(a[1]) // then most-recent entity first
      })
      .map(([key, list]) => ({
        key,
        buffs: [...list].sort((x, y) => x.startedTs - y.startedTs)
      }))
  }, [active])
  // Which classes have any mined stats — to decide whether to render each table.
  const statsClasses = useMemo(() => {
    const present = new Set<BuffClass>()
    for (const s of Object.values(snap.stats)) present.add(s.cls)
    return CLASS_ORDER.filter((c) => present.has(c))
  }, [snap.stats])

  return (
    <Stack spacing={2}>
      <Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          <AutoFixHighIcon color="primary" />
          <Typography variant="h6">Buffs</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={`${active.length} active · ${minedCount} mined`}
          />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Each active buff is an INSTANCE bound to WHO it's on: your own buffs show first ("Your
          buffs"), then a group per entity — your pet naturally tops that list — so the same spell can
          run on you AND your pet at once. Applies are recognized from the exact chat MESSAGE each spell
          prints (so Quick Buff bursts, which show no "You begin casting" line, still register — look for
          the "message" chip), and durations come from the spell database ("db") when known, else the
          recency-weighted max of observed casts ("observed"). Detrimental spells (debuffs like slows,
          cast on hostile mobs) are styled with a red accent wherever they appear. Expiry favors the
          spell's own wear-off message; a buff past its estimate sits "past estimate · awaiting wear-off"
          rather than vanishing. Self-cast illusions under the Permanent Illusion AA are marked permanent.
          Ranks are merged; fades that can never be observed (a pet/mob left behind on a zone, a death, or
          a ≥30-min logout gap) are censored, and a buff run far past its window auto-retires.
        </Typography>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Active
        </Typography>
        {active.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No active buffs tracked. A buff appears here once you cast it and it has been observed
            wearing off before (the fade is how the app knows a spell is a buff/debuff).
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {activeGroups.map((g) => (
              <Box key={g.key}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    {groupLabel(g.key)}
                  </Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={g.buffs.length}
                    sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
                  />
                </Stack>
                <Box
                  sx={{
                    display: 'grid',
                    gap: 1,
                    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))'
                  }}
                >
                  {g.buffs.map((b) => (
                    <ActiveRow key={`${b.spell}@${b.self ? 'self' : b.target ?? '?'}`} buff={b} now={now} />
                  ))}
                </Box>
              </Box>
            ))}
          </Stack>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Mined durations
        </Typography>
        {statsClasses.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No buff durations mined yet. Cast a buff on yourself or your pet and let it wear off — the
            duration model learns from each land→fade pair.
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {statsClasses.map((c) => (
              <Box key={c}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                  <Box
                    sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: classAccent(c) }}
                  />
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    {CLASS_LABEL[c]}
                  </Typography>
                </Stack>
                <Paper
                  variant="outlined"
                  sx={{ p: 1, borderLeft: '3px solid', borderLeftColor: classAccent(c) }}
                >
                  <StatsTable stats={snap.stats} cls={c} />
                </Paper>
              </Box>
            ))}
          </Stack>
        )}
      </Box>

      {snap.overlay && snap.overlay.messages.length > 0 ? (
        <OverlayDiagnostics overlay={snap.overlay} />
      ) : null}

      <Typography variant="caption" color="text.secondary">
        Tip: you can wire a sound to any buff wearing off on the Alerts tab with an event trigger like{' '}
        <code>{`{ type: 'event', kind: 'buffFade', where: { spell: 'Clarity' } }`}</code> — handy for
        re-casting long class buffs the moment they drop.
      </Typography>
    </Stack>
  )
}
