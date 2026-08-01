import { EventEmitter } from 'events'
import { open, stat } from 'fs/promises'
import chokidar, { type FSWatcher } from 'chokidar'
import { parseLine } from './parse'
import type { LogLine } from '../../shared/types'

export interface TailerOptions {
  /** If true, read the whole file from the start; otherwise start at EOF. */
  fromStart?: boolean
  /** Poll interval in ms (polling is more reliable for game-appended logs). */
  pollInterval?: number
}

/**
 * Tails a single growing text file. Tracks a byte offset, reads only appended
 * bytes on each change, and emits one 'line' event per complete parsed line.
 * Survives log rotation/truncation by resetting the offset when the file shrinks.
 */
export class Tailer extends EventEmitter {
  private readonly path: string
  private readonly fromStart: boolean
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
    this.pollInterval = opts.pollInterval ?? 400
  }

  async start(): Promise<void> {
    try {
      const s = await stat(this.path)
      this.offset = this.fromStart ? 0 : s.size
    } catch {
      this.offset = 0
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

    if (this.fromStart) this.scheduleRead()
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
      const parsed = parseLine(raw)
      if (parsed) this.emit('line', parsed)
    }
  }
}

export interface Tailer {
  on(event: 'line', listener: (line: LogLine) => void): this
  on(event: 'error', listener: (err: unknown) => void): this
  emit(event: 'line', line: LogLine): boolean
  emit(event: 'error', err: unknown): boolean
}
