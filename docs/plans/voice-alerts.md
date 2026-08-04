# Voice alerts — TTS for the alerts module

Design by the integrator (Fable), 2026-08-04. Scope per the owner: alert-module
speech only — a custom phrase, the first word of the spell, a few other sensical
options. App-wide announcements are a NAMED SEAM, deliberately deferred.

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Two engine tiers: `system` (Chromium `speechSynthesis` → Windows SAPI voices, zero download, instant) and `kokoro` (Kokoro-82M ONNX, Apache 2.0, 54 voices, CPU faster-than-real-time). Chatterbox (MIT, GPU) is a named seam, not built. | The system tier ships value with no download; Kokoro is the real experience. Licensing vetted: the natural-sounding alternatives (XTTS-v2, F5 weights, Fish, ChatTTS) are non-commercial. |
| D2 | Kokoro inference runs in a **worker_thread in main** — never on the main thread. | Main runs the log pipeline; a 200ms–2s synth on the tailer's thread is a live-meter stall. |
| D3 | **Synthesize once, cache forever**: wav keyed by `sha256(voiceId + '\0' + text)` in `<userData>/speech-cache/`, atomic write (temp+rename), no TTL. | Alert phrases are static strings — the imageCache precedent. Runtime cost after first synth is file playback. |
| D4 | Model + voices **self-provision on enable** (not at startup) from a pinned release with sha256 verification, gitignored — the sound-pack pattern. Never in the installer; never downloads in the e2e channel. | ~90MB quantized model is not installer material; off-by-default features must not spend a stranger's bandwidth. |
| D5 | Speech is a per-alert **audio action alongside sound**: `sound | speech | both` (both = sound first, speech queued after). Cooldowns unchanged. | The owner framed speech as an option, not a replacement; a raid alert may want the airhorn AND the words. |
| D6 | Store shapes change ⇒ **migration in the same commit** (settings-migration LAW). | AlertDef gains `speech?`; a new `voice` prefs blob lands in the store. |

## 1. What an alert says (the content model)

```ts
// src/shared/alertTypes.ts (additive)
export type SpeechMode = 'custom' | 'alertName' | 'spellName' | 'spellFirstWord'
export interface AlertSpeech {
  mode: SpeechMode
  /** required iff mode === 'custom'; <= MAX_SPEECH_CHARS (120). */
  phrase?: string
  /** override; absent = the global default voice. */
  voiceId?: string
  /** 'sound' | 'speech' | 'both' lives on the def as `audio` (default 'sound'). */
}
```

Resolution is a PURE function `speechTextFor(def, firing): string | null` in
`src/shared/speechText.ts`:
- `custom` → the phrase verbatim.
- `alertName` → the def's display name.
- `spellName` → the triggering spell's LINE name, rank-stripped via the existing
  canon key machinery ("Mesmerization III" → "Mesmerization") — ranks are noise
  aloud.
- `spellFirstWord` → first word of the rank-stripped line name ("Swift Like the
  Wind" → "Swift"). The owner's headline ask: shortest possible utterance.
- Spell modes on a firing with NO spell context (e.g. an out-of-range group def)
  → fall back to `alertName`, never silence and never a guess. Where the firing
  context lives: the alert evaluation already carries the matched event; the
  spell name rides the firing payload the renderer receives (verify the exact
  shape in modules/alerts.ts; extend the firing payload additively if it only
  carries the def id today).

## 2. Preferences

`voice` blob in the store (migration required): `{ enabled: false, engine:
'system' | 'kokoro', voiceId: string | null, rate: 1.0, volume: 1.0 }`.
Preferences gains a **Voice** section: enable toggle, engine picker (kokoro row
shows install state + size before download), voice picker with a ▶ preview
("Alert preview"), rate/volume sliders. Speech obeys the existing alert
mute/volume master switches — a muted alerts module speaks nothing.

## 3. Engine plumbing

- `system` tier: renderer-side `speechSynthesis` directly (it lives in Chromium;
  no IPC needed). Voice list from `getVoices()`; utterance rate/volume from
  prefs. No caching (synthesis is instant and free).
- `kokoro` tier: renderer asks `speech:say {text, voiceId}` → main checks the
  wav cache → miss ⇒ worker_thread synth (onnxruntime-node) → cache write →
  returns `eqspeech://<hash>` served by a protocol handler on the default
  session (the eqimg:// precedent, read-only from the cache dir) → renderer
  plays through the existing alert audio element path. In-flight dedupe per
  hash (N alerts can't double-synth).
- Provisioning: `speech:install` streams the pinned model+voices with progress
  events to the prefs UI; sha256-verified, atomic, resumable, additive.
  PACKAGING RISK (own verification step): onnxruntime-node is a native module —
  verify prebuilt binaries load under electron-builder (asarUnpack), that
  `.npmrc ignore-scripts=true` doesn't strand it (it ships prebuilds; verify),
  and that `npm run dist:dir` + a launch smoke test pass before the wave closes.

## 4. Alert editor + suggestions

The alert editor gains a Speech block: audio action (sound/speech/both), mode
select with live-resolved preview text, phrase field (custom only, char cap),
voice override, ▶ test button. Suggestion groups MAY carry a default speech
config later — not this wave.

## 5. Waves

- **W1 — model + content (main/shared)**: types, `speechText.ts` + tests, store
  migration (voice prefs + AlertDef.speech), firing-payload spell context,
  `speech:say`/`speech:voices`/`speech:install` IPC stubs returning
  honest not-installed states. No engine yet.
- **W2 — system tier + UI (renderer)**: Preferences Voice section, alert editor
  Speech block, the system engine end-to-end, `speechTextFor` wired, e2e (dialog
  renders, a test-fire with speech mode 'alertName' invokes the engine seam —
  assert via a hook, not audio).
- **W3 — Kokoro tier**: worker + provisioning + cache + protocol + packaging
  verification (dist:dir smoke). Sequenced AFTER W1/W2 land.
- **Named seams, not designed**: app-wide announcements (boss defeat, quest
  complete app-signals speaking); Chatterbox engine; per-suggestion-group
  speech defaults.

Verification per wave: typecheck + lint (zero ratchet) + npm test (+ e2e where
renderer changes; + dist:dir smoke in W3). Migration fixtures same-commit.
