// One-off fixture extractor. Slices line ranges from the real log and trims obvious
// chat/spam while KEEPING every line the buffs+entity model cares about, so fixtures
// stay small and reviewable but replay is faithful. Re-runnable if the log grows
// (line numbers are captured in the golden test comments; re-locate if needed).
import { readFileSync, writeFileSync } from 'fs'
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
  /You feel\.\.\. strange\.$/ // Boon of the Garou self-cast (ellipsis breaks the emote KEEP)
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
  writeFileSync(`C:/Users/jmoye/eq-tools/tests/fixtures/${out}`, seg.join('\n') + '\n')
  console.log(`${out}: ${seg.length} lines (from raw ${toLine - fromLine + 1})`)
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
