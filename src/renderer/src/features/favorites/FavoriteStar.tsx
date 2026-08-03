import type { JSX } from 'react'
import { IconButton, Tooltip } from '@mui/material'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'

export function FavoriteStar({
  name,
  favorited,
  onToggle
}: {
  name: string
  favorited: boolean
  onToggle: (name: string) => void
}): JSX.Element {
  return (
    <Tooltip title={favorited ? 'Unfavorite' : 'Favorite — pins quests with this item to the top'}>
      <IconButton
        size="small"
        onClick={(e) => {
          e.stopPropagation()
          onToggle(name)
        }}
        sx={{ color: favorited ? 'warning.main' : 'text.disabled', p: 0.25 }}
      >
        {favorited ? <StarIcon fontSize="inherit" /> : <StarBorderIcon fontSize="inherit" />}
      </IconButton>
    </Tooltip>
  )
}
