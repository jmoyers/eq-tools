import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { characterId, listCharacters, parseLogName, resolveActiveCharacter } from './log/config'
import { Tailer } from './log/Tailer'
import { newLogState, processLine, type LogState } from './log/process'
import { scanLog } from './log/scanHistory'
import { loadInventory } from './inventory/parseInventory'
import {
  getActiveLogPath,
  getProgress,
  setActiveLogPath,
  setInventory,
  setQuestComplete
} from './store'
import type { CharacterRef, KillMap, LevelEvent, LootEvent, TurnInEvent } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tailer: Tailer | null = null
let character: CharacterRef | null = null

/** Log-derived state for the active character, rebuilt on launch + appended live. */
let lootHistory: LootEvent[] = []
let turnIns: TurnInEvent[] = []
let kills: KillMap = {}
let levels: LevelEvent[] = []
let logState: LogState = newLogState()

function activeCharId(): string {
  return character ? characterId(character) : 'none'
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'EQ Legends Companion',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Resolve which character to track on launch: last selected, else most recent. */
function resolveInitialCharacter(): CharacterRef | null {
  const savedPath = getActiveLogPath()
  if (savedPath) {
    const ref = parseLogName(savedPath)
    if (ref) return ref
  }
  return resolveActiveCharacter()
}

/** Point the tailer + loot history at a character (used at startup and on switch). */
async function tailCharacter(ref: CharacterRef): Promise<void> {
  await tailer?.stop()
  tailer = null
  character = ref
  setActiveLogPath(ref.logPath)
  console.log(`[eq-tools] Tailing ${ref.name}@${ref.server}: ${ref.logPath}`)

  // Scan the whole log first: loot (with mob + zone), turn-ins, and kills.
  const scan = await scanLog(ref.logPath)
  lootHistory = scan.loot
  turnIns = scan.turnIns
  kills = scan.kills
  levels = scan.levels
  logState = newLogState()
  console.log(
    `[eq-tools] Loaded ${lootHistory.length} loot, ${turnIns.length} turn-ins, ${
      Object.keys(kills).length
    } mobs, ${levels.length} level-ups.`
  )

  tailer = new Tailer(ref.logPath, { fromStart: false })
  tailer.on('line', (line) => {
    mainWindow?.webContents.send(IPC.onLine, line)
    processLine(line, logState, {
      onLoot: (loot) => {
        lootHistory.push(loot)
        mainWindow?.webContents.send(IPC.onLoot, loot)
      },
      onTurnIn: (t) => {
        turnIns.push(t)
        mainWindow?.webContents.send(IPC.onTurnIn, t)
      },
      onKill: (mob, tier, ts) => {
        const k = (kills[mob] ??= { count: 0, bestTier: 0, lastTs: 0 })
        k.count += 1
        k.bestTier = Math.max(k.bestTier, tier)
        k.lastTs = Math.max(k.lastTs, ts)
      },
      onLevelUp: (level, ts) => {
        levels.push({ ts, level })
        mainWindow?.webContents.send(IPC.onLevel, { ts, level })
      }
    })
  })
  tailer.on('error', (err) => console.error('[eq-tools] tailer error', err))
  void tailer.start()
}

async function startTailing(): Promise<void> {
  const ref = resolveInitialCharacter()
  if (!ref) {
    console.warn('[eq-tools] No EQ log found; log tailing disabled.')
    return
  }
  await tailCharacter(ref)
}

function registerIpc(): void {
  ipcMain.handle(IPC.getCharacter, () => character)
  ipcMain.handle(IPC.listCharacters, () => listCharacters())
  ipcMain.handle(IPC.setCharacter, async (_e, logPath: string) => {
    const ref = listCharacters().find((c) => c.logPath === logPath) ?? parseLogName(logPath)
    if (!ref) return { ok: false as const, error: 'Character log not found.' }
    await tailCharacter(ref)
    return { ok: true as const, character: ref }
  })
  ipcMain.handle(IPC.getProgress, () => getProgress(activeCharId()))
  ipcMain.handle(IPC.reloadInventory, () => {
    const res = loadInventory(character?.name)
    if (!res) return { ok: false as const, error: 'No *-Inventory.txt found in the EQ folder.' }
    setInventory(activeCharId(), res.counts, { path: res.path, loadedAt: res.loadedAt })
    return { ok: true as const, path: res.path, loadedAt: res.loadedAt, progress: getProgress(activeCharId()) }
  })
  ipcMain.handle(IPC.setQuestComplete, (_e, questKey: string, complete: boolean) =>
    setQuestComplete(activeCharId(), questKey, complete)
  )
  ipcMain.handle(IPC.getLootHistory, () => lootHistory)
  ipcMain.handle(IPC.getKills, () => kills)
  ipcMain.handle(IPC.getTurnIns, () => turnIns)
  ipcMain.handle(IPC.getLevels, () => levels)
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  void startTailing()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void tailer?.stop()
  if (process.platform !== 'darwin') app.quit()
})
