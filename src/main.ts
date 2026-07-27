import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
} from 'electron';
import type { BrowserWindowConstructorOptions, WebContents } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import Store from 'electron-store';
import path from 'path';
import fs from 'fs';

const APP_URL = 'https://huali-structure-app.huali-tech.workers.dev';
const APP_HOST = 'huali-structure-app.huali-tech.workers.dev';
const PROTOCOL = 'huali';
const UPDATE_CHECK_DELAY_MS = 3000;

log.transports.file.level = 'info';
log.transports.console.level = 'info';

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

interface StoreSchema {
  windowBounds: WindowBounds;
}

const store = new Store<StoreSchema>({
  defaults: {
    windowBounds: { width: 1280, height: 800, isMaximized: false },
  },
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let pendingDeepLink: string | null = extractDeepLink(process.argv);

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function isAllowedUrl(target: string): boolean {
  try {
    const url = new URL(target);
    if (url.hostname === APP_HOST) return true;
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') return true;
    return false;
  } catch { return false; }
}

function isSameOrigin(target: string): boolean {
  try { return new URL(target).hostname === APP_HOST; } catch { return false; }
}

function extractDeepLink(argv: string[]): string | null {
  return argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`)) ?? null;
}

function isBoundsVisible(bounds: WindowBounds): boolean {
  if (bounds.x === undefined || bounds.y === undefined) return false;
  const { x, y } = bounds;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return x >= area.x - 8 && y >= area.y - 8 && x < area.x + area.width && y < area.y + area.height;
  });
}

function saveWindowBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const prev = store.get('windowBounds');
  if (mainWindow.isMaximized()) {
    store.set('windowBounds', { ...prev, isMaximized: true });
    return;
  }
  store.set('windowBounds', { ...mainWindow.getBounds(), isMaximized: false });
}

function setupWebContentsSecurity(contents: WebContents): void {
  contents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedUrl(targetUrl)) {
      event.preventDefault();
      log.warn(`[security] navigation blocked: ${targetUrl}`);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (isSameOrigin(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1024, height: 720, minWidth: 900, minHeight: 600,
          autoHideMenuBar: true, backgroundColor: '#1a1a2e',
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#1a1a2e', symbolColor: '#ffffff', height: 32 },
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, sandbox: true, nodeIntegration: false,
          },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      log.info(`[security] external url opened in browser: ${url}`);
    } else {
      log.warn(`[security] window.open denied: ${url}`);
    }
    return { action: 'deny' };
  });
}

function setupPermissionHandler(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    if (permission === 'notifications') { callback(true); return; }
    log.warn(`[security] permission denied: ${permission}`);
    callback(false);
  });
}

function createWindow(): void {
  const saved = store.get('windowBounds');
  const boundsOptions: BrowserWindowConstructorOptions = {
    width: Math.max(saved.width ?? 1280, 900),
    height: Math.max(saved.height ?? 800, 600),
  };
  if (saved.x !== undefined && saved.y !== undefined && isBoundsVisible(saved)) {
    boundsOptions.x = saved.x;
    boundsOptions.y = saved.y;
  }

  mainWindow = new BrowserWindow({
    ...boundsOptions,
    minWidth: 900, minHeight: 600, show: false,
    autoHideMenuBar: true, title: 'Huali Structure', backgroundColor: '#1a1a2e',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1a1a2e', symbolColor: '#ffffff', height: 32 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
    },
  });

  if (saved.isMaximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (pendingDeepLink) {
      mainWindow?.webContents.send('shell:deepLink', pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  mainWindow.loadURL(APP_URL);

  const persistBounds = debounce(saveWindowBounds, 500);
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  mainWindow.on('maximize', persistBounds);
  mainWindow.on('unmaximize', persistBounds);

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      saveWindowBounds();
      mainWindow?.hide();
      log.info('[window] hidden to tray');
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  setupWebContentsSecurity(mainWindow.webContents);
}

function toggleMainWindow(): void {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray(): void {
  const iconPath = path.join(__dirname, 'assets/icon.ico');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('Huali Structure');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: toggleMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', toggleMainWindow);
}

function registerIpcHandlers(): void {
  ipcMain.handle('shell:getVersion', () => app.getVersion());
  ipcMain.handle('shell:capabilities', () => ({
    notify: true, tray: true, autoUpdate: true, deepLink: true,
  }));
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    } else {
      log.warn(`[ipc] openExternal rejected: ${String(url)}`);
    }
  });
  ipcMain.handle('shell:setLoginItem', (_event, openAtLogin: boolean) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(openAtLogin) });
    log.info(`[ipc] setLoginItem openAtLogin=${Boolean(openAtLogin)}`);
  });
}

function setupAutoUpdater(): void {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => log.info('[updater] checking for update...'));
  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] update available: ${info.version}`);
    mainWindow?.webContents.send('shell:updateAvailable', info);
  });
  autoUpdater.on('update-not-available', (info) => log.info(`[updater] up to date: ${info.version}`));
  autoUpdater.on('download-progress', (p) =>
    log.info(`[updater] download ${p.percent.toFixed(1)}% (${p.transferred}/${p.total})`));
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[updater] downloaded: ${info.version}`);
    mainWindow?.webContents.send('shell:updateDownloaded', info);
  });
  autoUpdater.on('error', (err) => log.error('[updater] error:', err));

  setTimeout(() => {
    if (!app.isPackaged) { log.info('[updater] dev build, skip'); return; }
    autoUpdater.checkForUpdatesAndNotify().catch((err) => log.error('[updater] check failed:', err));
  }, UPDATE_CHECK_DELAY_MS);
}

function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  log.info(`[deeplink] open-url: ${url}`);
  if (mainWindow) { mainWindow.webContents.send('shell:deepLink', url); }
  else { pendingDeepLink = url; }
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  log.info('[app] another instance is running, quit');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const deepLink = extractDeepLink(argv);
    if (deepLink) { pendingDeepLink = deepLink; log.info(`[deeplink] second-instance: ${deepLink}`); }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
      if (pendingDeepLink) {
        mainWindow.webContents.send('shell:deepLink', pendingDeepLink);
        pendingDeepLink = null;
      }
    }
  });

  void app.whenReady().then(() => {
    log.info(`[app] starting v${app.getVersion()} packaged=${app.isPackaged}`);
    app.setAppUserModelId('com.huali.structure');
    registerProtocol();
    setupPermissionHandler();
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
    registerIpcHandlers();
    createWindow();
    createTray();
    setupAutoUpdater();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { isQuitting = true; });
  app.on('window-all-closed', () => { if (isQuitting) app.quit(); });
  app.on('will-quit', () => { log.info('[app] will quit'); });
}
