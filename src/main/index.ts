import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { characterId, listCharacters, parseLogName, resolveActiveCharacter } from './log/config'
import { Tailer } from './log/Tailer'
import { getRuleset } from './log/rulesets'
import { scanLootHistory } from './log/scanHistory'
import { loadInventory } from './inventory/parseInventory'
import {
  getActiveLogPath,
  getProgress,
  setActiveLogPath,
  setInventory,
  setQuestComplete
} from './store'
import type { CharacterRef, LootEvent } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tailer: Tailer | null = null
let character: CharacterRef | null = null

/** Complete loot record, rebuilt from the log each launch and appended live. */
let lootHistory: LootEvent[] = []

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

  // Build the full loot history from the existing log before tailing new lines.
  lootHistory = await scanLootHistory(ref.logPath)
  console.log(`[eq-tools] Loaded ${lootHistory.length} historical loot events.`)

  const { matchLoot } = getRuleset()
  tailer = new Tailer(ref.logPath, { fromStart: false })
  tailer.on('line', (line) => {
    mainWindow?.webContents.send(IPC.onLine, line)
    const loot = matchLoot(line)
    if (loot) {
      lootHistory.push(loot)
      mainWindow?.webContents.send(IPC.onLoot, loot)
    }
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
