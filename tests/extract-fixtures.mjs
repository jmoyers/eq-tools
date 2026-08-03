// One-off fixture extractor. Slices line ranges from the real log and trims obvious
// chat/spam while KEEPING every line the buffs+entity model cares about, so fixtures
// stay small and reviewable but replay is faithful. Re-runnable if the log grows
// (line numbers are captured in the golden test comments; re-locate if needed).
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

// Fixtures resolve RELATIVE to this file — the repo moved once and these extractors kept
// writing into the old absolute path. Never hardcode a repo path here again.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LOG = process.argv[2]
const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)

// Keep a line if it matters to parsing OR is one of the additive families (emotes).
// Drop pure chat/market/faction spam to keep fixtures lean. We keep timestamps intact.
const KEEP = [
  /You begin (casting|singing) /,
  /spell (fizzles!|is interrupted\.)/,
  /spell has worn off/,
  /has been charmed\./,
  /has been (mesmerized|enthralled|entranced|ensnared)\./,
  /told you, '(Attacking .+ Master|I am unable to wake .+?, Master)\.'/,
  /has been slain by /,
  /You have slain /,
  /You have been slain by /,
  /You have entered /,
  /Welcome to EverQuest Legends!/,
  // landing emotes (self + third-person) — the additive discriminator
  /^\[[^\]]+\] You (feel|look|are|sense|seem)\b[^.]*\.$/,
  /^\[[^\]]+\] [A-Z][a-z'`]+(?: [a-zA-Z'`]+)? (feels|looks|seems|is surrounded|glows|shimmers)\b[^.]*\.$/,
  // ── Task #34 message-driven model ──
  // Activated AA (Quick Buff), the AA-purchase line (Permanent Illusion), self-heals that
  // name a buff (the Symbol of Pinzarn apply signal), and ANY line matching a spell's
  // msg_cast_on_you / msg_cast_on_other / msg_wears_off — since those messages are the
  // whole point of these windows, we keep the buff-relevant flavor lines broadly.
  /^\[[^\]]+\] You activate /,
  /gained the ability "/,
  /^\[[^\]]+\] You healed .+ by .+\.$/,
  // cast-on-other / cast-on-you flavor that isn't a "You feel" self-emote (kept above):
  /flashes before your eyes\.$/,
  /looks tranquil\.$/,
  /face contorts and stretches/,
  /cool breeze slips through your mind\.$/,
  /cool breeze fades\.$/,
  /mystic symbol flashes|symbol of \w+ flashes/i,
  /valorous\.$/,
  /valor fades\.$/,
  /speed returns to normal\.$/,
  /illusion fades\.$/,
  /You feel\.\.\. strange\.$/, // Boon of the Garou self-cast (ellipsis breaks the emote KEEP)
  // Slow debuff cast-on-other message (Task #35 W10): "<Target> slows down." — the
  // msg_cast_on_other of the enchanter slows (Shiftless Deeds / Languid Pace / …). Its
  // subject is the mob the slow landed on, so it binds a debuff to that entity BY MESSAGE.
  /slows down\.$/,
  // Tashani cast-on-other message (Task #37 W13): "<Target> glances nervously about." — the
  // msg_cast_on_other of Tashani (INT/resist debuff). Binds a debuff instance to the charmed
  // ice giant BY MESSAGE, so we can assert it SURVIVES the charm break → re-charm.
  /glances nervously about\.$/,
  // Symbol cast-on-other landing (Task #45 W17): "<Target> is cloaked in a shimmer of glowing
  // symbols." — the msg_cast_on_other of the cleric Symbols. A NEARBY caster's Symbol landing
  // on the user's fight target; with own-cast gating it must NOT bind as the user's buff.
  /is cloaked in a shimmer of glowing symbols\.$/
]
function keep(line) {
  if (!line.startsWith('[')) return false
  return KEEP.some((re) => re.test(line))
}

function slice(fromLine, toLine, out) {
  const seg = []
  for (let i = fromLine - 1; i < toLine && i < lines.length; i++) {
    if (keep(lines[i])) seg.push(lines[i])
  }
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
}

// Build a fixture by SPLICING lines into an existing fixture right after the first line that
// matches `afterRe` (Task #37 W13b). Used to synthesize a contrast case from a real span —
// e.g. inject a real-format death between a charm break and re-charm.
function spliceFixture(srcName, afterRe, inject, out) {
  const src = readFileSync(join(FIXTURES, srcName), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
  const seg = []
  let done = false
  for (const l of src) {
    seg.push(l)
    if (!done && afterRe.test(l)) {
      for (const inj of inject) seg.push(inj)
      done = true
    }
  }
  writeFileSync(join(FIXTURES, out), seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (spliced from ${srcName})`)
}

// W1 current Permafrost session: zone 19:51:10 (903827) .. 19:56:13 (905700)
slice(895658, 905700, 'w1-current-session.log')
// W2 Xeneker death: Intensify cast 19:52:31 (159658) .. after slain 20:22 (167210)
slice(159640, 167260, 'w2-xeneker-death.log')
// W3 pet succession Gibober->Jenann: 18:39 (83900) .. Intensify fade 19:41:58 (97690)
slice(80900, 97700, 'w3-pet-succession.log')
// W4 logout gap: Clarity III 02:15 (~814970) .. after relog 13:03 (~815210)
slice(814800, 815210, 'w4-logout-gap.log')
// W5 charmed pet zoned: Swift 19:30:17 (898085) .. zone 19:46:49 (903534)
slice(486900, 490943, 'w5-charm-zone.log')
// W6 rank pairing: Shiftless IV 19:41:59 (901697) .. fade 19:45:53 (903364)
slice(901690, 903370, 'w6-rank-pairing.log')

// ── Task #34 message-driven windows ──
// W7 Quick Buff burst: window starts at the 20:22:13 Swift cast (912560) so the ambiguous
// "You feel much faster." burst message resolves to Swift (cast history), through the
// "You activate Quick Buff." burst 20:29:44 (915471) .. after it (20:29:52, 915490). The
// burst prints self-buff landing messages with NO "You begin casting" line — the
// message-driven applies are the whole point.
slice(912560, 915492, 'w7-quick-buff.log')
// W7 priming: a real Clarity III cast (18:46:49, line 891005) warms cast history so the
// ambiguous burst "A cool breeze slips through your mind." resolves to Clarity (not Boon of
// the Clear Mind / Flowing Thought). Mirrors production, where the player casts Clarity
// normally through the session before the Quick Buff burst.
slice(891000, 891010, 'w7-priming.log')
// W8 wears-off removes an active: Valor applies via the UNIQUE "You feel valorous."
// message in the Quick Buff burst 20:29:46 (915472) .. wears off via the UNIQUE "Your valor
// fades." 20:55:15 (923349), 25.5 min later (< Valor's 54-min DB duration, so it's a real
// message-driven removal, not a hygiene sweep). Unique messages → no priming needed.
slice(915470, 923352, 'w8-wears-off.log')
// W9 Permanent Illusion: purchase 00:40:53 (635160); self-cast Boon "You feel... strange."
// 00:44:38 (636178) → PERMANENT; pet-cast Boon on the charmed abhorrent 00:48:10 (637015)
// → NORMAL, wears off 00:54:07 (638646).
slice(635150, 639850, 'w9-permanent-illusion.log')

// ── Task #36 illusion exclusivity + observed-message overlay ──
// W11 ILLUSION EXCLUSIVITY: the real 20:15:41 → 20:23:39 window. "Your illusion fades."
// (912007) clears the prior illusion; "You begin casting Illusion: Wood Elf." (912013)
// + "You feel different." (912014) apply the Wood Elf illusion on SELF (resolved via cast
// history from the generic message); "You begin casting Boon of the Garou II." (912610) +
// "phoboplasm's face contorts…" (912612) apply Boon on the PET (not self); "Your illusion
// fades." at 20:23:39 (913155) removes the self Wood Elf illusion. Assert: never two self
// illusions at once, and at most one self illusion at the end.
slice(912000, 913160, 'w11-illusion-exclusivity.log')
// W12a OVERLAY LEARNING — SHARED: the 02:42-02:46 burst casts FOUR distinct illusion races
// (Dwarf/High Elf/Erudite/Halfling), each followed by the GENERIC "You feel different."
// (815096..815150) — so the overlay must classify that message SHARED (multiple spells).
slice(815090, 815155, 'w12-shared-illusions.log')
// W12b OVERLAY LEARNING — CONTRADICTS-WIKI: the sibling Symbol of Transal is cast-begun 9×
// and each time prints "The symbol of Transal flashes before your eyes." — the wiki's
// msg_cast_on_you ("A mystic symbol flashes before your eyes.") is WRONG, so the overlay
// records a CONTRADICTS-WIKI verdict. (Symbol of Pinzarn shares this exact wiki inaccuracy
// but is cast-begun only once, so its sibling Transal is the clean, repeatable proof.) The
// window spans several Transal cast→flash pairs on Jul 19 (84286..108493).
slice(84280, 108500, 'w12-symbol-contradiction.log')

// W10 CAZIC-THULE SLOW (Task #35): the user was fighting Cazic-Thule in The Plane of Fear.
// zone into Fear 20:46:05 (919145); charm the pet phoboplasm 20:56:52 (923617); cast
// Shiftless Deeds IV on Cazic-Thule at 21:01:40 (923936) and 21:01:46 (923994); then
// "Cazic-Thule slows down." 21:01:50 (924020) — the msg_cast_on_other of the slow, ambiguous
// across the enchanter slows, RESOLVED to Shiftless Deeds via the player's just-prior casts,
// and bound BY MESSAGE (not inferred) to the entity 'Cazic-Thule'.
slice(919140, 924080, 'w10-cazic-slow.log')

// W13 CHARM BREAK PRESERVES THE ENTITY + ITS BUFFS (Task #37). The user's charmed "an ice
// giant" broke and was re-charmed seconds later; the mob KEEPS its buffs through a charm
// break (disposition, not identity). Real span lines 903820 (19:51:10 zone) .. 905600:
//   19:54:56  an ice giant has been charmed.                (pet on)
//   19:55:45  You begin casting Tashani. → "an ice giant glances nervously about."
//                                                            (Tashani debuff bound to the pet)
//   19:55:52  Your Allure spell has worn off of an ice giant. (charm BREAK — 7s hostile window)
//   19:55:59  an ice giant has been charmed.                (RE-CHARM the SAME name)
// Assert: Tashani is active on 'an ice giant' before the break and STILL active after the
// re-charm (same entity — NO censoring). The DEFECT: the old uncharm handler retireEntity'd
// the pet, resetting its buffs (FINAL lost Tashani entirely). DB-enabled window.
slice(903820, 905600, 'w13-charm-break-recharm.log')

// W13b CONTRAST — DEATH BETWEEN break and re-charm ⇒ buffs do NOT carry (Task #37, rule #3).
// SYNTHESIZED FROM THE REAL W13 SPAN (the task explicitly permits this): the w13 fixture with
// ONE real-format death line spliced between the uncharm (19:55:52) and the re-charm
// (19:55:59): "an ice giant has been slain by a frost giant!" — a third-party kill of the
// ex-pet as a hostile mob. The death retires the broken-charm entity and CENSORS its Tashani,
// so the re-charm of the same name binds a genuinely NEW entity with no buffs. Generated by
// the spliceFixture helper below; regenerate whenever w13 changes. This proves the
// disposition-vs-identity rule cuts BOTH ways: same entity when the break→re-charm is clean, a
// new entity when a death (or zone) intervenes.
spliceFixture(
  'w13-charm-break-recharm.log',
  /Your Allure spell has worn off of an ice giant\.$/,
  ['[Sat Aug 01 19:55:54 2026] an ice giant has been slain by a frost giant!'],
  'w13b-charm-break-death-recharm.log'
)

// ── Task #45 windows ──
// W16 SHARED WEARS-OFF (self haste). The user cast Quickness on self at 19:48:16 (239516) →
// "You feel much faster." (239517); a later "Your speed returns to normal." 19:52:29 (239943)
// must remove the active SELF haste. "Your speed returns to normal." is the shared
// msg_wears_off of 9 haste spells (first candidate is Aanya's Quickening, which is NOT what's
// active) — the DEFECT was removing only the first candidate, so self Quickness never cleared.
// Assert: Quickness active mid-window, GONE after the speed-returns line.
slice(239510, 239945, 'w16-shared-wearsoff-speed.log')
// W17 OWN-CAST GATING (a stranger's Symbol on the user's fight target). The user is fighting
// with a group; a nearby Teir`Dal priestess casts Symbol of Ryltan on Kahaptra Z`Taj — the
// user's engaged mob — printing "Kahaptra Z`Taj is cloaked in a shimmer of glowing symbols."
// 16:19:58 (45831) with NO own castBegin of any Symbol. The user reported this landing on
// their buff list. Assert: NO Symbol appears in the active set (own-cast gate skips it).
slice(45810, 45835, 'w17-own-cast-gating.log')
// W17 priming: a real earlier own Symbol of Pinzarn self-cast + heal-apply span (the Aug 1
// Quick Buff burst, 962955..963016) warms cast history + everFaded for Symbol so the gate has
// a REALISTIC prior (a stranger's Symbol still doesn't attribute because the own cast is far
// outside the landing window — proving the gate is recency-based, not "ever cast it once").
slice(962955, 963020, 'w17-priming.log')

// ── Priming fixtures (Task #33): a real earlier excerpt that establishes learned state
// (everFaded / spell class / recognized landing emotes) BEFORE a golden window, mirroring
// what the full-log replay does in production ahead of the live tail. These are the
// user's own log lines, not synthetic. ──
// W2 priming: the single real Intensify Death fade (line 97684) marks it a KNOWN pet buff
// (everFaded + class 'pet') so the Xeneker window shows + then censors it.
slice(97680, 97690, 'w2-priming.log')

// W5 priming: a real ~21k-line charm-grind excerpt (Jul 31) that WARMS the classifier so
// Swift Like the Wind / Boon of the Garou classify as PET buffs (the full-log verdict) —
// mirroring the history that precedes the window in production. Trimmed to the
// buff/entity-relevant lines only.
slice(679000, 700000, 'w5-priming.log')

// W4 priming: the real "pet's Clarity worn off" fade (Jul 29) marks Clarity a KNOWN buff
// (everFaded) so a Clarity cast before the logout gap shows as active — and is then
// cleared by the ≥30-min session-gap rule.
slice(407668, 407669, 'w4-priming.log')
