// SoundPicker — the pack→sound picker used inline per-alert (AlertList) and in the
// add/edit dialog (AlertDialog). Extracted from AlertsView.tsx (Wave D factoring).

import type { JSX } from 'react'
import { Box, MenuItem, Select, Stack } from '@mui/material'
import type { SoundPack } from '@shared/types'
import { DEFAULT_PACK_ID } from './suggestions'

/**
 * The pack a picker falls back to when the alert's own pack is missing (uninstalled) or
 * a brand-new alert has no pack yet: the SHIPPED default (Alan Rickman), never
 * "whatever happens to sort first". Only if that pack somehow isn't installed do we
 * take the first available one.
 */
export function fallbackPack(packs: SoundPack[]): SoundPack | undefined {
  return packs.find((p) => p.id === DEFAULT_PACK_ID) ?? packs[0]
}

/** First selectable soundId in a pack ('' when packs haven't loaded yet). */
export function firstSoundId(pack: SoundPack | undefined): string {
  return pack ? Object.keys(pack.sounds)[0] ?? '' : ''
}

/**
 * The pack→sound picker used inline per-alert and in the add/edit dialog.
 *
 * `inGrid` is a LAYOUT-only escape hatch for the alert list. There the picker's two
 * Selects must be columns of the ROW's shared grid template (see the grid comment in
 * AlertList) — a self-sized `Stack` here would size to whichever pack/line names
 * happen to be selected, and every row would land its selects at a different x. With
 * `inGrid` the wrapper is `display: contents`, so the two Selects become grid items of
 * the caller's grid and take their width from the shared template instead of from
 * their own text; each one ellipsizes its displayed value rather than growing.
 * Behavior, props and callbacks are otherwise identical in both modes.
 */
export default function SoundPicker({
  packs,
  packId,
  soundId,
  onChange,
  inGrid = false
}: {
  packs: SoundPack[]
  packId: string
  soundId: string
  onChange: (packId: string, soundId: string) => void
  inGrid?: boolean
}): JSX.Element {
  const pack = packs.find((p) => p.id === packId) ?? fallbackPack(packs)
  const soundIds = pack ? Object.keys(pack.sounds) : []
  // A grid item must be allowed to shrink below its content (minWidth: 0) for the
  // Select's own text-overflow to ever kick in.
  const gridSx = {
    minWidth: 0,
    width: '100%',
    '& .MuiSelect-select': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
  }
  const packSx = inGrid ? { gridArea: 'voice', ...gridSx } : { minWidth: 130 }
  const soundSx = inGrid ? { gridArea: 'line', ...gridSx } : { minWidth: 170 }
  const selects = (
    <>
      <Select
        size="small"
        value={pack?.id ?? ''}
        onChange={(e) => {
          const np = packs.find((p) => p.id === e.target.value)
          const firstSound = np ? Object.keys(np.sounds)[0] : ''
          onChange(e.target.value, firstSound)
        }}
        sx={packSx}
      >
        {packs.map((p) => (
          <MenuItem key={p.id} value={p.id}>
            {p.name}
            {p.source === 'user' ? ' (user)' : ''}
          </MenuItem>
        ))}
      </Select>
      <Select
        size="small"
        value={pack?.sounds[soundId] ? soundId : soundIds[0] ?? ''}
        onChange={(e) => onChange(pack?.id ?? packId, e.target.value)}
        sx={soundSx}
      >
        {soundIds.map((sid) => (
          <MenuItem key={sid} value={sid}>
            {pack?.sounds[sid]?.label ?? sid}
          </MenuItem>
        ))}
      </Select>
    </>
  )
  if (inGrid) return <Box sx={{ display: 'contents' }}>{selects}</Box>
  return (
    <Stack direction="row" spacing={1}>
      {selects}
    </Stack>
  )
}
