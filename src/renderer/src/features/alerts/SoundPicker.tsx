// SoundPicker — the pack→sound picker, and the two pack helpers everything audio-shaped shares.
// Extracted from AlertsView.tsx (Wave D factoring).
//
// IT IS THE EDITOR'S PICKER NOW. The alert LIST used to mount this too (through an `inGrid`
// escape hatch); it mounts AudioPicker.tsx instead, whose first select also offers the two voice
// outputs — that is where the owner asked the sound/voice choice to live. The dialog keeps this
// plain pack+sound pair because the dialog already has the Speech block right below it, which is
// authoritative for the channel, the phrase and the voice: a second control for `audio` six
// inches away would be two ways to say one thing in one form. The `inGrid`/`display: contents`
// mechanism moved WITH the row, to AudioPicker.

import type { JSX } from 'react'
import { MenuItem, Select, Stack } from '@mui/material'
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

/** The pack→sound picker used in the add/edit dialog. */
export default function SoundPicker({
  packs,
  packId,
  soundId,
  onChange
}: {
  packs: SoundPack[]
  packId: string
  soundId: string
  onChange: (packId: string, soundId: string) => void
}): JSX.Element {
  const pack = packs.find((p) => p.id === packId) ?? fallbackPack(packs)
  const soundIds = pack ? Object.keys(pack.sounds) : []
  return (
    <Stack direction="row" spacing={1}>
      <Select
        size="small"
        value={pack?.id ?? ''}
        onChange={(e) => {
          const np = packs.find((p) => p.id === e.target.value)
          const firstSound = np ? Object.keys(np.sounds)[0] : ''
          onChange(e.target.value, firstSound)
        }}
        sx={{ minWidth: 130 }}
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
        sx={{ minWidth: 170 }}
      >
        {soundIds.map((sid) => (
          <MenuItem key={sid} value={sid}>
            {pack?.sounds[sid]?.label ?? sid}
          </MenuItem>
        ))}
      </Select>
    </Stack>
  )
}
