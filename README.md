# Tesil Video Player

**Try in browser:** [https://tesilmedia.github.io/Tesil-Video-Player/](https://tesilmedia.github.io/Tesil-Video-Player/)

Tesil Video Player is a lightweight custom video player that runs in the browser and also ships as a Windows desktop app.

## Features

- Comprehensive Video Source Loading:
  - Direct video links (`http/https`)
  - YouTube links (`youtu.be`, `watch`, `shorts`, `live`, and embed forms).
  - Vimeo links (site and player links).
  - Twitch links (videos, live channels, and clips)
  - Supports `mp4`, `webm`, `mkv`, `mov`, `m4v`, `ogv`, `ogg`, `avi`, `3gp`, `3g2`
  - Drag and drop files or URLs directly into the player.
  - Open local video files from the file picker.

- Native custom controls:
  - Millisecond time display.
  - Scrub preview thumbnail + timestamp while hovering/scrubbing.
  - Frame-by-frame stepping, including hold-to-repeat.
  - Playback speed controls from `0.25x` to `3x`.
  - Mute/unmute and volume slider.
  - Fullscreen toggle and Picture-in-Picture support (when available).
  - Zoom in up to `900%` (`9x`), and pan while zoomed.

- Desktop and touch-friendly interaction model:
  - Scroll wheel zooms toward pointer.
  - Pinch-to-zoom on touch devices.
  - Drag to pan when zoomed.
  - Tap video area to play/pause on touch.

- Keyboard shortcuts:
  - `Space`: play/pause
  - `Left/Right`: seek `-5s/+5s`
  - `,` and `.`: frame step backward/forward
  - `Up/Down`: volume up/down
  - `M`: mute
  - `F`: fullscreen
  - `[` and `]`: slower/faster playback
  - `+` and `-`: zoom in/out
  - `0`: reset zoom

- Robust cross-browser handling for media behaviors such as iOS/WebKit volume routing and fullscreen edge cases.

## Windows App

- Built with Electron.
- Supports opening videos passed from the OS ("Open with" / file double-click).
- Uses a local `http://127.0.0.1` static server in desktop mode to keep embed playback compatible.
- Single-instance behavior: opening another file routes it into the existing app window.
- GitHub Actions workflow builds portable Windows release zips on version tags.

## Quick Start

### Browser

1. Open: [https://tesilmedia.github.io/Tesil-Video-Player/](https://tesilmedia.github.io/Tesil-Video-Player/)
2. Open a local file or paste a supported URL.

## Embed in your website

Use the dedicated embed page (player-only view; no title, file/link rows, or shortcuts panel):

`https://tesilmedia.github.io/Tesil-Video-Player/video-player/embed.html`

You can also pre-load a source with `src`:

`https://tesilmedia.github.io/Tesil-Video-Player/video-player/embed.html?src=`

Example iframe:

```html
<iframe
  src="https://tesilmedia.github.io/Tesil-Video-Player/video-player/embed.html?src=https://static.vecteezy.com/system/resources/previews/006/996/470/mp4/waves-on-the-beach-of-nai-harn-thailand-free-video.mp4"
  title="Tesil Video Player"
  allow="fullscreen; picture-in-picture"
  allowfullscreen
  loading="lazy"
  referrerpolicy="strict-origin-when-cross-origin"
  style="width:100%;aspect-ratio:16/9;border:0;"
></iframe>
```

### Windows (Desktop)

Download the latest release from [GitHub Releases](https://github.com/TesilMedia/Tesil-Video-Player/releases/latest).
