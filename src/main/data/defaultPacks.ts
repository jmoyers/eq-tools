// defaultPacks.ts — the imported CC-BY-NC voice packs (peon, sc_marine) that the
// app ships with, defined ONCE and shared by:
//   - scripts/fetch-packs.mts (dev: writes them into resources/soundpacks/ for a
//     source build), and
//   - src/main/provisionPacks.ts (runtime: silently downloads any missing one into
//     <userData>/soundpacks/ on startup, so a CI-built installer — which ships
//     WITHOUT the gitignored packs — still has the sounds the seeded alerts need).
//
// Source: github.com/PeonPing/og-packs, CC-BY-NC-4.0. The soundId per source file is
// FIXED here so the generated manifest byte-matches across both code paths — seeded
// alerts reference these ids (e.g. the seeded charm-break alert → peon/error-notthatorc),
// so the id map must stay stable no matter where the pack is provisioned.

/** Base raw-content URL for the og-packs source repo (no trailing slash). */
export const OG_PACKS_BASE = 'https://raw.githubusercontent.com/PeonPing/og-packs/main'

/**
 * Source-filename → our stable soundId, per pack. Keyed by basename so it's
 * independent of any `sounds/` prefix. These reproduce the committed manifests exactly.
 */
export const PACK_ID_MAP: Record<string, Record<string, string>> = {
  peon: {
    'PeonReady1.wav': 'ready',
    'PeonWhat4.wav': 'need-doing',
    'PeonYes1.wav': 'ack-cando',
    'PeonYes2.wav': 'ack-happy',
    'PeonYes4.wav': 'ack-okie',
    'PeonYesAttack3.wav': 'ack-try',
    'PeonWorkComplete.wav': 'complete-work',
    'PeonYes3.wav': 'complete-workwork',
    'PeonAngry4.wav': 'error-notthatorc',
    'PeonDeath.wav': 'error-ugh',
    'PeonWhat2.wav': 'input-hmm',
    'PeonWhat3.wav': 'input-whatyouwant',
    'PeonWhat1.wav': 'input-yes',
    'PeonWarcry1.wav': 'limit-whynot',
    'PeonAngry1.wav': 'spam-whaaat',
    'PeonAngry2.wav': 'spam-leavemealone',
    'PeonAngry3.wav': 'spam-notime'
  },
  sc_marine: {
    'YouWannaPieceOfMe.mp3': 'start-pieceofme',
    'GoGoGo.mp3': 'ack-gogogo',
    'LetsMove.mp3': 'ack-letsmove',
    'Outstanding.mp3': 'ack-outstanding',
    'RockAndRoll.mp3': 'ack-rockandroll',
    'JackedUpAndGoodToGo.mp3': 'complete-jackedup',
    'GimmeSomethingToShoot.mp3': 'complete-shoot',
    'Death1.mp3': 'error-ugh',
    'Death2.mp3': 'error-ahh',
    'Commander.mp3': 'input-commander',
    'StandinBy.mp3': 'input-standinby',
    'WeGottaMove.mp3': 'limit-wegottamove',
    'GiveMeOrders.mp3': 'spam-orders',
    'HesWhacked.mp3': 'spam-whacked',
    'FragCommander.mp3': 'spam-frag',
    'GetOutOfOutfit.mp3': 'spam-outfit'
  }
}

/** Human display names for each pack (matches committed manifests). */
export const PACK_NAME: Record<string, string> = {
  peon: 'Orc Peon',
  sc_marine: 'StarCraft Marine'
}

/** The pack ids the app ships with (and provisions on startup if missing). */
export const DEFAULT_PACK_IDS = Object.keys(PACK_ID_MAP)
