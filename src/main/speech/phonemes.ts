// phonemes.ts — text → the integer tokens Kokoro's encoder eats. PURE, no I/O, no worker.
//
// Kokoro is not a text model. It consumes a sequence of IPA PHONEME ids, so the pipeline is
// two hops, and this file owns the second one:
//
//     "Mesmerization"  ──espeak-ng──►  "mˌɛsmɚɹaɪzˈeɪʃən"  ──this file──►  [0, 55, 157, …, 0]
//                       (worker.ts)                          (tokenize)
//
// WHY THE VOCAB IS COPIED IN HERE rather than downloaded with the model. It is 115 entries
// and ~1 KB, it is fixed for the model architecture (v1.0's `tokenizer.json`), and pulling it
// over the network would mean a third pinned asset and a third failure mode for something
// that can simply be a constant. It was transcribed verbatim from
// onnx-community/Kokoro-82M-v1.0-ONNX `tokenizer.json` at commit
// 1939ad2a8e416c0acfeecc08a694d14ef25f2231 — the same table the reference JS port uses. The
// gaps in the id space (7, 8, 26–30, …) are real: they are the ids of phonemes the released
// model reserves but this vocabulary never emits, and closing them would silently re-map
// every phoneme after the gap.
//
// TOTAL OVER GARBAGE. Anything the table doesn't know is DROPPED, not substituted and not
// thrown over: espeak occasionally emits a diacritic outside Kokoro's set, and one unknown
// mark must cost that mark, never the whole utterance. This mirrors the model's own
// `tokenizer.json` normalizer, which is literally a "delete every character outside this
// set" replace.

/**
 * Kokoro v1.0's phoneme vocabulary. `$` (id 0) is the boundary token: every sequence is
 * wrapped `[0, …, 0]`, which is what the model's TemplateProcessing post-processor does.
 */
const KOKORO_VOCAB = new Map<string, number>([
  ['$', 0], [';', 1], [':', 2], [',', 3], ['.', 4], ['!', 5], ['?', 6], ['—', 9], ['…', 10],
  ['"', 11], ['(', 12], [')', 13], ['“', 14], ['”', 15], [' ', 16], ['̃', 17], ['ʣ', 18],
  ['ʥ', 19], ['ʦ', 20], ['ʨ', 21], ['ᵝ', 22], ['ꭧ', 23], ['A', 24], ['I', 25], ['O', 31],
  ['Q', 33], ['S', 35], ['T', 36], ['W', 39], ['Y', 41], ['ᵊ', 42], ['a', 43], ['b', 44],
  ['c', 45], ['d', 46], ['e', 47], ['f', 48], ['h', 50], ['i', 51], ['j', 52], ['k', 53],
  ['l', 54], ['m', 55], ['n', 56], ['o', 57], ['p', 58], ['q', 59], ['r', 60], ['s', 61],
  ['t', 62], ['u', 63], ['v', 64], ['w', 65], ['x', 66], ['y', 67], ['z', 68], ['ɑ', 69],
  ['ɐ', 70], ['ɒ', 71], ['æ', 72], ['β', 75], ['ɔ', 76], ['ɕ', 77], ['ç', 78], ['ɖ', 80],
  ['ð', 81], ['ʤ', 82], ['ə', 83], ['ɚ', 85], ['ɛ', 86], ['ɜ', 87], ['ɟ', 90], ['ɡ', 92],
  ['ɥ', 99], ['ɨ', 101], ['ɪ', 102], ['ʝ', 103], ['ɯ', 110], ['ɰ', 111], ['ŋ', 112],
  ['ɳ', 113], ['ɲ', 114], ['ɴ', 115], ['ø', 116], ['ɸ', 118], ['θ', 119], ['œ', 120],
  ['ɹ', 123], ['ɾ', 125], ['ɻ', 126], ['ʁ', 128], ['ɽ', 129], ['ʂ', 130], ['ʃ', 131],
  ['ʈ', 132], ['ʧ', 133], ['ʊ', 135], ['ʋ', 136], ['ʌ', 138], ['ɣ', 139], ['ɤ', 140],
  ['χ', 142], ['ʎ', 143], ['ʒ', 147], ['ʔ', 148], ['ˈ', 156], ['ˌ', 157], ['ː', 158],
  ['ʰ', 162], ['ʲ', 164], ['↓', 169], ['→', 171], ['↗', 172], ['↘', 173], ['ᵻ', 177]
])

/** The boundary token id (`$`). Prepended and appended to every sequence. */
export const KOKORO_BOUNDARY_TOKEN = 0

/**
 * Reconcile espeak-ng's output alphabet with Kokoro's.
 *
 * espeak and Kokoro's training data disagree on four symbols, and each substitution below is
 * the reference port's, not a guess:
 *   ʲ → j   espeak marks palatalization as a modifier; Kokoro spells it as a full glide.
 *   r → ɹ   espeak emits the alveolar TRILL for English /r/; English is an approximant, and
 *           `r` is in Kokoro's vocab (id 60) so this would otherwise be silently wrong
 *           rather than dropped — the most important of the four.
 *   x → k   the velar fricative appears in espeak's loanword handling; Kokoro's English
 *           voices have no such phone.
 *   ɬ → l   the Welsh lateral fricative, likewise.
 *
 * Everything else espeak can emit either exists in the vocab or is dropped by `tokenize`.
 */
export function normalizeEspeakPhonemes(phonemes: string): string {
  return phonemes.replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
}

/**
 * Phoneme string → the model's `tokens` input, boundary-wrapped.
 *
 * Iterated by CODE POINT (`for…of`), not by UTF-16 unit: the vocab is full of astral-adjacent
 * IPA and combining marks, and indexing by `[i]` would split them into halves that match
 * nothing. Truncation is at `maxTokens` PHONEMES (the boundary pair is extra) because the
 * model's style table is indexed by phoneme count — see `styleVectorFor`.
 */
export function tokenizePhonemes(phonemes: string, maxTokens: number): number[] {
  const tokens: number[] = [KOKORO_BOUNDARY_TOKEN]
  for (const ch of phonemes) {
    const id = KOKORO_VOCAB.get(ch)
    if (id === undefined) continue
    tokens.push(id)
    if (tokens.length - 1 >= maxTokens) break
  }
  tokens.push(KOKORO_BOUNDARY_TOKEN)
  return tokens
}

/** How many PHONEME tokens a sequence carries (i.e. excluding the two boundary tokens). */
export function phonemeCount(tokens: readonly number[]): number {
  return Math.max(tokens.length - 2, 0)
}
