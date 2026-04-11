"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** Path from OS “open with” / double-click; consumed by first renderer request. */
let pendingLaunchPath = pickVideoPathFromArgv(process.argv);

function pickVideoPathFromArgv(argv) {
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a || a.startsWith("-")) continue;
    const lower = a.toLowerCase();
    if (lower.endsWith(".exe")) continue;
    const resolved = path.resolve(a);
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function payloadFromFsPath(fsPath) {
  if (!fsPath) return null;
  return {
    url: pathToFileURL(fsPath).href,
    displayName: path.basename(fsPath),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const p = pickVideoPathFromArgv(argv);
    if (p && mainWindow) {
      mainWindow.webContents.send("open-video-file", payloadFromFsPath(p));
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    ipcMain.handle("get-initial-video-payload", () => {
      const p = pendingLaunchPath;
      pendingLaunchPath = null;
      return payloadFromFsPath(p);
    });

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
