// gen-sounds.mts — synthesize the bundled "default" sound pack as original WAVs,
// with ZERO dependencies (raw PCM → RIFF/WAVE bytes). Run:
//
//   export PATH="/c/Program Files/nodejs:$PATH"   # this machine
//   npx tsx scripts/gen-sounds.mts
//
// It writes resources/soundpacks/default/{victory,warning,chime,horn}.wav plus a
// manifest.json. These are ORIGINAL tones — we deliberately do NOT ship any
// copyrighted game audio (e.g. the Final Fantasy victory fanfare). `victory` is a
// cheerful ascending brass-like arpeggio *in the spirit of* a JRPG win jingle; a
// user who wants the real thing can drop their own file into a user pack (see the
// Alerts view hint / AGENTS.md).
//
// This script is committed and permanent (the generated .wav assets are the
// bundled pack). Re-run it to regenerate the assets after editing a voice.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SAMPLE_RATE = 44100

/** A mono 16-bit PCM buffer we accumulate float samples into, then serialize. */
class Voice {
  private data: number[] = []
  constructor(readonly sampleRate = SAMPLE_RATE) {}

  get lengthSec(): number {
    return this.data.length / this.sampleRate
  }

  /** Append `sec` seconds of silence. */
  silence(sec: number): void {
    const n = Math.round(sec * this.sampleRate)
    for (let i = 0; i < n; i++) this.data.push(0)
  }

  /**
   * Append a tone: base frequency `freq` for `sec` seconds at peak `gain` (0..1),
   * with a short attack + exponential-ish decay envelope so notes sound plucked
   * rather than clicky. `harmonics` adds integer overtones for a brass-ish timbre;
   * `vibrato` adds gentle pitch wobble.
   */
  tone(
    freq: number,
    sec: number,
    opts: {
      gain?: number
      harmonics?: number[] // relative amplitudes of overtones [h1, h2, ...]
      attack?: number
      release?: number
      vibrato?: number // Hz depth
    } = {}
  ): void {
    const { gain = 0.5, harmonics = [1, 0.35, 0.18, 0.08], attack = 0.008, release = 0.12 } = opts
    const vib = opts.vibrato ?? 0
    const n = Math.round(sec * this.sampleRate)
    for (let i = 0; i < n; i++) {
      const t = i / this.sampleRate
      // Envelope: linear attack, then smooth exponential decay to the release tail.
      let env: number
      const rel = Math.min(release, sec * 0.5)
      if (t < attack) env = t / attack
      else if (t > sec - rel) env = Math.max(0, (sec - t) / rel)
      else env = Math.exp(-1.7 * (t - attack)) * 0.6 + 0.4
      const wobble = vib ? 1 + (vib / freq) * Math.sin(2 * Math.PI * 5.5 * t) : 1
      let s = 0
      let hn = 1
      for (const amp of harmonics) {
        s += amp * Math.sin(2 * Math.PI * freq * hn * wobble * t)
        hn++
      }
      // Normalize by harmonic count-ish so gain stays predictable.
      s /= harmonics.reduce((a, b) => a + b, 0)
      this.data.push(s * env * gain)
    }
  }

  /** Layer a second tone on top of the LAST `sec` seconds (for chords). */
  chordTail(freq: number, sec: number, gain = 0.35): void {
    const n = Math.round(sec * this.sampleRate)
    const start = Math.max(0, this.data.length - n)
    for (let i = 0; i < n && start + i < this.data.length; i++) {
      const t = i / this.sampleRate
      const env = Math.max(0, (sec - t) / sec)
      this.data[start + i] += Math.sin(2 * Math.PI * freq * t) * env * gain
    }
  }

  /** Serialize to a 16-bit mono PCM WAV (RIFF) Buffer, with soft clipping. */
  toWav(): Buffer {
    const n = this.data.length
    const bytesPerSample = 2
    const buf = Buffer.alloc(44 + n * bytesPerSample)
    // RIFF header
    buf.write('RIFF', 0, 'ascii')
    buf.writeUInt32LE(36 + n * bytesPerSample, 4)
    buf.write('WAVE', 8, 'ascii')
    // fmt chunk
    buf.write('fmt ', 12, 'ascii')
    buf.writeUInt32LE(16, 16) // PCM chunk size
    buf.writeUInt16LE(1, 20) // audio format = PCM
    buf.writeUInt16LE(1, 22) // channels = 1
    buf.writeUInt32LE(this.sampleRate, 24)
    buf.writeUInt32LE(this.sampleRate * bytesPerSample, 28) // byte rate
    buf.writeUInt16LE(bytesPerSample, 32) // block align
    buf.writeUInt16LE(16, 34) // bits per sample
    // data chunk
    buf.write('data', 36, 'ascii')
    buf.writeUInt32LE(n * bytesPerSample, 40)
    for (let i = 0; i < n; i++) {
      // soft clip via tanh so overlapping chord tails don't hard-distort
      const clipped = Math.tanh(this.data[i] * 1.1)
      const v = Math.max(-1, Math.min(1, clipped))
      buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
    }
    return buf
  }
}

// Equal-tempered note frequencies (A4 = 440).
const NOTE: Record<string, number> = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, C6: 1046.5
}

/** victory — a triumphant ~3.4s ascending brass arpeggio + final chord (original). */
function victory(): Buffer {
  const v = new Voice()
  const brass = { harmonics: [1, 0.5, 0.32, 0.18, 0.1], gain: 0.55, vibrato: 6, release: 0.1 }
  // Quick triplet pickup then an ascending major arpeggio, landing on a bright chord.
  const seq: [string, number][] = [
    ['G4', 0.16], ['G4', 0.16], ['G4', 0.16],
    ['C5', 0.34], ['E5', 0.28], ['G5', 0.28], ['C6', 0.5]
  ]
  for (const [note, dur] of seq) v.tone(NOTE[note], dur, brass)
  // Sustain a C-major chord on the final note for a fanfare finish.
  v.tone(NOTE['C6'], 1.0, { ...brass, gain: 0.5, release: 0.7 })
  v.chordTail(NOTE['E5'], 1.0, 0.3)
  v.chordTail(NOTE['G5'], 1.0, 0.3)
  v.silence(0.05)
  return v.toWav()
}

/** warning — urgent two-tone ~0.8s (for a charm break). High/low alternation. */
function warning(): Buffer {
  const v = new Voice()
  const beep = { harmonics: [1, 0.2], gain: 0.6, attack: 0.004, release: 0.05 }
  v.tone(NOTE['A5'], 0.18, beep)
  v.silence(0.03)
  v.tone(NOTE['E5'], 0.18, beep)
  v.silence(0.03)
  v.tone(NOTE['A5'], 0.18, beep)
  v.silence(0.03)
  v.tone(NOTE['E5'], 0.2, beep)
  return v.toWav()
}

/** chime — a soft single blip (~0.4s), gentle sine bell. */
function chime(): Buffer {
  const v = new Voice()
  v.tone(NOTE['C6'], 0.4, { harmonics: [1, 0.15], gain: 0.4, attack: 0.006, release: 0.3 })
  v.chordTail(NOTE['G5'], 0.4, 0.15)
  return v.toWav()
}

/** horn — a low alert (~0.9s), fat low-brass drone with a small swell. */
function horn(): Buffer {
  const v = new Voice()
  v.tone(110, 0.45, { harmonics: [1, 0.6, 0.4, 0.25], gain: 0.6, attack: 0.03, release: 0.15, vibrato: 3 })
  v.tone(146.83, 0.45, { harmonics: [1, 0.6, 0.4, 0.25], gain: 0.6, attack: 0.03, release: 0.25, vibrato: 3 }) // D3
  return v.toWav()
}

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'resources', 'soundpacks', 'default')
mkdirSync(outDir, { recursive: true })

const files: Array<[string, Buffer]> = [
  ['victory.wav', victory()],
  ['warning.wav', warning()],
  ['chime.wav', chime()],
  ['horn.wav', horn()]
]
for (const [name, buf] of files) {
  writeFileSync(join(outDir, name), buf)
  console.log(`wrote ${name}: ${buf.length} bytes (RIFF=${buf.toString('ascii', 0, 4)})`)
}

const manifest = {
  id: 'default',
  name: 'Default (built-in)',
  sounds: {
    victory: { file: 'victory.wav', label: 'Victory fanfare' },
    warning: { file: 'warning.wav', label: 'Warning (two-tone)' },
    chime: { file: 'chime.wav', label: 'Chime' },
    horn: { file: 'horn.wav', label: 'Alert horn' }
  }
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`wrote manifest.json → ${outDir}`)
