// ROGUE SLOW POISON ALERTS (docs/plans/poison-slow-alerts.md) — the verified group, the
// observed-driven offer, and the dead suggestion it replaces.
//
// Five proofs, in the order the feature is built:
//   (P1) THE GROUP DEF FIRES, THROUGH THE REAL PARSER AND THE REAL MATCHER. The whole
//        w41-poison-asp-venom.log window is replayed line by line; the def must fire on the
//        slow landings and the 30 s cooldown must collapse the re-landing burst. The exact
//        firing count is pinned, not a floor — this alert's only real design question is
//        "how often does it speak", and a regression either way is a bug.
//   (P2) THE `effect` MATCHER IS THE DISCRIMINATOR. The other nine poison procs, including
//        the deceptively-named spell-slow (`'s fingers slow down.`), must NOT fire it.
//   (P3) THE ON-YOU VARIANT'S VERDICT, measured rather than assumed: `Your limbs slow down!`
//        is NOT a poisonProc — the parser routes it to `buffApply { spell:'Weakening
//        Strike', target:'self' }` — and it occurs ZERO times in the reference log, which is
//        why alertGroups.ts ships no def for it.
//   (P4) THE MODULE RECORDS THE OBSERVATION on replay as well as live, and ships it on the
//        delta; plus the kind-union widening that lets any of this compile.
//   (P5) THE DETECTOR'S TRUTH TABLE, and the dead `lands` template both directions.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb, buildSpellCatalog } from '../src/main/data/spellDb'
import { AlertsModule } from '../src/main/modules/alerts'
import {
  ALERT_GROUPS,
  POISON_SLOW_ALERT_ID,
  POISON_SLOW_GROUP_ID,
  VERIFIED_ALERT_GROUPS,
  alertGroupDefs,
  poisonSlowAlertDefs
} from '../src/shared/alertGroups'
import { ALL_LOG_EVENT_KINDS } from '../src/shared/logEventKinds'
import { POISON_SLOW_OFFER_ID, detectPoisonSlowOffers } from '../src/shared/spellLines'
import { POISON_PROCS } from '../src/shared/poisons'
import type { AlertDef, PoisonSlowRecency } from '../src/shared/types'
import { readFixture } from './harness.mts'

const TS = '[Mon Aug 03 15:22:27 2026] '

/** The one def the "Rogue slow poisons" group authors. */
function slowGroup(): AlertDef[] {
  const group = ALERT_GROUPS.find((g) => g.id === POISON_SLOW_GROUP_ID)
  assert.ok(group, 'the rogue-slow group must exist')
  return alertGroupDefs(group)
}

/** Replay raw lines through the REAL parser into a REAL AlertsModule; return fire timestamps. */
function fireTimes(defs: AlertDef[], lines: string[]): number[] {
  const mod = new AlertsModule()
  mod.setDefs(defs)
  mod.reset()
  let seq = 0
  for (const line of lines) {
    const ev = parseEvent(line, seq++)
    if (ev) mod.onEvent(ev, true)
  }
  return (mod.flushDelta()?.delta.fired ?? [])
    .filter((f) => f.alertId === POISON_SLOW_ALERT_ID)
    .map((f) => f.ts)
}

// ─────────────────────────────────────────────────────────────────────────────
// (P1) THE FIXTURE WINDOW.

test('P1 the slow group fires on the w41 window, cooldown-collapsed (real parser + matcher)', () => {
  const lines = readFixture('w41-poison-asp-venom.log')

  // The window's ground truth, re-derived here rather than trusted: six `poisonProc` events
  // with effect 'slow', four of them on ONE mob inside 44 s (the re-landing shape).
  let seq = 0
  const slows: { ts: number; target: string }[] = []
  for (const line of lines) {
    const ev = parseEvent(line, seq++)
    if (ev?.kind === 'poisonProc' && ev.effect === 'slow') slows.push({ ts: ev.ts, target: ev.target })
  }
  assert.equal(slows.length, 6, 'the fixture carries six rogue slow landings')
  const stonesoul = slows.filter((s) => s.target === 'Stonesoul the Unmoving')
  assert.equal(stonesoul.length, 4, 'four re-lands on one mob — this is why the def needs a cooldown')
  assert.equal(
    stonesoul[stonesoul.length - 1].ts - stonesoul[0].ts,
    44_000,
    'inside 44 s — an alert without a cooldown would be a klaxon'
  )

  const fired = fireTimes(slowGroup(), lines)

  // THE MEASURED VERDICT, and it overturns the plan's §2 expectation of "one firing": with
  // cooldownMs 30 000 the four Stonesoul lands collapse to TWO alerts, not one, because the
  // 3rd land is 36 s after the 1st and the cooldown is measured from the last FIRE. Six
  // landings over the whole window become three alerts. That is the honest behaviour of the
  // engine's alert-level cooldown (fight-scoped dedupe is not expressible), and pinning it
  // exactly is what keeps a future cooldown edit from silently becoming a klaxon.
  assert.equal(fired.length, 3, 'six landings, three alerts')
  assert.deepEqual(
    fired.map((t) => t - slows[0].ts),
    [0, 36_000, 198_000],
    'fires at the 1st, 3rd and 5th landing — each ≥30 s after the previous FIRE'
  )
  const inPull = fired.filter((t) => t <= stonesoul[stonesoul.length - 1].ts)
  assert.equal(inPull.length, 2, 'the 4-in-44s burst is collapsed from four alerts to two')

  // Every firing is a real landing — the alert never invents an instant of its own.
  const slowTimes = new Set(slows.map((s) => s.ts))
  for (const t of fired) assert.ok(slowTimes.has(t), 'a fire lands exactly on a parsed slow event')
})

test('P1b the def quotes a line that is verbatim in the fixture it was written from', () => {
  const group = ALERT_GROUPS.find((g) => g.id === POISON_SLOW_GROUP_ID)
  assert.ok(group)
  const spec = group.defs[0]
  const lines = readFixture('w41-poison-asp-venom.log')
  assert.ok(
    lines.some((l) => l.endsWith(spec.line)),
    `the quoted line must exist verbatim in the fixture: ${spec.line}`
  )
  // The group is offered, its note carries the duration + the re-landing habit, and NO copy
  // anywhere in the feature states a slow percentage (the wiki self-contradicts, 35% vs 15%).
  assert.ok(VERIFIED_ALERT_GROUPS.some((g) => g.id === POISON_SLOW_GROUP_ID))
  const def = poisonSlowAlertDefs()[0]
  assert.equal(def.id, POISON_SLOW_ALERT_ID)
  assert.equal(def.cooldownMs, 30_000)
  assert.match(def.note ?? '', /3:30/)
  assert.match(def.note ?? '', /re-lands/)
  const copy = [group.title, group.subtitle, spec.name, def.note ?? '', spec.note ?? ''].join(' ')
  assert.equal(/\d+\s?%|percent/i.test(copy), false, 'no slow percentage may be printed')
})

// ─────────────────────────────────────────────────────────────────────────────
// (P2) THE DISCRIMINATOR.

test('P2 where:{effect:slow} picks the rogue slow out of the other nine procs', () => {
  const defs = slowGroup().map((d) => ({ ...d, cooldownMs: 0 }))
  assert.equal(fireTimes(defs, [TS + "a rock golem's limbs move slower!"]).length, 1)

  // The near-miss that matters: Clumsiness Strike's emote is ALSO about slowing down, and its
  // effect is 'spellSlow'. Exact (case-insensitive) equality on the field means it must not
  // fire — a substring matcher here would make the alert lie about what landed.
  const others = [
    TS + "a rock golem's fingers slow down.", // spellSlow
    TS + "a rock golem's feet won't budge!", // root
    TS + 'a rock golem starts limping!', // snare
    TS + 'a rock golem begins to sway!', // stun
    TS + 'a rock golem screams as poison burns their veins!' // damage
  ]
  assert.equal(fireTimes(defs, others).length, 0, 'no other poison proc fires the slow alert')

  // Sanity on the fixture's own vocabulary: the emotes above are real proc suffixes.
  const suffixes = new Set(POISON_PROCS.map((p) => p.suffix))
  assert.ok(suffixes.has("'s limbs move slower!"))
  assert.ok(suffixes.has("'s fingers slow down."))
})

// ─────────────────────────────────────────────────────────────────────────────
// (P3) THE ON-YOU VARIANT — measured, then omitted.

test('P3 `Your limbs slow down!` is a buffApply, not a poisonProc — so no def ships for it', () => {
  // Production shape: the real spell DB installed, exactly as main does at startup.
  installSpellDb(loadSpellDb())
  const ev = parseEvent(TS + 'Your limbs slow down!', 1)
  assert.ok(ev, 'the line parses')
  assert.equal(ev.kind, 'buffApply', 'the poison branch does not claim it — the DB cast-on-you does')
  assert.equal(ev.kind === 'buffApply' ? ev.spell : null, 'Weakening Strike')
  assert.equal(ev.kind === 'buffApply' ? ev.target : null, 'self')

  // And it fires NOTHING in the shipped group: an on-you def would need its own trigger, and
  // the line occurs ZERO times in the reference log (1,211,830 lines, 2026-08-03), so there
  // is no verified line to quote. Per alertGroups.ts's law it is omitted, never guessed.
  assert.equal(fireTimes(slowGroup(), [TS + 'Your limbs slow down!']).length, 0)
  const group = ALERT_GROUPS.find((g) => g.id === POISON_SLOW_GROUP_ID)
  assert.equal(group?.defs.length, 1, 'exactly one def — the on-you variant is deliberately absent')
  installSpellDb(undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// (P4) THE MODULE RECORD + THE KIND UNION.

test('P4 the alerts module records poisonSlowSeen on REPLAY as well as live', () => {
  const mod = new AlertsModule()
  mod.setDefs([])
  mod.reset()
  let seq = 0
  // live:false — the offer must be right at hydration, and firing must stay live-only.
  for (const line of readFixture('w41-poison-asp-venom.log')) {
    const ev = parseEvent(line, seq++)
    if (ev) mod.onEvent(ev, false)
  }
  const seen = mod.snapshot().state.poisonSlowSeen
  assert.ok(seen, 'replay alone populates the record')
  assert.equal(seen.count, 6)
  assert.equal(seen.lastTarget, 'an elemental crusader')

  // It rides the delta too, so the strip recomputes on a landing without a re-hydration —
  // and the delta carries the ABSOLUTE record, not an increment.
  const delta = mod.flushDelta()
  assert.equal(delta?.delta.fired.length, 0, 'replay never fires')
  assert.deepEqual(delta?.delta.poisonSlow, seen)
  assert.equal(mod.flushDelta(), null, 'the queue drains — no repeat deltas')

  // reset() is a character switch: the record is character state and goes with it.
  mod.reset()
  assert.equal(mod.snapshot().state.poisonSlowSeen, undefined)
})

test('P4b the poison kinds are in the editor kind list (the union gated the whole feature)', () => {
  for (const kind of ['poisonProc', 'poisonCoat', 'poisonDry']) {
    assert.ok(ALL_LOG_EVENT_KINDS.includes(kind as never), `${kind} missing from the kind picker`)
  }
  assert.equal(new Set(ALL_LOG_EVENT_KINDS).size, ALL_LOG_EVENT_KINDS.length, 'no duplicate kinds')
})

// ─────────────────────────────────────────────────────────────────────────────
// (P5) THE DETECTOR + THE DEAD TEMPLATE.

const SEEN: PoisonSlowRecency = { lastAt: 1_785_795_965_000, count: 6, lastTarget: 'a rock golem' }

function def(over: Partial<AlertDef>): AlertDef {
  return {
    id: 'x',
    name: 'x',
    enabled: true,
    trigger: { type: 'event', kind: 'uncharm' },
    sound: { packId: 'alan-rickman', soundId: 'task-error-task-error-01' },
    ...over
  }
}

test('P5 the poison-slow offer truth table', () => {
  const slowTrigger = { type: 'event', kind: 'poisonProc', where: { effect: 'slow' } } as const

  // seen, nothing covering it ⇒ ONE offer, with the observation attached.
  const offers = detectPoisonSlowOffers([], SEEN)
  assert.equal(offers.length, 1)
  assert.deepEqual(offers[0], {
    id: POISON_SLOW_OFFER_ID,
    count: 6,
    lastAt: SEEN.lastAt,
    lastTarget: 'a rock golem'
  })
  // An unrelated alert changes nothing.
  assert.equal(detectPoisonSlowOffers([def({})], SEEN).length, 1)

  // ZERO observations ⇒ nothing. The offer is made from evidence, never from a class guess.
  assert.equal(detectPoisonSlowOffers([], null).length, 0)
  assert.equal(detectPoisonSlowOffers([], undefined).length, 0)
  assert.equal(
    detectPoisonSlowOffers([], { lastAt: 0, count: 0, lastTarget: '' }).length,
    0
  )

  // ALREADY COVERED, four ways.
  assert.equal(detectPoisonSlowOffers([def({ trigger: slowTrigger })], SEEN).length, 0)
  assert.equal(
    detectPoisonSlowOffers([def({ trigger: { type: 'event', kind: 'poisonProc' } })], SEEN).length,
    0,
    'no effect matcher ⇒ every proc fires it, slows included'
  )
  assert.equal(
    detectPoisonSlowOffers(
      [def({ trigger: { type: 'event', kind: 'poisonProc', where: { effect: '/slow/' } } })],
      SEEN
    ).length,
    0,
    'a regex matcher that matches "slow" covers it'
  )
  assert.equal(
    detectPoisonSlowOffers(
      [
        def({
          trigger: { type: 'any', conditions: [{ type: 'event', kind: 'uncharm' }, slowTrigger] }
        })
      ],
      SEEN
    ).length,
    0,
    'a composite that can fire on a slow covers it'
  )

  // NOT covered: a DISABLED alert is not covering anything…
  assert.equal(detectPoisonSlowOffers([def({ trigger: slowTrigger, enabled: false })], SEEN).length, 1)
  // …unless it is THIS alert, which the user created and then chose to switch off. Asking
  // again would be nagging.
  assert.equal(
    detectPoisonSlowOffers(
      [def({ id: POISON_SLOW_ALERT_ID, trigger: slowTrigger, enabled: false })],
      SEEN
    ).length,
    0
  )
  // …and a proc alert for a DIFFERENT effect leaves the slow uncovered.
  assert.equal(
    detectPoisonSlowOffers(
      [def({ trigger: { type: 'event', kind: 'poisonProc', where: { effect: 'snare' } } })],
      SEEN
    ).length,
    1
  )

  // ACCEPT is idempotent against the group card: the def the offer creates retires the offer.
  assert.equal(detectPoisonSlowOffers(poisonSlowAlertDefs(), SEEN).length, 0)

  // DISMISSED ⇒ none. The dismissal itself lives in the renderer (localStorage, shared with
  // the upgrade strip); what the detector owes it is a STABLE id, which is pinned here.
  const dismissed = new Set([POISON_SLOW_OFFER_ID])
  assert.equal(detectPoisonSlowOffers([], SEEN).filter((o) => !dismissed.has(o.id)).length, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// (P6) THE RELOCATION (docs/plans/suggest-dialog-redesign.md §2).
//
// The offer moved OUT of the alerts view's strip and INTO the suggest dialog's "From your
// fights" section — "rogue slows should not be exceptional, they're part of add suggestion"
// (the owner). The detector, the dismissal set and the def are unchanged (P5 pins all three),
// so what is left to prove is the MOUNT, and that is a fact about the source tree: exactly one
// surface renders the card, and it is the dialog's.

test('P6 the offer is mounted by the suggest dialog, not by the alerts view', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const view = read('../src/renderer/src/features/alerts/AlertsView.tsx')
  const results = read('../src/renderer/src/features/alerts/SuggestResults.tsx')

  assert.equal(
    /import\s+PoisonSlowOffer\s+from/.test(view),
    false,
    'AlertsView must no longer render the poison-slow strip'
  )
  assert.equal(
    view.includes('usePoisonSlowOffers'),
    false,
    '…nor hold its detector: one surface owns the offer'
  )
  assert.ok(
    /import\s+PoisonSlowOffer\s+from/.test(results),
    'the suggest dialog’s results body mounts it'
  )
  assert.ok(results.includes('From your fights'), 'inside the observation-driven section')

  // The RANK-UPGRADE strip is untouched: it rewrites alerts that already exist, so it stays
  // beside the list it edits. Losing it in this move would be a silent regression.
  assert.ok(view.includes('useUpgradeOffers') && view.includes('<UpgradeOffers'))
})

test('P5b the dead `lands` suggestion is gone for poison Strikes, and only for them', () => {
  const db = loadSpellDb()
  const catalog = buildSpellCatalog(db, new Map())
  const byKey = new Map(catalog.entries.map((e) => [e.key, e]))

  // WEAKENING STRIKE: its emote (`'s limbs move slower!`) is claimed by the parser's poison
  // branch before the DB buff branch ever sees it, so a `buffApply` alert on it can NEVER
  // fire. The wizard must not offer one. (It has no other template either, so the row drops
  // out of the catalog entirely — which is the same statement, stronger.)
  assert.equal(byKey.get('weakening strike')?.templates.lands ?? false, false)
  assert.equal(db.byKey.has('weakening strike'), true, 'the spell is still IN the DB — only the suggestion went')

  // Every detrimental spell whose cast-on-other emote is a poison proc is suppressed the same
  // way — the suffix list is imported from shared/poisons.ts, never copied.
  const procMsgs = new Set(POISON_PROCS.map((p) => p.suffix))
  const claimed = db.spells.filter(
    (s) => s.spellType === 'Detrimental' && s.msgCastOnOther && procMsgs.has(s.msgCastOnOther)
  )
  assert.ok(claimed.length >= 12, 'twelve detrimental Strikes carry a proc emote')
  for (const s of claimed) {
    assert.equal(
      byKey.get(s.name.toLowerCase())?.templates.lands ?? false,
      false,
      `${s.name} must not offer a lands alert — the parser routes its emote to poisonProc`
    )
  }

  // THE OTHER DIRECTION: an ordinary detrimental spell still offers its lands template.
  const normal = catalog.entries.filter((e) => e.spellType === 'Detrimental' && e.templates.lands)
  assert.ok(normal.length > 100, 'the fix must not have swept the whole detrimental catalog')
  const mez = byKey.get('mesmerization')
  assert.equal(mez?.templates.lands, true, 'Mesmerization still lands the ordinary way')
})
