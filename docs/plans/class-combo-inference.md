# Class-combo inference — design

Status: DESIGN ONLY (no source touched). Author: planning agent, 2026-08-03.
Everything below is grounded in the REAL log (`eqlog_Primitive_freeport.txt`,
1,108,373 lines at time of writing), the real `src/main/data/spells.json`, and
eqlwiki.com. Verbatim log evidence is quoted; every unverified claim is labeled
INFERENCE.

---

## 0. TL;DR for the integrator

- The game mechanic is now **verified**, not assumed. 16 classes; a loadout holds
  **up to 3**; the character's level is the **MINIMUM** of the loadout's class
  levels; classes in the loadout gain XP together. Loadout swaps are **never
  logged** — confirmed again on a 1.1M-line sweep.
- The evidence we need is **already almost entirely on the bus**: `castBegin`,
  `stanceChange`, `invocationChange`, `poisonCoat`. One NEW parser rule family is
  needed (`skillUp`, `You have become better at <Skill>!`) plus the **self `/who`
  line** (`selfWho`), which is the only authoritative statement of the combo.
- `spells.json` **already carries** a `classes` field for every spell. It needs a
  PARSER, not a re-crawl. A small new scrape (`scrape:classes`) is needed for
  skill→class and stance/invocation→class.
- **Naive frequency scoring fails** (measured: it returns ENC for everything). The
  model must be **presence + exclusivity + sustain**, not counts.
- **Four classes (BER, MNK, WAR, ROG) have ~zero spells.** They are invisible to
  cast evidence and are detectable ONLY via skill-ups / stances / poisons. Say so
  in the UI.
- The end-to-end model was **validated against the log**: it correctly recovers
  `PAL/MNK/ENC` for Jul 28–Aug 1 and `PAL/ROG/BER` for Aug 2–3, and it correctly
  localizes the Aug 2 swap.

---

## 1. Verified game model

### 1.1 The 16 classes and their `/who` codes

Source: `https://eqlwiki.com/Character_Classes` — "There are '''sixteen total
classes''' in EverQuest Legends."

| Abbr | Class | Archetype |
|---|---|---|
| BER | Berserker | Melee |
| BRD | Bard | Hybrid |
| BST | Beastlord | Hybrid |
| CLR | Cleric | Priest |
| DRU | Druid | Priest |
| ENC | Enchanter | Caster |
| MAG | Magician | Caster |
| MNK | Monk | Melee |
| NEC | Necromancer | Caster |
| PAL | Paladin | Hybrid |
| RNG | Ranger | Hybrid |
| ROG | Rogue | Melee |
| SHD | Shadow Knight | Hybrid |
| SHM | Shaman | Priest |
| WAR | Warrior | Melee |
| WIZ | Wizard | Caster |

Note **SHD**, not SHK. The wiki's own spell pages spell the class two ways
(`Shadow Knight` and `Shadowknight`) — canonicalize both to SHD.

### 1.2 Loadouts (eqlwiki `Newbie Guide § Loadouts` / `§ Leveling Classes`)

Verbatim, the load-bearing paragraph:

> Up to level 10, all 16 classes will level at the same time, regardless of which
> combination you are actively playing. Beginning at level 10, *only* the classes
> you are actively playing will gain experience, and at they do so at the same
> rate. If at any time you switch to a different loadout, or edit your current
> loadout, your character level will be adjusted to the *lowest* of the three
> classes that you chose.

And from the real log's own General chat (line 250462), independently:

> `[Tue Jul 28 20:44:31 2026] Unoti tells NewPlayers6:1, 'you basically can-- when you switch loadouts, it uses the level of your lowest level class'`

Consequences that the data model MUST encode:

1. **Cardinality is level-gated.** Primary + Secondary at creation; **Tertiary
   unlocks at level 10**. The real log confirms exactly this: `[7 CLR/BER]` and
   `[7 PAL/ENC]` are 2-class rows; every row at level ≥10 is 3-class. So the
   expected combo size is `level < 10 ? 2 : 3` — a *prior*, not a certainty.
2. **Displayed level = min(class levels in loadout).** Therefore a level DROP is a
   legitimate swap, exactly as `epochDetector.ts` already says. Do not re-derive
   epochs from it.
3. Loadouts may only be swapped in cities / newbie-adjacent zones. INFERENCE: this
   gives a weak zone prior for swap timing, but the log has no "you may change
   your loadout here" line, so it is NOT usable as a trigger. Do not use it.
4. Race changes with the loadout (the `/who` rows show Froglok / Dark Elf / Ogre
   for the same character). Race is NOT part of the combo model; the app already
   handles illusions separately.

NOT ON THE WIKI (explicit gap): the level at which a never-played class sits when
first slotted. INFERENCE from the log: it is 10 (all 16 classes level in lockstep
to 10), which is exactly consistent with the Aug 2 drop to level 10.

### 1.3 Swaps are NOT logged — re-verified

`grep -ci loadout` over the whole 1.1M-line log returns **37** lines, and every
one is another player's chat (`tells General:1, '…'`). There is no
`You have chosen`, no class-change line, no loadout line addressed to the player.
`levelingSwapWindows.test.mts` already documents this for the Jul 31→Aug 2 swap;
this design re-confirms it at 1.1M lines.

**The owner's fear is correct.** Swap detection is therefore INFERENCE, always,
and must be labeled as such per World-model law 1.

---

## 2. Evidence sources, ranked by authority

Ranking is by *how much the log actually says*, per law 1 ("messages over
inference") and law 6 ("say what the log cannot say").

### Tier A — OBSERVED. The log states the combo outright.

**A1. The self `/who` row.** The single authoritative line. Real shape, verbatim:

```
[Fri Jul 31 23:48:53 2026] [50 PAL/MNK/ENC] Primitive (Dark Elf)  ZONE: East Freeport (freporte)
[Tue Jul 28 14:11:26 2026] [7 CLR/BER] Primitive (Froglok)  ZONE: West Commonlands (commons)
```

- **All 11 occurrences in the whole log**, complete (lines 180625, 180767, 216573,
  244279, 247443, 247628, 250096, 271097, 297871, 298950, 782732):
  `[7 CLR/BER]`, `[7 PAL/ENC]`, `[10 PAL/ROG/ENC]`, `[17 PAL/MNK/ENC]` ×3,
  `[18 PAL/MNK/ENC]`, `[20 PAL/MNK/ENC]`, `[10 PAL/ROG/ENC]`,
  `[24 PAL/MNK/ENC]`, `[50 PAL/MNK/ENC]`.
- **Sparse**: 11 rows in 1.1M lines, all user-typed, none within 33 h of the Aug 2
  swap. So `/who` alone can never keep the combo current.
- **Two trailing spaces** on every row. Guild tag, ` AFK `, `* RIP *` and
  `[ANONYMOUS]` variants exist in the general `/who` grammar (see
  `tests/fixture-scrub.mjs` DROP rule 2) — the self regex must tolerate the AFK
  and guild-tag forms even though this log has none for Primitive yet.
- **Scrub interaction**: `fixture-scrub.mjs` already carves the self row out of
  the `/who` drop (`isThirdPartyChat` checks
  `^\[\d+ [A-Z]{3}(/[A-Z]{3})*\] Primitive\b` FIRST). The carve-out is keyed on
  the hardcoded `SELF_NAME = 'Primitive'`, which is fine for fixture extraction
  but **the runtime parser must key off the tailed character's name**, not a
  constant.
- The bracket level on the self row agrees with the level series everywhere it can
  be checked (ding 17 at 20:11 → `[17 …]` at 20:16; ding 24 at 23:34 → `[24 …]`
  at 00:38; ding 50 at 16:19 → `[50 …]` at 23:48). The two rows where it
  disagrees (`[10 PAL/ROG/ENC]` after a level-11 ding) are exactly the brief
  rogue excursions — i.e. the disagreement *is* the min-level rule working.

**A2. User correction (provenance `user`).** Authoritative from the moment the
user sets it, until contradicted by a LATER `/who` or a detected swap. Ranked
above `/who` for the interval it is applied to, because the user knows.

### Tier B — INFERRED, high specificity. A single observation can name one class.

**B1. Stances (`stanceChange`) and invocations (`invocationChange`).** Already
parsed (`parseCasts.ts` `STANCE_RE` / `INVOCATION_RE`), already on the bus. The
wiki's `Stances & Invocations` page gives an explicit per-class access list.

Stances (9) and their classes:

| Stance | Classes |
|---|---|
| balanced | BER BRD BST MNK PAL RNG ROG SHD WAR |
| berserker | **BER only** |
| channeler | CLR DRU ENC MAG NEC SHM WIZ |
| defensive | PAL SHD WAR |
| evasive | BRD MNK RNG BST ROG |
| mage hunter | BER PAL SHD |
| offensive | BER BRD BST MNK PAL RNG ROG SHD WAR |
| ranged | BER MNK RNG ROG |
| striker | BER MNK ROG WAR |

Invocations (9): `arcane mastery` ENC MAG NEC SHD WIZ · `divine` BST CLR DRU PAL
RNG SHM · `empowering` CLR DRU ENC MAG NEC SHM WIZ · `inversion` (12 classes,
weak) · `inviolable` BRD WIZ · `overchannel` (12, weak) · `recovery` (12, weak) ·
`spellblade` BST PAL RNG SHD · `unyielding` BER MNK ROG WAR.

**This gating is CONFIRMED by the real log**, which is the strongest single result
of this research. `berserker stance` (BER-exclusive) is used 85× total: 2× on
Jul 28 morning (the `[7 CLR/BER]` window) and **83× from Aug 2 onward** — and
**zero times** across Jul 28 14:36 → Aug 1, the entire `PAL/MNK/ENC` period.
Likewise `channeler` (7 casters, no melee) and `inviolable` (BRD/WIZ) appear ONLY
on Jul 19–20 — the wiped beta character, which the epoch boundary excludes anyway.

Data-quality warnings carried from the wiki scrape, to be recorded in the data
file as comments and honored as *soft* weights:
- The `Invocations by Class` matrix has a malformed Arcane Mastery row; the prose
  `Classes` column is the reliable one.
- Prose and matrix DISAGREE on Beastlord/Evasive. Use prose, flag unverified.
- Prose says `Empower`; the client string is `empowering`. Key on the CLIENT
  string (`parseCasts.ts` already lowercases it), map to the wiki row.

**B2. Rogue poisons (`poisonCoat`).** eqlwiki `Disciplines`: "only Rogue poison
disciplines are on Legends", "Rogue poisons are auto-granted between levels 1 and
20". So `You coat your blades …` is **ROG-exclusive**. Real log has 6 such lines
(5 distinct agents) — rare but decisive. Already parsed as `poisonCoat`.

**B3. Skill-ups — `You have become better at <Skill>!` — NOT PARSED TODAY.**
This is the *only* evidence family that can see BER/MNK/WAR/ROG, and it is
abundant. Verbatim first occurrence:

```
[Tue Jul 28 12:32:17 2026] You have become better at Frenzy! (9)
```

Measured signature skills and their day distribution (this is the money table —
it is what proves the design works):

| Skill | Class | Jul 19–20 | Jul 28 | Jul 29 | Jul 30 | Jul 31 | Aug 1 | Aug 2 | Aug 3 |
|---|---|---|---|---|---|---|---|---|---|
| Mend | MNK | – | 101 | 63 | 24 | 2 | 8 | **0** | **0** |
| Flying Kick | MNK | – | – | 209 | 31 | 15 | – | **0** | **0** |
| Backstab | ROG | – | 1 | – | – | – | – | **177** | 6 |
| Frenzy | BER | – | 23 | – | – | – | – | **129** | 12 |
| Singing | BRD | 60 / 10 | – | – | – | – | – | – | – |

Read that against the `/who` ground truth: MNK evidence runs exactly across the
`PAL/MNK/ENC` period and stops dead at the Aug 2 swap; the single Jul 28 Backstab
is the `[10 PAL/ROG/ENC]` excursion; Frenzy's 23 on Jul 28 is the `[7 CLR/BER]`
window; Singing is the pre-launch beta character only.

Skill→class mapping is NOT in the repo today and must be scraped (§6).

### Tier C — INFERRED, low specificity. Casts.

**C1. `castBegin` → spell → class set.** `spells.json` already has the field:

```json
{ "name": "Minor Healing",
  "classes": "* Beastlord - Level 1 (Autogranted) * Cleric - Level 1 (Autogranted) * Druid - Level 1 (Autogranted) * Paladin - Level 1 * Ranger - Level 1 * Shaman - Level 1" }
```

The wiki's `classes=` is a bullet list; `scrape-spells.ts:clean()` collapses
`\s+` to a single space, so the newlines are gone but **no data is lost**. Parse
with `/\*\s*(<ClassAlt>)\s*-\s*Level\s*(\d+)/g`.

Measured coverage over the 1926-spell DB:

```
single-class 1146   multi-class 309   no-class 471 (NPC-only / "No eligible class" / prose)
BER   0 /   0        BRD  91 /  90        BST  77 /  27        CLR 206 /  82
DRU 268 / 152        ENC 239 / 184        MAG 202 / 161        MNK   0 /   0
NEC 192 /  86        PAL  91 /  17        RNG  92 /  20        ROG   9 /   9
SHD  90 /  23        SHM 209 / 102        WAR   0 /   0        WIZ 235 / 193
                                            (total / class-EXCLUSIVE)
```

**BER, MNK, WAR have literally zero spells; ROG has nine.** This is a hard
"say what the log cannot say" boundary for cast evidence.

Log-side coverage after rank-stripping (`spellCanonKey`): 13,993 of 14,441
`You begin casting` lines resolve to a class set. The 448 unresolved are 17
distinct names, dominated by `Lay on Hands I…X` (441) plus `Holy Steed` (61) and
`Bottle of Alternate Adventure` (31, an item). `Lay on Hands` and `Holy Steed`
are Paladin abilities that are not `Template:Spellpage` pages — the ability gap
that §6's scrape closes.

**Cast evidence is the WEAKEST tier and must be weighted accordingly**, for three
measured reasons:
1. **Volume ≠ truth.** A frequency model returns ENC for every window (ENC casts
   outnumber PAL 10:1) — see §4.1.
2. **Items cast spells.** The wiki's `items_with_effect` proves spells fire from
   clickies. The real log shows exactly one `Chaos Flux` (ENC-exclusive) on
   Aug 2 19h, in a window where every other signal says the loadout is PAL/ROG/BER
   and ENC is out. Treat an isolated cast as noise, never as a slot.
3. **Charmed pets.** `Pillage Enchantment`-style lines and the charm model mean
   some casts are not the player's — the parser's own-cast gating already covers
   `You begin casting`, so this is a small risk, but it is a risk.

### Tier D — STRUCTURAL. Says a swap happened, not what to.

**D1. Non-increasing level ding.** `You have gained a level! Welcome to level N!`
where `N <= previousN`. Full-log sweep finds exactly three:

```
2026-07-21 L30 → 2026-07-28 L2    (the beta wipe — the epoch boundary, not a swap)
2026-07-28 L11 → 2026-07-28 L11   (a REPEAT ding, 0.9 h apart — a swap)
2026-07-31 L50 → 2026-08-02 L11   (the big swap)
```

Note the **repeat** (11 → 11). The existing `buildLevelSegments` splits on strict
descent (`<`) and therefore misses it. For the leveling chart that is arguably
fine; for combo-interval boundaries `<=` is the correct predicate. Call this out
so the executor does not "fix" `levelSeries.ts` and break its golden window —
the combo module carries its own predicate.

**D2. Over-determination.** If a window's exclusive-evidence set has MORE than
`maxSlots` classes, a swap happened INSIDE the window. This is a first-class
detector, not an error: it is how we localize a swap with no `/who` and no level
ding. Measured on Aug 2 (2 h buckets): `[BER,ENC]`, `[BER]`, `[BER,PAL]`,
`[BER,ENC,PAL]`, `[BER,ENC]` — the flicker of ENC/PAL against a constant BER is
exactly this signal at work.

### Explicitly NOT evidence (documented non-distinguishables)

- Zone (loadouts change in cities, but no line says you did).
- Race in `/who` (illusions dominate it).
- Equipment/loot (no line ties an item to a class).
- Generic melee verbs (`You kick`, `You bash`, `You crush`) — shared across many
  classes and, worse, conjugate for mobs too (law: melee verbs conjugate).
- AA purchases. The wiki says AAs are shared across loadouts and class-gated AAs
  go DORMANT rather than being lost, so an AA purchase line does not prove the
  class is currently slotted. Do not use it.

---

## 3. Data model

New file `src/shared/classCombo.ts` (shared so preload/renderer can import types
without crossing the tsconfig boundary — the precedent is `shared/types.ts`).

```ts
/** The 16 EQ Legends classes, by their /who three-letter code. */
export type ClassAbbr =
  | 'BER' | 'BRD' | 'BST' | 'CLR' | 'DRU' | 'ENC' | 'MAG' | 'MNK'
  | 'NEC' | 'PAL' | 'RNG' | 'ROG' | 'SHD' | 'SHM' | 'WAR' | 'WIZ'

/** Where a statement about the combo came from. Ordered by authority. */
export type ComboProvenance =
  | 'user'      // the user corrected it in the UI — authoritative until contradicted
  | 'who'       // the character's own /who row stated it — observed, timestamped
  | 'inferred'  // derived from casts/skills/stances — NEVER presented as fact

/**
 * ONE slot's knowledge. `candidates` is the SET of classes still consistent with
 * the evidence; the slot is RESOLVED only when it holds exactly one.
 * A 3-slot combo where two slots resolve and one holds {CLR,PAL} is the normal,
 * honest state — that is what "2-of-3 known" looks like, and the UI renders it.
 */
export interface ComboSlot {
  candidates: ClassAbbr[]      // 1 = resolved; >1 = ambiguous; sorted, deduped
  confidence: number           // 0..1, see §4.3
  provenance: ComboProvenance
  /** Human-readable evidence keys that produced this slot, newest first, capped at 8. */
  because: string[]            // e.g. ['stance:berserker', 'skill:Frenzy', 'who']
}

/**
 * A contiguous span during which we believe the loadout did not change.
 * Boundaries are FUZZY by construction — a swap prints nothing.
 */
export interface ComboInterval {
  id: string                   // 'ci<n>', stable within a replay; see §5.4
  startTs: number              // best estimate
  endTs: number | null         // null = the open/current interval
  /** Boundary uncertainty: the swap happened somewhere in [startLo, startHi]. */
  startLo: number
  startHi: number
  endLo: number | null
  endHi: number | null
  /** Why we opened this interval. */
  startReason: 'who' | 'levelDrop' | 'evidenceShift' | 'overDetermined' | 'user' | 'logStart'
  /** 2 before the tertiary unlock, 3 after — a PRIOR, revisable by evidence. */
  expectedSlots: 2 | 3
  slots: ComboSlot[]           // length == expectedSlots unless evidence says otherwise
  /** Level range observed inside this interval (min-of-loadout semantics). */
  levelLo: number | null
  levelHi: number | null
  /** Counts, for the UI's "how much do we actually know" affordance. */
  evidenceCount: number
  /** Set ONLY by a user correction; suppresses re-inference for this interval. */
  userLocked: boolean
}

/** One atomic piece of evidence, before it is folded into a slot. */
export interface ClassObservation {
  ts: number
  seq: number
  source: 'who' | 'stance' | 'invocation' | 'poisonCoat' | 'skillUp' | 'cast'
  /** Display key: 'Frenzy', 'berserker', 'Mesmerization'. */
  label: string
  /** Classes consistent with this observation. |1| = exclusive = decisive. */
  candidates: ClassAbbr[]
  /** Source weight (§4.2), precomputed so scoring is a pure sum. */
  weight: number
}

export interface ComboSnap {
  intervals: ComboInterval[]   // time-ordered, non-overlapping, last one may be open
  /** Convenience: intervals[intervals.length - 1] or null. */
  current: ComboInterval | null
  /** Data-availability flag for the UI: false until the class tables are loaded. */
  ready: boolean
}

export interface ComboDelta {
  /** Intervals that were added OR revised since the last flush; merge by id. */
  changed: ComboInterval[]
  /** Ids that were SPLIT away or merged out of existence; drop them. */
  removed: string[]
}
```

### 3.1 The static class knowledge table

New generated file `src/main/data/classes.json` (ES-imported, therefore inlined by
electron-vite — same rule as `spells.json`), written by `scrape:classes` (§6):

```ts
export interface ClassTable {
  scrapedAt: string
  /** abbr -> display name. */
  names: Record<ClassAbbr, string>
  /** lowercased client stance string -> classes. */
  stances: Record<string, ClassAbbr[]>
  /** lowercased client invocation string -> classes. */
  invocations: Record<string, ClassAbbr[]>
  /** exact skill name as printed in `You have become better at <X>!` -> classes. */
  skills: Record<string, ClassAbbr[]>
  /** abilities that are NOT Spellpage pages (Lay on Hands, Holy Steed, …). */
  abilities: Record<string, ClassAbbr[]>
  /** Rows the wiki contradicts itself on — carried through so the UI can say so. */
  disputed: string[]
}
```

Spell→class is NOT in this file. It is derived at module init from the existing
`spells.json` `classes` string by a pure function in
`src/main/data/spellClasses.ts`, keyed by `spellCanonKey` (rank-stripped), so the
1.9k-entry parse happens once. Two spells canonicalizing to the same key UNION
their class sets.

---

## 4. The algorithm

### 4.1 What does NOT work (measured, so nobody re-tries it)

A frequency model — score each class by `Σ 1/|candidates|` over a window — was
implemented and run against all 11 `/who` anchors. Result:

```
Tue Jul 28 20:16:48  truth=[PAL/MNK/ENC]  →  ENC:264.7 BST:46.8 SHM:22.8 PAL:21.1 CLR:12.6   HIT 1/3
Fri Jul 31 23:48:53  truth=[PAL/MNK/ENC]  →  ENC:91.0 PAL:17.9 CLR:13.7 DRU:13.4 SHM:13.4    HIT 2/3
```

ENC wins everything because the user casts ENC spells constantly; BST/SHM/DRU
place high purely on shared-heal volume. **Do not rank by count.**

### 4.2 What does work: presence · exclusivity · sustain

For an interval, per class `c`:

```
exclusive(c) = # of DISTINCT labels whose candidate set is exactly {c}
support(c)   = Σ over distinct labels naming c of (weight / |candidates|)
sustain(c)   = # of distinct 1-hour buckets in the interval containing evidence for c
```

`weight` by source (Tier A/B/C from §2):

| source | weight | rationale |
|---|---|---|
| `who` | — | not scored; it OVERRIDES (§4.4) |
| `poisonCoat` | 3.0 | ROG-exclusive by game design, zero known false positives |
| `stance` | 2.5 | class-gated, verified against the log's own `/who` timeline |
| `skillUp` | 2.5 | class-gated, and the ONLY window into BER/MNK/WAR/ROG |
| `invocation` | 1.5 | class-gated but 3 of 9 span 12 classes; wiki has known errors |
| `cast` | 1.0 | high volume, item clickies, charm noise |

**DISTINCT LABELS, not occurrences** — this is the whole fix. 177 Backstab
skill-ups count once for "ROG is present"; what earns a second point is a
*different* ROG label.

A class is **admitted** to the combo when
`exclusive(c) >= 1 AND sustain(c) >= 2`, ranked by `(exclusive, support)`, taking
at most `expectedSlots`. The `sustain >= 2` clause is what rejects the single
stray `Chaos Flux` on Aug 2 (one bucket → ENC not admitted).

### 4.3 Resolving slots and stating ambiguity honestly

After admission, `admitted` may be shorter than `expectedSlots`. Fill the
remaining slots from the **residual candidate sets**:

1. Collect every observation not already explained by an admitted class.
2. Intersect their candidate sets greedily (largest-support cluster first). A
   cluster of `{CLR,PAL}` observations with PAL already admitted explains itself
   and yields NO new slot. A cluster that does not intersect any admitted class
   becomes an **ambiguous slot** carrying the whole candidate set.
3. Any slot still unaccounted for is emitted as
   `{ candidates: ALL_16, confidence: 0, provenance: 'inferred', because: [] }` —
   an explicit **UNKNOWN slot**, which the UI renders as "unknown". Never invent.

Confidence per slot:

```
resolved by /who or user      → 1.0
resolved, exclusive >= 2      → 0.9
resolved, exclusive == 1, sustain >= 3 → 0.75
resolved, exclusive == 1, sustain == 2 → 0.5
ambiguous (n candidates)      → 0.6 / n      (we know the set, not the member)
unknown slot                  → 0
```

Interval confidence is the MIN over slots, never the mean — a combo you only 2/3
know is a 2/3-known combo.

**This is where CLR/PAL lives.** Measured: CLR is *never* exclusively evidenced in
this log because `Reckless Strength`, `Wrath`, `Smite`, `Furor`, `Center`,
`Courage`, `Daring`, `Stun`, `Holy Armor` are all `{CLR,PAL}`. The `[7 CLR/BER]`
anchor is genuinely unresolvable from casts. The model must — and with this
design does — report a `{CLR,PAL}` ambiguous slot rather than guessing PAL.

### 4.4 Anchoring on `/who` and on user corrections

A `selfWho` observation at `ts` inside interval `I`:

- **Overrides** every slot in `I` with `provenance:'who'`, confidence 1.0.
- If the stated combo CONTRADICTS admitted inferred classes elsewhere in `I`
  (a class with exclusive evidence that `/who` does not list), that is proof a
  swap happened inside `I` → **split** `I` at the contradiction boundary (§4.5).
- Sets `expectedSlots` from the row's own arity (2 or 3) — the row is ground truth
  about cardinality too.

A user correction is identical but with `provenance:'user'`, and additionally sets
`userLocked = true`, which freezes the slots against re-inference. A LATER `/who`
that disagrees WINS and clears the lock (the user's knowledge went stale; the game
just spoke). Record that transition in `because` so the UI can explain it.

### 4.5 Interval construction (swap detection)

Single pass over observations, in seq order, maintaining an open interval.

**Hard boundary (confident, narrow uncertainty):**
- A `selfWho` whose combo differs from the current interval's resolved slots.
  `startLo = previous observation ts`, `startHi = who.ts`.
- A non-increasing level ding (`level <= lastLevel`). `startLo = previous ding ts`,
  `startHi = this ding ts`. Note this window is WIDE (33.9 h for the Aug 2 swap) —
  that is honest, and the UI must show it as a range, not a point.
- `epoch` event → close everything, drop it all, start fresh (§7).

**Soft boundary (evidence shift):**
- Maintain a rolling window (default 90 min). Recompute the admitted set.
- If the admitted set **gains** a class that had NO evidence in the previous
  `2 × window`, or **loses** a class that had sustained evidence and has now been
  silent for `> 4 h` of *active play* (measured by observation density, not wall
  clock — an overnight gap is not a swap), open a boundary.
  `startLo` = last observation of the departing class,
  `startHi` = first observation of the arriving class.
- **Over-determination**: if the admitted set exceeds `expectedSlots`, bisect the
  window and recurse until each sub-window is consistent or the window floor
  (15 min) is hit. If the floor is hit while still over-determined, DO NOT split
  — mark the interval `startReason:'overDetermined'` and widen the slot candidate
  sets. An honest "we can't tell" beats a fabricated boundary.

**Merge rule:** two adjacent intervals whose resolved slots are identical and
whose boundary was soft are merged (the shift was noise). Hard boundaries never
merge — `/who` and a level ding are the log speaking.

Because a later correction can re-label the past, **intervals are recomputed from
the retained observation ring on every correction**, not patched in place.

### 4.6 Validation against the real log

Run end-to-end on the live log:

- **Jul 28 – Aug 1** admitted `{ENC, PAL}` continuously with MNK arriving via
  `Mend` (101 on Jul 28) and `Flying Kick` (209 on Jul 29) → `PAL/MNK/ENC`,
  matching six independent `/who` rows.
- **Aug 2 – Aug 3** admitted `{PAL, ROG, BER}` — `Lay on Hands` + `Instrument of
  Nife` (PAL), `Backstab` (ROG, 177), `Frenzy` + `berserker stance` (BER, 129+83)
  — present in EVERY hourly bucket of both days, while MNK's `Mend`/`Flying Kick`
  go to exactly zero. The last `/who` (Jul 31) says `PAL/MNK/ENC`, so this is a
  pure inference and it is corroborated by the level arithmetic: ROG sat at 10
  since Jul 28 and BER at ~7–11, so `min = 10` predicts the observed drop to 10
  and the `Welcome to level 11!` ding at Aug 2 02:13:34. **INFERENCE, but a
  triple-corroborated one.**
- The Jul 28 `[10 PAL/ROG/ENC]` excursions are detected by exactly one Backstab
  skill-up and one repeat level ding — a genuinely thin interval, which the model
  should surface at low confidence and short duration rather than smoothing away.

---

## 5. Integration — the seam

### 5.1 A new `EqModule`

`src/main/modules/combo.ts`, id `'combo'`, registered in `pipeline.ts`
**FIRST** (before `lootModule`) so that within one bus delivery the combo state is
already advanced when later modules and `combat.ingestEvent` see the same event.
Registration order in `pipeline.ts` is documented as load-bearing; this adds one
line at the top of that block.

Contract, per `modules/types.ts`:
- `reset()` — clear observations and intervals (character (re)load).
- `onEvent(ev, live)` — fold `selfWho | castBegin | stanceChange |
  invocationChange | poisonCoat | skillUp | level | epoch`.
- `onTick(now)` — close/extend the open interval's `endLo/endHi` while the log
  idles; no other module needs the heartbeat but the open interval's uncertainty
  genuinely grows with wall time.
- `snapshot() → { seq, state: ComboSnap }`, `flushDelta() → ComboDelta | null`.

File-size law (`max-lines 400`, `max-lines-per-function 100`, `complexity 12`,
`max-depth 3`) forces a split — plan for four files, mirroring how `buffs` is
split into `buffs*.ts`:

| file | contents |
|---|---|
| `modules/combo.ts` | the `EqModule` shell: fold, dirty tracking, snapshot/delta |
| `modules/comboEvidence.ts` | `LogEvent → ClassObservation` (the table lookups) |
| `modules/comboScore.ts` | pure: observations → admitted set → slots (§4.2–4.3) |
| `modules/comboIntervals.ts` | pure: observations → `ComboInterval[]` (§4.5) |

The three non-shell files are PURE and take plain arrays — that is what makes the
golden-window tests possible without Electron.

### 5.2 How other consumers get `comboAt(ts)` — join at read, never stamp

**Recommendation: do NOT enrich events on the bus, and do NOT stamp `comboId`
onto records at write time.**

Rationale, and it is the load-bearing architectural point of this design:

- Interval boundaries are **fuzzy and revisable**. A `/who` typed an hour from now
  retroactively re-labels the last hour; a user correction re-labels an arbitrary
  span; the over-determination bisector can split an interval that already
  "happened". Any `comboId` stamped onto a boss kill or an encounter summary at
  record time **goes stale the moment the past is revised**, and there is no
  reconciliation path that does not amount to a migration per revision.
- Bus enrichment would additionally force a field onto `LogEventBase`, which every
  parser rule, every fixture expectation and every module's discriminated-union
  narrowing would have to carry — a large blast radius for a derived fact.
- Every record we want to tag **already has a timestamp**. Boss kills come from
  `death` events via `bossStatus.ts:bossKills()`; encounter summaries carry their
  own clock; level events are `{ts, level}`. A time join is exact, free, and
  automatically correct after any revision.

So the seam is a **pure read model**:

```ts
// src/shared/comboIndex.ts — pure, no Electron, importable from main AND renderer
export function comboAt(intervals: ComboInterval[], ts: number): ComboInterval | null
export function groupByCombo<T extends { ts: number }>(
  intervals: ComboInterval[], rows: T[]
): { interval: ComboInterval | null; rows: T[] }[]
```

Consumers:
- **BossView** (`features/bosses/BossView.tsx`, `bossStatus.ts`) calls
  `groupByCombo(intervals, bossKills(...))` to render kills sectioned by combo.
  `bossStatus.ts` itself stays combo-unaware — the grouping happens in the view.
- **LevelingView** (`features/leveling/LevelingView.tsx`) can colour/annotate the
  existing `buildLevelSegments` output by combo. **Do not change
  `levelSeries.ts`** — its golden window (`levelingSwapWindows.test.mts`) pins the
  strict-descent predicate and must stay byte-identical.
- **Combat** encounter summaries are grouped in the renderer by their existing
  timestamps. `CombatEngine` is not touched at all.

`bossDefeat` app-signal behaviour (App.tsx `onNewDefeat`) is **unchanged**. A
combo tag is a display grouping, not a new signal.

The one place main-side code may want `comboAt` is a future alert condition; that
is out of scope here and the pure function is already importable if it lands.

### 5.3 IPC

No new channel. The generic module transport carries it:
`module:getSnapshot('combo')` + `module:delta`, consumed by
`useModule<ComboSnap, ComboDelta>('combo', applyComboDelta)`.

ONE new channel is needed for the correction, because it is a write:

```
combo:setCorrection  (payload: { startTs: number; endTs: number | null;
                                 classes: ClassAbbr[] })  → void
combo:clearCorrection (payload: { intervalId: string })    → void
```

Both validated AT THE HANDLER (per the trust-boundary rule): `classes` must be a
1–3 length array of members of the `ClassAbbr` literal set, deduped; timestamps
must be finite and ordered. Never trust the renderer because today's only caller
is the app's own UI.

### 5.4 Interval ids

`ci<n>` assigned in time order at snapshot time. Because a correction recomputes
intervals wholesale, ids are **not stable across a recompute** — so the delta's
`removed` list exists and the renderer must key on `id` from the latest snapshot
only. Persisted corrections key on **timestamps**, not ids (§7), precisely so they
survive recomputation.

---

## 6. Scraper extension

**Good news: no spell re-crawl.** `spells.json` already has `classes`, and
`scripts/sources/cache/spells/` is populated, so even a re-run is network-free.
Spell→class is a pure parse (`src/main/data/spellClasses.ts`), not a scrape.

**One new scraper: `scripts/scrape-classes.ts` → `npm run scrape:classes` →
`src/main/data/classes.json`.** It must obey the scraper-etiquette LAW: delay
between requests (the existing 120 ms in `scrape-spells.ts` is the precedent),
exponential backoff honouring `Retry-After` on 429/5xx, disk cache under
`scripts/sources/cache/classes/` so re-runs skip the network, idempotent output.

Pages to fetch (**~20 requests total** — this is a tiny, polite crawl):

| target | endpoint | yields |
|---|---|---|
| `Character Classes` | `action=parse&prop=wikitext` | abbr → name (16) |
| `Stances & Invocations` | `action=parse&prop=wikitext` | stance/invocation → classes |
| each of the 16 class pages | `action=parse&prop=sections` then the Skills sections | skill → classes |
| `Disciplines` | `action=parse&prop=wikitext` | rogue-poison confirmation |

Parsing notes learned from the actual wikitext:
- Take stance/invocation classes from the **prose `Classes` column**, not the
  matrix — the matrix has a malformed Arcane Mastery row and disagrees with the
  prose on Beastlord/Evasive. Emit both disagreements into `disputed[]`.
- Class pages carry `Combat Skills` / `Casting Skills` / `Miscellaneous Skills`
  subsections; invert them into `skills`.
- Abilities that are not `Template:Spellpage` pages (`Lay on Hands`, `Holy Steed`)
  come from the class page's ability tables into `abilities`.
- Normalize `Shadowknight` → `Shadow Knight` → `SHD`.
- The wiki's search index is stale (`srsearch=loadout` returns 0 hits for a page
  that contains a Loadouts section) — **navigate by title, never by search**.

**KEEP-THE-TREE-BUILDABLE rule applies**: `classes.json` is ES-imported, so a stub
`{"scrapedAt":"","names":{},"stances":{},"invocations":{},"skills":{},"abilities":{},"disputed":[]}`
must be committed BEFORE any file imports it, then overwritten by the scrape. This
is the exact miss that took the dev app down for a mob-page crawl.

---

## 7. Persistence + migration

Combo state is **character-scoped**, so it belongs under
`byCharacter[<name_server>]` in `everquest-companion-progress.json`, alongside the
existing `ProgressState`.

Persist ONLY what cannot be recomputed:

```ts
interface ComboProgress {
  /** User corrections. Keyed by TIME, not interval id — ids are recompute-unstable. */
  corrections: {
    startTs: number
    endTs: number | null
    classes: ClassAbbr[]
    setAt: number
  }[]
}
```

Intervals themselves are **NOT persisted** — they are derived from the log on
every replay, and persisting them would create a second source of truth that could
disagree with the log. Corrections are the only durable state.

**Epoch rules.** `epochDetector.ts` fires once at the launch anchor
(2026‑07‑28 00:00 local) and every character-scoped module clears on the `epoch`
event. The combo module does the same: on `epoch`, drop all observations and
intervals. **Corrections whose `startTs < LAUNCH_MS` are dropped too** — they
describe the dead beta character. Do this in the module (in-memory) AND once, in
the migration, on disk. Critically: **do not add a level-regression epoch trigger
here** — a level drop is a loadout swap, which is the entire point of this
feature.

**MIGRATION LAW.** This adds a key under `byCharacter[*]`, which is a persisted
shape change, so the same commit MUST:
- bump `CURRENT_SCHEMA_VERSION` 2 → 3 in `src/main/storeMigrations.ts`,
- append (never renumber) a `{ from: 2, to: 3 }` step that adds
  `combo: { corrections: [] }` to each `byCharacter` entry that lacks it and drops
  any pre-launch correction,
- add a fixture to `tests/storeMigrations.test.mts` covering: v2 store with
  characters, v2 store with none, and a v3 store (no-op).

Every reader must default on the missing key so a downgrade round-trips (the
existing downgrade policy — log, back up, leave alone — is unchanged).

---

## 8. UI — the correction surface

Home: a new **`src/renderer/src/features/profiles/ClassCombo*.tsx`**. `profiles/`
is the right neighbourhood — it already owns "who is this character" concerns
(`ProfileSharing.tsx`) — whereas `leveling/` owns a chart and would drag the
combo state into a view pinned by a golden window. Surface it on the Overview
tab as a compact card, with the full editor in Profiles.

Per the UI conventions (**state, never process** — no methodology captions, no
"how we inferred this" panels):

- **`ComboChip`** — the compact readout. `PAL / ROG / BER`. Chips carry state:
  - `/who` or user provenance → no qualifier chip (it is simply known).
  - inferred → an `inferred` chip, matching the existing inferred-chip idiom.
  - an ambiguous slot renders as `CLR?/PAL?` with the existing `~ambiguous` chip.
  - an unknown slot renders `—` with an `unknown` chip. Never a guess.
- **`ComboTimeline`** — intervals as a horizontal band on the same clock as the
  level chart. Boundary uncertainty draws as a **hatched region** spanning
  `[startLo, startHi]`, so a 33.9 h swap window LOOKS like 33.9 h of not-knowing.
  Sub-2 h intervals stay visible (min width) rather than collapsing.
- **`ComboEditor`** — pick 1–3 classes for the selected interval; Save calls
  `combo:setCorrection` with the interval's `[startTs, endTs]`. A `Reset to
  detected` action clears it. Because corrections are time-keyed, editing an
  interval that later gets split applies to both halves — state that in the button
  label ("applies to this time range"), not in a paragraph.
- Boss/leveling views gain a **combo section header** from `groupByCombo`, and
  nothing else changes.

Formatting goes through `lib/formatDate` (user-local) and the existing
`lib/tierChip` idiom for chip colour. Lists are short; no windowing needed.

---

## 9. Risks

| # | risk | mitigation |
|---|---|---|
| R1 | **BER/MNK/WAR/ROG are invisible to cast evidence** (0/0/0/9 spells). If the skill-up parser or the class table is wrong, three of sixteen classes can never be detected. | Skill-ups are Wave 1 and get their own golden window. The UI reports an unknown slot rather than filling it. |
| R2 | Wiki class tables are **known-inconsistent** (Arcane Mastery row malformed; Beastlord/Evasive prose-vs-matrix conflict; Empower vs Empowering naming). | Prose column wins; conflicts land in `disputed[]`; invocations carry the lowest non-cast weight; nothing hard-eliminates a class. |
| R3 | **Item clickies cast spells.** One `Chaos Flux` on Aug 2 would admit ENC into a loadout that does not have it. | `sustain >= 2` buckets required for admission — measured to reject exactly this case. Consider parsing `items_with_effect` later to down-weight clicky spells. |
| R4 | **`/who` is sparse** (11 rows / 1.1M lines) and user-typed. Long stretches have no anchor at all. | Inference is the primary path by design; `/who` is a corrector, not a driver. Confidence honestly reflects the absence. |
| R5 | **Feign Death spans MNK/NEC/SHD** and appears on Aug 2 (7×) when MNK is out. Either the class table is incomplete for EQL or the skill is broader than classic EQ. | Do NOT hard-eliminate on a shared skill. Flag `Feign Death` in `disputed[]` and let the exclusive signals carry the interval. |
| R6 | Swap boundaries can be **33.9 h wide**. A boss kill inside the window is genuinely unattributable. | Model it: `startLo/startHi`, hatched in the UI, and `comboAt()` returns the interval whose *estimate* covers `ts` while the UI shows the uncertainty. Never a crisp lie. |
| R7 | Recompute-on-correction makes interval ids unstable. | Ids are snapshot-scoped; corrections key on timestamps; delta carries `removed`. |
| R8 | Over-determination bisection could thrash on a genuinely ambiguous span. | Hard 15-min window floor; on hitting it, widen candidates instead of splitting. |
| R9 | `spellCanonKey` collisions after rank-stripping could union unrelated class sets. | Union is the conservative direction (it widens candidates, never narrows). Log collisions at scrape/parse time. |
| R10 | Registering `combo` first in `pipeline.ts` changes documented delivery order. | It is additive and combo consumes no derived events; note it in the pipeline comment block in the same commit. |

---

## 10. Wave plan

Four agents, disjoint file ownership, run as two sequential pairs (Waves 1–2 can
run in parallel; 3 depends on both; 4 depends on 3). Every wave ends with
`npm run typecheck` + `npm run lint` + `npm test`; Waves 3–4 add `npm run test:e2e`.

Ratchet rule: no wave may ADD a ratchet entry (integrator's call only). New files
must be lint-clean under `complexity 12` / `max-depth 3` / `max-lines 400` /
`max-lines-per-function 100` / `max-params 4` — hence the four-file split in §5.1.

### Wave 1 — evidence intake (parser + fixtures)

Owns: `src/main/log/parseCasts.ts` (or a new `parseWho.ts`), `src/shared/logEvents.ts`,
`tests/extract-combo-fixtures.mjs`, `tests/comboParse.test.mts`.

1. New event `SelfWhoEvent { kind:'selfWho'; level:number; classes:string[]; race?:string; zone?:string }`.
   Regex must key on the **tailed character's name** (from `ParserConfig`), not a
   constant, and tolerate the guild-tag / ` AFK ` / `* RIP *` variants. Real
   shape and the two trailing spaces are in §2/A1.
2. New event `SkillUpEvent { kind:'skillUp'; skill:string; value?:number }` for
   `You have become better at <Skill>! (<n>)`. Real line quoted in §2/B3.
   Full-log skill histogram is in §2/B3 — 40+ distinct skills.
3. Extend `tests/fixture-scrub.mjs` ONLY if needed: the self-`/who` carve-out
   already exists and must keep working with the runtime name.
4. Extract fixtures (see §11).

Verification: `comboParse.test.mts` asserts the 11 real self-`/who` rows parse to
their exact combos and the skill-up line parses; a full-log replay asserts the
`selfWho` count is `>= 11` (a floor, not an equality — the log grows).

### Wave 2 — class knowledge (scraper + data)

Owns: `scripts/scrape-classes.ts`, `package.json` (`scrape:classes` script),
`src/main/data/classes.json` (**stub committed FIRST**),
`src/main/data/spellClasses.ts`, `tests/classTables.test.mts`.

1. Commit the stub `classes.json` before anything imports it.
2. Write the scraper per §6, etiquette-compliant, ~20 cached requests.
3. `spellClasses.ts`: pure parse of `spells.json`'s `classes` string →
   `Map<canonKey, Set<ClassAbbr>>`.

Verification: `classTables.test.mts` (no Electron, never skips) pins the measured
invariants from §2/C1 — BER/MNK/WAR have zero spells, ROG has nine, ENC has 184
exclusives, `Minor Healing` resolves to exactly `{BST,CLR,DRU,PAL,RNG,SHM}` —
plus `berserker → {BER}` and `unyielding → {BER,MNK,ROG,WAR}` from the class
table. Assertions on the live wiki are forbidden; assert on the committed JSON.

### Wave 3 — the module (depends on 1 + 2)

Owns: `src/shared/classCombo.ts`, `src/shared/comboIndex.ts`,
`src/main/modules/combo.ts`, `comboEvidence.ts`, `comboScore.ts`,
`comboIntervals.ts`, `src/main/pipeline.ts` (one register line + comment),
`src/main/storeMigrations.ts` (v2→v3), `src/main/store.ts` (accessors),
`src/main/ipc/` (the two correction channels), `src/preload/`,
`tests/comboWindows.test.mts`, `tests/storeMigrations.test.mts` (append only).

Verification — golden windows are the law:
- **CW1** (`cw1-who-anchored.log`): the Jul 28 span containing four `/who` rows.
  Assert the module reproduces `[7 CLR/BER]`, `[7 PAL/ENC]`, `[10 PAL/ROG/ENC]`,
  `[17 PAL/MNK/ENC]` with `provenance:'who'` and confidence 1.0, and that
  `expectedSlots` follows the row arity (2 then 3).
- **CW2** (`cw2-loadout-swap-aug2.log`): the Jul 31 → Aug 3 span. Assert exactly
  two intervals; the earlier resolves `{ENC,PAL}` + MNK; the later resolves
  `{PAL,ROG,BER}`; every slot in the later interval is `provenance:'inferred'`;
  the boundary carries `startLo <= 2026-07-31T16:19` and `startHi >= 2026-08-02T02:13`
  (the honest 33.9 h window) and `startReason:'levelDrop'`.
- **CW3** (`cw3-ambiguous-clr-pal.log`): a `{CLR,PAL}`-only span. Assert the slot
  is AMBIGUOUS with both candidates and confidence `0.6/2`, and that the module
  does NOT resolve it to PAL.
- **CW4** (`cw4-stray-cast.log`): the Aug 2 window containing the lone
  `Chaos Flux`. Assert ENC is NOT admitted (the `sustain >= 2` rule).
- **Full-log replay** (`skip: !existsSync(LOG)`), invariants only per the
  frozen-numbers rule: intervals are time-ordered and non-overlapping; they
  partition the observation stream losslessly; every interval has
  `slots.length === expectedSlots`; `startLo <= startTs <= startHi`; at least one
  interval boundary exists (the Aug 2 swap); no interval claims more than 3
  resolved classes; the final interval's resolved set is a superset of `{BER}`.
- **Migration**: v2→v3 fixtures per §7.

### Wave 4 — UI (depends on 3)

Owns: `src/renderer/src/features/profiles/ClassCombo*.tsx`,
`features/overview/*` (card mount), `features/bosses/BossView.tsx` (section
header only), `features/leveling/LevelingView.tsx` (annotation only — **must not
touch `levelSeries.ts`**), `tests/e2e/combat-dashboard.e2e.mts` (or a new e2e
spec).

Verification: a headless e2e assertion that the combo card mounts, shows a
non-empty combo or an honest empty state, and that the editor opens. Per the
fixed-height rule, the interval list gets an explicit height + its own
`overflow:auto`.

---

## 11. Fixtures to extract

New `tests/extract-combo-fixtures.mjs`, routed through `scrubKeep` like every
other extractor (never a hand-copied span). It keeps: self-`/who` rows (already
scrub-exempt), `You have gained a level!`, `You begin casting/singing`,
`You assume a … stance.`, `You begin reciting the … invocation.`,
`You coat your blades …`, `You have become better at …!`.

| fixture | real span | proves |
|---|---|---|
| `cw1-who-anchored.log` | Jul 28 14:00 → 20:45 (log lines ~180400–250200) | four `/who` rows, 2→3 slot transition, the Jul 28 Backstab + Frenzy |
| `cw2-loadout-swap-aug2.log` | Jul 31 16:00 → Aug 3 (lines ~669500–end) | the unlogged swap, MNK→ROG/BER shift, 33.9 h boundary |
| `cw3-ambiguous-clr-pal.log` | Jul 28 14:11 ±30 min | `{CLR,PAL}` unresolvability |
| `cw4-stray-cast.log` | Aug 2 18:00 → 21:00 | the lone `Chaos Flux` must not admit ENC |

All four are inside the post-launch epoch except `cw1`'s left edge — verify each
extracted span sits at/after `LAUNCH_MS` so the epoch reset does not fire
mid-fixture (or include it deliberately and assert the wipe).

Privacy: the extractor inherits the shared scrub, so third-party `/who` rows and
all chat are dropped; only Primitive's own rows survive, which is the documented
carve-out. **The chat lines quoted in this document are from the live log and must
NOT be copied into any fixture** — they are cited here as research evidence only.

---

## 12. Open questions for the owner

1. **Is the current loadout PAL/ROG/BER?** The model says yes with high
   confidence; the last `/who` (Jul 31) says `PAL/MNK/ENC`. A single `/who` typed
   in game would turn Wave 3's headline inference into an observation and give
   CW2 a ground-truth assertion. Worth asking before Wave 3 starts.
2. **Does a newly-slotted class start at 10?** The wiki does not say; the log is
   consistent with it. Only affects a display hint, not the model.
3. Should a low-confidence interval shorter than ~15 min be shown at all, or
   folded into its neighbour with a marker? (Design says show it; the Jul 28
   rogue excursions are real and interesting.)
