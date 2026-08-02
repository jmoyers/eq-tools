import { EventEmitter } from 'events'
import { open, stat } from 'fs/promises'
import chokidar, { type FSWatcher } from 'chokidar'

export interface TailerOptions {
  /** If true, read the whole file from the start; otherwise start at EOF. */
  fromStart?: boolean
  /**
   * Explicit byte offset to resume from (takes precedence over `fromStart`).
   * Used for a gapless handoff from the initial scan: the scan reports the byte
   * offset it stopped at and the tailer picks up exactly there, so lines the game
   * appended during the scan are read (not skipped) and none are double-read.
   */
  startOffset?: number
  /** Poll interval in ms (polling is more reliable for game-appended logs). */
  pollInterval?: number
}

/**
 * Tails a single growing text file. Tracks a byte offset, reads only appended
 * bytes on each change, and emits one 'line' event per complete raw line (the
 * caller parses it — the Tailer stays purely byte-level). Survives log
 * rotation/truncation by resetting the offset when the file shrinks.
 */
export class Tailer extends EventEmitter {
  private readonly path: string
  private readonly fromStart: boolean
  private readonly startOffset?: number
  private readonly pollInterval: number
  private offset = 0
  private leftover = ''
  private watcher?: FSWatcher
  private reading = false
  private pending = false

  constructor(path: string, opts: TailerOptions = {}) {
    super()
    this.path = path
    this.fromStart = opts.fromStart ?? false
    this.startOffset = opts.startOffset
    this.pollInterval = opts.pollInterval ?? 400
  }

  async start(): Promise<void> {
    try {
      const s = await stat(this.path)
      if (this.startOffset != null) {
        // Resume from the scan's handoff point. Clamp to current size in case the
        // file shrank (rotation/truncation) between scan and tail start.
        this.offset = Math.min(this.startOffset, s.size)
      } else {
        this.offset = this.fromStart ? 0 : s.size
      }
    } catch {
      this.offset = this.startOffset ?? 0
    }

    this.watcher = chokidar.watch(this.path, {
      persistent: true,
      usePolling: true,
      interval: this.pollInterval,
      awaitWriteFinish: false
    })

    this.watcher.on('add', () => this.scheduleRead())
    this.watcher.on('change', () => this.scheduleRead())
    this.watcher.on('error', (err) => this.emit('error', err))

    // Read immediately when reading from start or resuming from a scan offset, so
    // any bytes appended during the scan are picked up without waiting for a poll.
    if (this.fromStart || this.startOffset != null) this.scheduleRead()
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = undefined
  }

  /** Coalesce rapid change events into sequential reads. */
  private scheduleRead(): void {
    if (this.reading) {
      this.pending = true
      return
    }
    void this.readNew()
  }

  private async readNew(): Promise<void> {
    this.reading = true
    try {
      const s = await stat(this.path)
      if (s.size < this.offset) {
        // File truncated/rotated — restart from the beginning.
        this.offset = 0
        this.leftover = ''
      }
      if (s.size > this.offset) {
        const fh = await open(this.path, 'r')
        try {
          const len = s.size - this.offset
          const buf = Buffer.alloc(len)
          await fh.read(buf, 0, len, this.offset)
          this.offset = s.size
          this.consume(buf.toString('utf8'))
        } finally {
          await fh.close()
        }
      }
    } catch (err) {
      this.emit('error', err)
    } finally {
      this.reading = false
      if (this.pending) {
        this.pending = false
        this.scheduleRead()
      }
    }
  }

  private consume(chunk: string): void {
    const data = this.leftover + chunk
    const lines = data.split(/\r?\n/)
    // The last element is an incomplete line (no trailing newline yet).
    this.leftover = lines.pop() ?? ''
    for (const raw of lines) {
      if (!raw) continue
      this.emit('line', raw)
    }
  }
}

export interface Tailer {
  on(event: 'line', listener: (raw: string) => void): this
  on(event: 'error', listener: (err: unknown) => void): this
  emit(event: 'line', raw: string): boolean
  emit(event: 'error', err: unknown): boolean
}
