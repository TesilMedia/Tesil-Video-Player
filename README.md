# Tesil Media Player

A focused **video player** for **Windows (desktop)** and **the browser**: open files, paste URLs, scrub with a live preview, zoom and pan, frame-step, and keyboard-driven controls.

[![Latest release](https://img.shields.io/github/v/release/becknerd/Tesil-Player?logo=github&label=Windows%20portable)](https://github.com/becknerd/Tesil-Player/releases/latest)

---

## Download (Windows)

Portable builds are attached to each GitHub **Release** (`.zip` containing `Tesil Media Player.exe` and dependencies). Extract anywhere and run the executable, or use **Open with** from File Explorer on a supported video file.

---

## Try it in the browser

The same UI lives under [`video-player/`](video-player/) as static HTML/CSS/JS.

1. Clone the repo.
2. From the `video-player` folder, serve over **http** (not `file://`), e.g.  
   `python -m http.server 8765`  
   then open **http://localhost:8765/** in your browser.

Serving over `http://localhost` or `https://` avoids **YouTube embed configuration errors** (e.g. error 153) that often appear when the page is opened as a raw file URL.

---

## Features

### Playback & files

- **Open video file** — common containers and extensions (e.g. MP4, WebM, MKV, MOV, and more).
- **Drag and drop** a file onto the window (browser or app).
- **Paste a URL** — load a **direct** `http(s)` link to a media file the browser can decode (e.g. MP4/WebM), or a **YouTube** link (watch, `youtu.be`, embed, Shorts, etc.).
- **Windows app** — “Open with” / double-click can pass a file into the player on launch; subsequent opens use the running instance when possible.

### YouTube vs. your files

- **YouTube** opens in **YouTube’s embedded player** (full player chrome from YouTube). Tesil’s own timeline, zoom, and shortcut chrome are **hidden** for that mode so you’re clearly in YouTube’s UI.
- **Local files and direct URLs** use the **custom player**: progress bar, time with milliseconds, preview while scrubbing, PiP where supported, and all shortcuts below.

### Controls (local / direct video)

| Area | Behavior |
|------|------------|
| **Play / pause** | Button or **Space** |
| **Seek** | Scrub bar; **←** / **→** jump ±5 seconds |
| **Frame step** | **,** / **.** (hold to repeat); on-screen frame buttons |
| **Volume** | Slider; **↑** / **↓**; **M** mute |
| **Speed** | Dropdown or **[** / **]** |
| **Zoom** | **+** / **−** / **0** reset; mouse wheel on video zooms toward cursor; drag to pan when zoomed; pinch on touch |
| **Fullscreen** | **F** or fullscreen control |
| **PiP** | Picture-in-picture where the browser/OS allows it (not while a YouTube embed is active) |

### Keyboard without clicking the player

While the **pointer is over** the player (or focus is inside it), shortcuts work even if focus is elsewhere on the page—except when you’re typing in a real text field outside the player, so normal typing isn’t hijacked.

### Desktop (Electron) details

- The packaged app serves the UI from **127.0.0.1** with a small built-in static server so the window has a proper **HTTP origin**, which keeps **YouTube embeds** reliable compared to `file://` alone.
- **File URLs** and **blob** sources from the file picker still work with the current security settings required for that mix.

---

## Development

```bash
cd video-player
npm install
```

| Command | Purpose |
|---------|---------|
| `npm start` | Run the **Electron** app |
| `npm run dist` | Windows **dir** build under `video-player/dist/` (used by CI to zip a portable layout) |

---

## Repository layout

```
video-player/
  index.html          # Web / Electron UI shell
  player.js           # Player logic
  styles.css          # Layout & theme
  electron-main.cjs   # Electron entry; local static server + window
  preload.cjs         # Safe bridge for native file payloads
  package.json        # Version, scripts, electron-builder config
.github/workflows/   # Windows portable zip + GitHub Release on version tags
```

---

## License

No license file is present in this repository yet. Add a `LICENSE` file if you want to clarify terms for others.
