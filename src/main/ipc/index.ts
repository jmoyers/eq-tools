// ============================================================================
// ipc/ — the main process's IPC surface, one module per domain.
// ============================================================================
//
// `registerIpc()` is called ONCE from the composition root, inside `app.whenReady()` and
// BEFORE the first window is created, so no renderer can ever invoke a channel that has not
// been registered yet.
//
// The domains are independent: `ipcMain.handle`/`.on` key off the channel name, so the order
// of the calls below carries no semantics (unlike module registration order, which is bus
// delivery order — see pipeline.ts). It is kept in the order the handlers were originally
// written purely so the surface reads the same way it always did.
//
// Every channel name lives in `src/shared/ipc.ts`; nothing here invents one.

import { registerAlertsIpc } from './alerts'
import { registerCharacterIpc } from './character'
import { registerKnowledgeIpc } from './knowledge'
import { registerShareIpc } from './share'
import { registerSoundsIpc } from './sounds'
import { registerWindowIpc } from './windowControls'
import { registerWorldIpc } from './world'

export function registerIpc(): void {
  registerCharacterIpc()
  registerWorldIpc()
  registerAlertsIpc()
  registerShareIpc()
  registerSoundsIpc()
  registerKnowledgeIpc()
  registerWindowIpc()
}
