// IPC: installed sound packs (local) and the og-packs registry (remote browse/preview/install).

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { logError } from '../errorLog'
import {
  fetchPackSounds,
  fetchPreviewSound,
  fetchRegistry,
  findRegistryPack,
  installPack,
  uninstallPack
} from '../packRegistry'
import { isSafePackId } from '../security'
import { getSoundData, listPacks } from '../sounds'
import { sendToMain } from '../windows'
import type { PackInstallProgress } from '../../shared/types'

export function registerSoundsIpc(): void {
  ipcMain.handle(IPC.listSoundPacks, () => listPacks())
  // packId names a DIRECTORY under the soundpack roots, so it is validated at the IPC
  // boundary (security.ts isSafePackId) rather than trusted because today's only caller
  // passes a listed pack's id. soundId is a KEY into that pack's manifest (never a path),
  // and sounds.ts already refuses a manifest entry that escapes the pack dir.
  ipcMain.handle(IPC.getSoundData, (_e, packId: string, soundId: string) =>
    isSafePackId(packId) ? getSoundData(packId, soundId) : null
  )

  // ---- sound-pack registry (openpeon.com integration, Task #29) ----
  ipcMain.handle(IPC.packsRegistry, (_e, force?: boolean) => fetchRegistry(force ?? false))
  ipcMain.handle(IPC.packsInstall, async (_e, name: string) => {
    const reg = await fetchRegistry(false)
    const pack = reg.packs.find((p) => p.name === name)
    if (!pack) return { ok: false as const, error: `pack '${name}' not in registry` }
    const emit = (p: PackInstallProgress): void => {
      sendToMain(IPC.onPackProgress, p)
    }
    try {
      await installPack(pack, emit)
      return { ok: true as const }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('main:packRegistry', { message: `install '${name}' failed`, err })
      emit({ name, phase: 'error', message })
      return { ok: false as const, error: message }
    }
  })
  ipcMain.handle(IPC.packsUninstall, (_e, name: string) => {
    const ok = uninstallPack(name)
    return ok ? { ok: true as const } : { ok: false as const, error: 'pack not found or not removable' }
  })
  // Preview a registry pack BEFORE install (Task #31): list its sounds / stream one.
  ipcMain.handle(IPC.packsPreviewList, async (_e, name: string) => {
    const pack = await findRegistryPack(name)
    if (!pack) return { sounds: [], error: `pack '${name}' not in registry` }
    return fetchPackSounds(pack)
  })
  ipcMain.handle(IPC.packsPreviewSound, async (_e, name: string, file: string) => {
    const pack = await findRegistryPack(name)
    if (!pack) return null
    return fetchPreviewSound(pack, file)
  })
}
