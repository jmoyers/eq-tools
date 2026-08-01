import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { resolveActiveCharacter } from './log/config'
import { Tailer } from './log/Tailer'
import { matchLoot } from './log/parse'
import { loadInventory } from './inventory/parseInventory'
import { addLiveLoot, getProgress, resetLiveLoot, setInventory, setQuestComplete } from './store'
import type { CharacterRef } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tailer: Tailer | null = null
let character: CharacterRef | null = null

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

function startTailing(): void {
  character = resolveActiveCharacter()
  if (!character) {
    console.warn('[eq-tools] No EQ log found; log tailing disabled.')
    return
  }
  console.log(`[eq-tools] Tailing ${character.name}@${character.server}: ${character.logPath}`)
  tailer = new Tailer(character.logPath, { fromStart: false })
  tailer.on('line', (line) => {
    mainWindow?.webContents.send(IPC.onLine, line)
    const loot = matchLoot(line)
    if (loot) {
      addLiveLoot(loot.item)
      mainWindow?.webContents.send(IPC.onLoot, loot)
    }
  })
  tailer.on('error', (err) => console.error('[eq-tools] tailer error', err))
  void tailer.start()
}

function registerIpc(): void {
  ipcMain.handle(IPC.getCharacter, () => character)
  ipcMain.handle(IPC.getProgress, () => getProgress())
  ipcMain.handle(IPC.reloadInventory, () => {
    const res = loadInventory(character?.name)
    if (!res) return { ok: false as const, error: 'No *-Inventory.txt found in the EQ folder.' }
    setInventory(res.counts, { path: res.path, loadedAt: res.loadedAt })
    return { ok: true as const, path: res.path, loadedAt: res.loadedAt, progress: getProgress() }
  })
  ipcMain.handle(IPC.setQuestComplete, (_e, questKey: string, complete: boolean) =>
    setQuestComplete(questKey, complete)
  )
  ipcMain.handle(IPC.resetLiveLoot, () => resetLiveLoot())
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  startTailing()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void tailer?.stop()
  if (process.platform !== 'darwin') app.quit()
})
