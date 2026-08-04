// Voice alerts — SPELL CONTEXT on the firing payload (docs/plans/voice-alerts.md §1).
//
// A spoken alert can say the spell that set it off, which means the FIRING has to carry it:
// the renderer receives `FiredAlert`, and re-deriving the spell renderer-side would mean a
// second parser for lines main has already parsed. This suite pins the resulting contract,
// because it is the exact shape the renderer wave is written against:
//
//   FiredAlert.spell?: string   — the triggering spell's DISPLAY name, rank suffix INTACT
//                                 ("Mesmerization III"), or ABSENT when the family names none.
//
// Two halves. (A) drives the REAL AlertsModule with real log lines run through the REAL parser,
// so the field names come from the parser rather than from this test's imagination. (B) walks
// the families with synthetic events, including the three that spell it something other than
// `spell` and the ones that must stay silent.
//
// Rank stripping is deliberately NOT tested here: it belongs to the speech resolver
// (tests/speechText.test.mts). The producer's whole job is to hand over what the log said.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { AlertsModule } from '../src/main/modules/alerts'
import type { AlertDef, FiredAlert, LogEventKind } from '../src/shared/types'
import type { LogEvent } from '../src/shared/logEvents'

/** An always-on alert for one event kind, with no cooldown so every line can fire. */
function alertFor(kind: LogEventKind): AlertDef {
  return {
    id: `on-${kind}`,
    name: `On ${kind}`,
    enabled: true,
    trigger: { type: 'event', kind },
    sound: { packId: 'alan-rickman', soundId: 'settled' },
    cooldownMs: 0
  }
}

/**
 * A raw trigger that matches EVERY line — the sweep's instrument, and not merely a convenience:
 * `AlertTrigger`'s `LogEventKind` union is a SUBSET of the parser's `LogEvent['kind']` (the
 * poison families, among others, have no event-trigger spelling yet), so a raw alert is the only
 * way to fire on some of the families below. It also proves the useful half of that: spell
 * context is attached from the EVENT, so a raw-triggered alert gets it too.
 */
const CATCH_ALL: AlertDef = {
  id: 'catch-all',
  name: 'Catch all',
  enabled: true,
  trigger: { type: 'raw', regex: '.' },
  sound: { packId: 'alan-rickman', soundId: 'settled' },
  cooldownMs: 0
}

/** Fire every event through a module armed with `defs`, and return the fired payloads. */
function fire(events: readonly LogEvent[], defs: readonly AlertDef[] = [CATCH_ALL]): FiredAlert[] {
  const mod = new AlertsModule()
  mod.setDefs([...defs])
  mod.reset()
  for (const e of events) mod.onEvent(e, true)
  return mod.flushDelta()?.delta.fired ?? []
}

let seq = 0
/** A synthetic event carrying exactly the fields the extractor reads. */
function ev(partial: Partial<LogEvent> & { kind: LogEvent['kind'] }): LogEvent {
  seq += 1
  return { seq, ts: 1_700_000_000_000 + seq * 1000, raw: `raw-${partial.kind}-${seq}`, ...partial } as LogEvent
}

// ---------------------------------------------------------------- (A) real lines, real parser

test('a real cast line fires with the spell RANK INTACT — stripping is the resolver’s job', () => {
  const parsed = parseEvent('[Sat Aug 02 21:14:03 2026] You begin casting Mesmerization III.', 1)
  assert.equal(parsed?.kind, 'castBegin', 'the fixture line must still parse as a cast')
  const [fired] = fire([parsed], [alertFor('castBegin')])
  assert.equal(fired.spell, 'Mesmerization III')
  // The other two fields are untouched by this change — the payload only GREW.
  assert.equal(fired.alertId, 'on-castBegin')
  assert.equal(fired.matchedText, parsed.raw)
})

test('a real resist line carries its spell; a real zone line carries none', () => {
  const resist = parseEvent(
    '[Sat Aug 02 21:14:07 2026] a froglok gaz knight resisted your Shiftless Deeds III!',
    2
  )
  assert.equal(resist?.kind, 'resist')
  assert.equal(fire([resist], [alertFor('resist')])[0].spell, 'Shiftless Deeds III')

  const zone = parseEvent('[Sat Aug 02 21:20:00 2026] You have entered East Freeport.', 3)
  assert.equal(zone?.kind, 'zone')
  const [zoned] = fire([zone], [alertFor('zone')])
  assert.equal('spell' in zoned, false, 'an absent key is the honest encoding of "no spell here"')
})

// -------------------------------------------------------------------- (B) the family sweep

test('every family that KNOWS the spell attaches it, under whatever name it spells it', () => {
  // The three exceptions are the whole reason the extractor is a table and not a property read.
  const cases: { kind: LogEvent['kind']; event: Partial<LogEvent>; expect: string }[] = [
    { kind: 'castBegin', event: { spell: 'Clarity II' }, expect: 'Clarity II' },
    { kind: 'castFizzle', event: { spell: 'Allure VI' }, expect: 'Allure VI' },
    { kind: 'castInterrupted', event: { spell: 'Rune I' }, expect: 'Rune I' },
    { kind: 'resist', event: { spell: 'Mesmerization III' }, expect: 'Mesmerization III' },
    { kind: 'cc', event: { mob: 'a gaz knight', spell: 'Enthrall' }, expect: 'Enthrall' },
    { kind: 'heal', event: { target: 'You', amount: 50, spell: 'Superior Healing IV' }, expect: 'Superior Healing IV' },
    { kind: 'buffApply', event: { spell: 'Quickness', target: 'self' }, expect: 'Quickness' },
    { kind: 'buffFade', event: { spell: 'Swift Like the Wind' }, expect: 'Swift Like the Wind' },
    { kind: 'buffWearOff', event: { spell: 'Alacrity', target: 'self' }, expect: 'Alacrity' },
    { kind: 'buffExpired', event: { spell: 'Quickness', target: 'self' }, expect: 'Quickness' },
    // …and the three that do NOT call it `spell`:
    { kind: 'poisonProc', event: { strike: 'Asp Venom Strike', target: 'a gaz knight' }, expect: 'Asp Venom Strike' },
    { kind: 'poisonCoat', event: { poison: 'Asp Venom', who: 'you' }, expect: 'Asp Venom' },
    // damage: `skill` IS the spell for the typed-nuke and DoT shapes (log/parseCombat.ts).
    { kind: 'damage', event: { dtype: 'spell', skill: 'Shock of Fire II' }, expect: 'Shock of Fire II' },
    { kind: 'damage', event: { dtype: 'dot', skill: 'Envenomed Bolt' }, expect: 'Envenomed Bolt' }
  ]
  for (const c of cases) {
    const [fired] = fire([ev({ ...c.event, kind: c.kind })])
    assert.equal(fired.spell, c.expect, `${c.kind} must carry ${c.expect}`)
  }
})

test('families that name no spell attach none — never an empty string, never a guess', () => {
  const cases: { kind: LogEvent['kind']; event: Partial<LogEvent> }[] = [
    { kind: 'zone', event: { zone: 'East Freeport' } },
    { kind: 'loot', event: { item: 'a rusty dagger' } },
    { kind: 'death', event: { name: 'a gaz knight', bySelf: true } },
    { kind: 'uncharm', event: { mob: 'a gaz knight' } },
    { kind: 'miss', event: { attacker: 'a gaz knight', target: 'You', mtype: 'miss' } },
    // An AA name is not a spell name, and this family is where that line is drawn.
    { kind: 'aaActivate', event: { name: 'Quick Buff' } },
    // illusionFade names nothing by design (27-way ambiguous); poisonDry names only a group.
    { kind: 'illusionFade', event: { target: 'self' } },
    { kind: 'poisonDry', event: { group: 'combat' } },
    // A melee swing's `skill` is a melee skill, and a damage shield's is an element.
    { kind: 'damage', event: { dtype: 'melee', skill: 'Slashing' } },
    { kind: 'damage', event: { dtype: 'ds', skill: 'thorns' } },
    // 'unknown' is what a generic third-person coat line says — a stated absence, not a name.
    { kind: 'poisonCoat', event: { poison: 'unknown', who: 'Pollux' } },
    // A cc APPLICATION carries no spell (only its worn-off keep-alive does).
    { kind: 'cc', event: { mob: 'a gaz knight' } },
    // Blank/whitespace never becomes a spell.
    { kind: 'castBegin', event: { spell: '   ' } }
  ]
  for (const c of cases) {
    const [fired] = fire([ev({ ...c.event, kind: c.kind })])
    assert.ok(fired, `${c.kind} still fires`)
    assert.equal('spell' in fired, false, `${c.kind} must not claim a spell`)
  }
})

test('a raw-trigger alert on a spell-bearing line still gets the context; an app fire never does', () => {
  // A `raw` trigger matches text, but the EVENT behind it is still typed — so the speech modes
  // work for raw alerts too, which is what makes "alert me on this line, say the spell" possible.
  const mod = new AlertsModule()
  mod.setDefs([
    {
      id: 'raw-mez',
      name: 'Raw mez',
      enabled: true,
      trigger: { type: 'raw', regex: 'begin casting' },
      sound: { packId: 'alan-rickman', soundId: 'settled' },
      cooldownMs: 0
    },
    {
      id: 'boss-defeat',
      name: 'Raid target defeated',
      enabled: true,
      trigger: { type: 'app', signal: 'bossDefeat' },
      sound: { packId: 'alan-rickman', soundId: 'settled' }
    }
  ])
  mod.reset()
  const cast = parseEvent('[Sat Aug 02 21:14:03 2026] You begin casting Mesmerization III.', 9)
  assert.ok(cast)
  mod.onEvent(cast, true)
  assert.equal(mod.flushDelta()?.delta.fired[0].spell, 'Mesmerization III')

  // Renderer-evaluated 'app' signals never see a LogEvent at all, so they carry no spell —
  // and a spell speech mode on one falls back to the alert's name (speechTextFor).
  mod.appFired('boss-defeat', 'Lord Nagafen')
  const [appFire] = mod.flushDelta()?.delta.fired ?? []
  assert.equal(appFire.alertId, 'boss-defeat')
  assert.equal('spell' in appFire, false)
})

test('replay never fires, so it never produces spell context either', () => {
  const mod = new AlertsModule()
  mod.setDefs([CATCH_ALL])
  mod.reset()
  mod.onEvent(ev({ kind: 'castBegin', spell: 'Clarity II' }), false)
  assert.equal(mod.flushDelta()?.delta.fired.length ?? 0, 0, 'a historical cast makes no sound')
})
