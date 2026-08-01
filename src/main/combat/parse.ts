// Parses EverQuest Legends combat log lines into typed events. Covers melee
// (with crit/riposte/special modifiers), typed spell nukes, DoTs, damage shields,
// and the charm/zone/death lifecycle. See engine.ts for how these drive the state
// machine.

import type { DamageType } from '../../shared/combat'

export interface DamageEvent {
  t: 'dmg'
  ts: number
  attacker: string
  target: string
  amount: number
  dtype: DamageType
  dclass?: string
  skill: string
  crit: boolean
  modifier?: string
}
export interface LifecycleEvent {
  t: 'charm' | 'uncharm' | 'death' | 'zone'
  value: string
}
export type CombatEvent = DamageEvent | LifecycleEvent | null

const MELEE_VERBS =
  'hits?|slashes?|pierces?|crushes?|bashes?|kicks?|bites?|claws?|gores?|mauls?|punches?|strikes?|slices?|backstabs?|slams?|stings?|rends?|smashes?|gnaws?|lashes?|frenzies on|flurries'

const MELEE_RE = new RegExp(`^(.+?) (?:${MELEE_VERBS}) (.+?) for (\\d+) points? of damage\\.(?: \\((.+?)\\))?$`)
const MELEE_VERB_RE = new RegExp(` (${MELEE_VERBS}) `)
const SPELL_RE = /^(.+?) (?:hits?) (.+?) for (\d+) points of ([\w-]+) damage by (.+?)\.(?: \((.+?)\))?$/
const DS_RE = /^(.+?) is \w+ by (YOUR|.+?'s) (.+?) for (\d+) points of non-melee damage\.$/
const DOT_RE = /^(.+?) has taken (\d+) damage from (.+?)\.$/
const CHARM_RE = /^(.+?) has been charmed\.$/
const UNCHARM_RE = /^Your (.+?) spell has worn off of (.+?)\.$/
const SLAIN_BY_RE = /^(.+?) has been slain by .+?!$/
const SLAIN_YOU_RE = /^You have slain (.+?)!$/
const ZONE_RE = /^You have entered (.+?)\.$/
const CHARM_SPELL_RE =
  /charm|beguile|allure|cajole|dictate|besiege|agacerie|enthrall|beckon|command of druzzil|dominate|boltran/i

/** Cheap pre-check so callers can skip non-combat lines before the regex battery. */
export function looksCombat(text: string): boolean {
  return (
    text.includes('points of') ||
    text.includes('has taken') ||
    text.includes('has been charmed') ||
    text.includes('worn off of') ||
    text.includes('has been slain') ||
    text.includes('You have slain') ||
    text.includes('You have entered')
  )
}

/** True if a line looks like damage but we couldn't classify it (for the miss log). */
export function looksDamage(text: string): boolean {
  return /\bfor \d+ points? of|\bhas taken \d+ damage/.test(text)
}

function norm(name: string): string {
  const n = name.trim()
  const l = n.toLowerCase()
  if (l === 'you' || l === 'yourself' || l === 'your') return 'You'
  return n
}

function meleeSkill(verb: string): string {
  const v = verb.toLowerCase()
  if (v.startsWith('backstab')) return 'Backstab'
  if (v.startsWith('bash')) return 'Bash'
  if (v.startsWith('kick')) return 'Kick'
  if (v.startsWith('frenz')) return 'Frenzy'
  if (v.startsWith('flurr')) return 'Flurry'
  return 'Melee'
}

export function parseCombatLine(text: string, ts: number): CombatEvent {
  let m = ZONE_RE.exec(text)
  if (m) return { t: 'zone', value: m[1].trim() }
  m = CHARM_RE.exec(text)
  if (m) return { t: 'charm', value: norm(m[1]) }
  m = UNCHARM_RE.exec(text)
  if (m && CHARM_SPELL_RE.test(m[1])) return { t: 'uncharm', value: norm(m[2]) }
  m = SLAIN_YOU_RE.exec(text)
  if (m) return { t: 'death', value: norm(m[1]) }
  m = SLAIN_BY_RE.exec(text)
  if (m) return { t: 'death', value: norm(m[1]) }

  m = DS_RE.exec(text)
  if (m) {
    const owner = m[2] === 'YOUR' ? 'You' : norm(m[2].replace(/'s$/, ''))
    return {
      t: 'dmg',
      ts,
      attacker: owner,
      target: norm(m[1]),
      amount: Number(m[4]),
      dtype: 'ds',
      skill: m[3].trim(),
      crit: false
    }
  }
  m = SPELL_RE.exec(text)
  if (m) {
    const modifier = m[6]
    return {
      t: 'dmg',
      ts,
      attacker: norm(m[1]),
      target: norm(m[2]),
      amount: Number(m[3]),
      dtype: 'spell',
      dclass: m[4],
      skill: m[5].trim(),
      crit: /critical/i.test(modifier ?? ''),
      modifier
    }
  }
  m = DOT_RE.exec(text)
  if (m) {
    const target = norm(m[1])
    const amount = Number(m[2])
    const rest = m[3]
    let attacker = '?'
    let skill = rest
    if (/^your /i.test(rest)) {
      attacker = 'You'
      skill = rest.replace(/^your /i, '')
    } else {
      const by = / by (.+)$/.exec(rest)
      if (by) {
        attacker = norm(by[1])
        skill = rest.slice(0, by.index)
      }
    }
    if (attacker === '?') return null
    return { t: 'dmg', ts, attacker, target, amount, dtype: 'dot', skill: skill.trim(), crit: false }
  }
  m = MELEE_RE.exec(text)
  if (m) {
    const verbM = MELEE_VERB_RE.exec(text)
    const modifier = m[4]
    return {
      t: 'dmg',
      ts,
      attacker: norm(m[1]),
      target: norm(m[2]),
      amount: Number(m[3]),
      dtype: 'melee',
      skill: meleeSkill(verbM ? verbM[1] : 'hit'),
      crit: /critical/i.test(modifier ?? ''),
      modifier
    }
  }
  return null
}
