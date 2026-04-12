"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");

app.setName("Tesil Media Player");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { pathToFileURL } = require("url");

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** @type {import("http").Server | null} */
let staticServer = null;

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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/**
 * Resolve a URL path to a file under `rootDir`, rejecting path traversal.
 * @param {string} rootDir
 * @param {string} pathname e.g. "/index.html"
 * @returns {string | null} absolute file path
 */
function safeFileFromUrlPath(rootDir, pathname) {
  let p = pathname.split("?")[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (p === "/" || p === "") p = "/index.html";
  p = p.replace(/^\/+/, "");
  if (!p || p.includes("\0")) return null;
  const resolved = path.resolve(rootDir, p);
  const root = path.resolve(rootDir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

function localServerUrlIfRunning() {
  if (!staticServer || !staticServer.listening) return null;
  const addr = staticServer.address();
  if (typeof addr === "object" && addr && addr.port) {
    return `http://127.0.0.1:${addr.port}/`;
  }
  return null;
}

/**
 * Serves the packaged `index.html` and assets from 127.0.0.1 so the renderer has a real http
 * origin (avoids YouTube embed error 153 with file://).
 * @param {string} rootDir __dirname of the app (folder containing index.html)
 * @returns {Promise<string>} e.g. http://127.0.0.1:54321/
 */
function startLocalStaticServer(rootDir) {
  const reuse = localServerUrlIfRunning();
  if (reuse) return Promise.resolve(reuse);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      let pathname;
      try {
        pathname = new URL(req.url, "http://127.0.0.1").pathname;
      } catch {
        res.writeHead(400).end();
        return;
      }

      const filePath = safeFileFromUrlPath(rootDir, pathname);
      if (!filePath) {
        res.writeHead(403).end();
        return;
      }

      fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404).end();
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        const stream = fs.createReadStream(filePath);
        stream.on("error", () => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        stream.pipe(res);
      });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      staticServer = server;
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}/`);
    });
  });
}

function stopLocalStaticServer() {
  if (!staticServer) return;
  try {
    staticServer.close();
  } catch {
    /* ignore */
  }
  staticServer = null;
}

async function createWindow() {
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
      /* UI is http://127.0.0.1:* but playback still uses file:// and blob: URLs from IPC and file picker. */
      webSecurity: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  /* Touch long-press on <video> often opens the native menu even when the renderer calls preventDefault(). */
  mainWindow.webContents.on("context-menu", (event, params) => {
    if (params.mediaType === "video") {
      event.preventDefault();
    }
  });

  const rootDir = __dirname;
  try {
    const startUrl = await startLocalStaticServer(rootDir);
    await mainWindow.loadURL(startUrl);
  } catch (err) {
    console.error("Local static server failed; falling back to file://", err);
    await mainWindow.loadFile(path.join(rootDir, "index.html"));
  }
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

    void createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    stopLocalStaticServer();
  });
}
