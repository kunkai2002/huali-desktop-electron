import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

interface NotificationPayload {
  title: string
  body: string
  id: string
}

interface ShellCapabilities {
  notify: boolean
  tray: boolean
  autoUpdate: boolean
  deepLink: boolean
}

interface UpdateAvailableInfo {
  version: string
}

interface HualiShell {
  getVersion(): Promise<string>
  getCapabilities(): Promise<ShellCapabilities>
  openExternal(url: string): Promise<void>
  setLoginItem(openAtLogin: boolean): Promise<void>
  onNotification(callback: (payload: NotificationPayload) => void): () => void
  onDeepLink(callback: (url: string) => void): () => void
  onUpdateAvailable(callback: (info: UpdateAvailableInfo) => void): () => void
}

const hualiShell: HualiShell = {
  getVersion: (): Promise<string> =>
    ipcRenderer.invoke('shell:getVersion'),

  getCapabilities: (): Promise<ShellCapabilities> =>
    ipcRenderer.invoke('shell:capabilities'),

  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:openExternal', url),

  setLoginItem: (openAtLogin: boolean): Promise<void> =>
    ipcRenderer.invoke('shell:setLoginItem', openAtLogin),

  onNotification: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: NotificationPayload): void => {
      callback(payload)
    }
    ipcRenderer.on('shell:notification', listener)
    return (): void => { ipcRenderer.removeListener('shell:notification', listener) }
  },

  onDeepLink: (callback) => {
    const listener = (_event: IpcRendererEvent, url: string): void => { callback(url) }
    ipcRenderer.on('shell:deepLink', listener)
    return (): void => { ipcRenderer.removeListener('shell:deepLink', listener) }
  },

  onUpdateAvailable: (callback) => {
    const listener = (_event: IpcRendererEvent, info: UpdateAvailableInfo): void => { callback(info) }
    ipcRenderer.on('shell:updateAvailable', listener)
    return (): void => { ipcRenderer.removeListener('shell:updateAvailable', listener) }
  },
}

contextBridge.exposeInMainWorld('hualiShell', hualiShell)

export type { HualiShell, NotificationPayload, ShellCapabilities, UpdateAvailableInfo }
