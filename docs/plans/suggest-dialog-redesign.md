# Suggest dialog redesign — one search that finds everything, grouped, compact

Design by the integrator (Fable), 2026-08-04. Owner feedback: "rogue slows
should not be exceptional — part of add suggestion; search should be
comprehensive (level, type, name, spell text); group results sensibly; more
compact so things fit on screen." Builds ON TOP of the search-perf fix
(fixed-height dialog, deferred rendering, memoized rows) — that lands first.

## 1. One search, four match surfaces

One box, tokenized: split on whitespace, every token must match (AND).

- **Bare text** matches name, rank names, AND the spell's three message texts
  (cast-on-you / cast-on-other / wears-off). This is what makes the search
  comprehensive for free: "slow" finds Weakening Strike by its landing emote
  (`'s limbs move slower!`), "root" finds every root by its message, without
  any hand-built effect taxonomy.
- **`level:25`** (also `level:20-30`) matches any class entry level; a **bare
  number** token matches level OR name (rank numerals).
- **`class:shm`** (abbr or full name) matches `classLevels`.
- **`type:`** with the facets the data can honestly answer: `buff`
  (Beneficial), `debuff` (Detrimental), `illusion`, `poison` (the poisons.ts
  roster + strike emotes), `seen` (usageCount > 0). NO invented effect
  taxonomy — "slow"/"heal" style discovery goes through message text, which is
  ground truth.

Catalog change (main, `spellDb.ts` `buildSpellCatalog`): add the three message
texts to `SpellCatalogEntry` as a prejoined lowercase `searchText` (name +
ranks + messages), built once server-side; the renderer's per-keystroke work
stays a substring test against one string per row.

## 2. Grouping (sections, in this order)

1. **From your fights** — observation-driven, at the top: the entries the
   log has actually seen (recency order, the existing sort), PLUS the
   observed-suggestion cards — today that is the poison-slow offer, moved
   here from the AlertsView strip. `PoisonSlowOffer` as a separate strip is
   REMOVED; the detector, dismissal set, and idempotent-create logic are
   reused verbatim inside this section. Rogue slows become a normal — but
   prioritized-when-observed — row in the same dialog as everything else.
   (The rank-upgrade strip in AlertsView is untouched: it upgrades EXISTING
   alerts and belongs beside the list it edits.)
2. **Ready-made sets** — the alert groups (incl. "Rogue slow poisons"),
   compacted from a panel of cards to one dense row of chips with counts;
   clicking stays one-click-create-missing.
3. **Spells** — sectioned by what the data states: **Buffs · Debuffs ·
   Illusions · Poisons** (a row appears once; class+level ride the row as
   chips, resolved classes' levels first). Sections are collapsible with
   counts in the header; a live search auto-expands matching sections and
   hides empty ones.

## 3. Compact

- Rows become single-line and dense: name (medium weight) · class-level chips
  (`SHM 25`, resolved classes first, overflow "+3") · template chips
  right-aligned; `size="small"`, tightened vertical padding, smaller type.
  Target: roughly double the rows per screen vs today.
- Section headers are slim sticky bars (title + count), not cards.
- The sets row and the From-your-fights cards share the same reduced density.
- Keep MAX_ROWS windowing and the fixed dialog height from the perf fix; no
  virtualization dependency.

## 4. Verification

- Pure tokenizer/matcher in shared or the feature dir with a truth table:
  each token form, AND-composition, level ranges, type facets, message-text
  hits ("slow" → Weakening Strike by emote).
- Catalog build test: searchText contains name/ranks/messages, lowercased.
- Poison-slow offer relocation: detector/dismissal tests keep passing;
  AlertsView no longer renders the strip; the dialog section offers/creates
  with the same ids (idempotent both entry points).
- Existing suggest-dialog tests updated for sections; e2e voice-alerts spec
  (which drives this dialog) must stay green — run that one spec.

## 5. Sequencing

After the suggest-panel perf fix lands (same files). Independent of
analytics A1 and perf HUD.
