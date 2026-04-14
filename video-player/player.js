(function () {
  const player = document.getElementById("player");
  const video = document.getElementById("video");
  const playPause = document.getElementById("playPause");
  const progress = document.getElementById("progress");
  const timeDisplay = document.getElementById("timeDisplay");
  const muteBtn = document.getElementById("mute");
  const volumeSlider = document.getElementById("volume");
  const pipBtn = document.getElementById("pip");
  const fullscreenBtn = document.getElementById("fullscreen");
  const fileInput = document.getElementById("fileInput");
  const fileNameEl = document.getElementById("fileName");
  const previewVideo = document.getElementById("previewVideo");
  const scrubPreview = document.getElementById("scrubPreview");
  const previewCanvas = document.getElementById("previewCanvas");
  const previewTimeEl = document.getElementById("previewTime");
  const progressWrap = progress.closest(".player__progress-wrap");
  const videoViewport = document.getElementById("videoViewport");
  const zoomLayer = document.getElementById("zoomLayer");
  const zoomInBtn = document.getElementById("zoomIn");
  const zoomOutBtn = document.getElementById("zoomOut");
  const zoomResetBtn = document.getElementById("zoomReset");
  const zoomGroup = document.getElementById("zoomGroup");
  const zoomLabel = document.getElementById("zoomLabel");
  const playbackRateSelect = document.getElementById("playbackRate");
  const rateDownBtn = document.getElementById("rateDown");
  const rateUpBtn = document.getElementById("rateUp");
  const tooltipLayer = document.getElementById("tooltipLayer");
  const frameBackBtn = document.getElementById("frameBack");
  const frameForwardBtn = document.getElementById("frameForward");
  const ratePill = player.querySelector(".player__rate");
  const chromeEl = player.querySelector(".player__chrome");
  const cornerTools = player.querySelector(".player__corner-tools");
  const cornerVolume = player.querySelector(".player__corner-volume");
  const ytMount = document.getElementById("ytMount");
  const urlInput = document.getElementById("urlInput");
  const loadUrlBtn = document.getElementById("loadUrlBtn");

  const PREVIEW_W = 160;
  const PREVIEW_H = 90;

  let blobUrl = null;
  /** True after a user-chosen file, OS file launch, or drop (not the built-in sample). */
  let hasCustomSource = false;
  /** `native` = `<video>`; other values use an iframe embed and hide custom chrome. */
  let sourceKind = "native";

  function isExternalEmbedSource() {
    return sourceKind !== "native";
  }

  const DEMO_SAMPLE_URL =
    "https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

  /** Desktop (Electron): waiting for native initial path so we do not flash the web demo. */
  let pendingNativeInitial = false;

  let scrubPreviewActive = false;
  /** Last pointer X while preview is shown; used to reflow size on resize. */
  let lastPreviewClientX = null;
  let previewSeekRaf = null;
  /** Latest scrub time while preview is active; not cleared until seek pipeline catches up or hide. */
  let previewDesiredTime = null;
  let previewSeekInFlight = false;
  /** Like `frameStepGen`: ignore stale `seeked` draws when a newer hover target was queued. */
  let previewSeekGen = 0;
  /** Generation for the in-flight preview seek (set when assigning `previewVideo.currentTime`). */
  let previewSeekInFlightGen = 0;
  let lastScrubTime = 0;
  /** Which pointer owns an in-progress seek drag (document `pointerup` must ignore other pointers). */
  let scrubPointerId = null;
  /** Touch `Touch.identifier` for the finger scrubbing the seek bar (PE `pointermove` is often missing during native range drags). */
  let scrubTouchId = null;
  /** Touch `pointerId`s whose `pointerdown` was on the player; used to catch long-press menus when MQs still report a fine pointer (Windows hybrid). */
  const activeTouchPointersOnPlayer = new Set();

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 9;
  const ZOOM_STEP = 0.25;
  const usesCoarsePrimaryPointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;

  /** iOS and many mobile browsers ignore `video.volume` writes; mute still works. */
  function browserAllowsMediaElementVolumeControl() {
    try {
      const t = document.createElement("video");
      t.muted = true;
      t.volume = 1;
      const target = 0.37;
      t.volume = target;
      return Math.abs(t.volume - target) < 0.02;
    } catch (_) {
      return false;
    }
  }

  /**
   * iOS/iPadOS WebKit often reports successful `video.volume` writes while playback loudness
   * still follows the hardware buttons — route volume through Web Audio instead.
   */
  function isIosStyleVolumeLockedPlatform() {
    try {
      const ua = navigator.userAgent || "";
      if (/iPhone|iPod|iPad/i.test(ua)) return true;
      if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  /** When true, drive loudness with `video.volume`; otherwise try Web Audio gain (see below). */
  const elementVolumeControlsOutput =
    browserAllowsMediaElementVolumeControl() && !isIosStyleVolumeLockedPlatform();

  /** Lazily created when `elementVolumeControlsOutput` is false (typical: iPhone Safari). */
  let webAudioVolumeRoute = false;
  /** Cleared on `loadstart` so a new source can retry after a CORS/setup failure. */
  let webAudioVolumeSetupFailed = false;
  /** @type {AudioContext | null} */
  let webAudioCtx = null;
  /** @type {GainNode | null} */
  let webAudioGain = null;
  /** Value at `pointerdown` on the volume range; mobile often emits a bogus `input` of 0 first. */
  let volPointerBaseline = null;

  function webAudioVolumeConstructorAvailable() {
    return (
      typeof window.AudioContext === "function" ||
      typeof window.webkitAudioContext === "function"
    );
  }

  function ensureWebAudioGainRoute() {
    if (elementVolumeControlsOutput) return false;
    if (webAudioVolumeRoute && webAudioCtx && webAudioGain) {
      void webAudioCtx.resume();
      return true;
    }
    if (webAudioVolumeSetupFailed) return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (typeof AC !== "function") {
      webAudioVolumeSetupFailed = true;
      syncVolumeSliderLockedUI();
      return false;
    }
    try {
      const ctx = new AC();
      const src = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();
      src.connect(gain);
      gain.connect(ctx.destination);
      webAudioCtx = ctx;
      webAudioGain = gain;
      webAudioVolumeRoute = true;
      video.volume = 1;
      {
        const raw = Number(volumeSlider.value);
        const g0 = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
        gain.gain.value = g0;
      }
      void ctx.resume();
      return true;
    } catch (_) {
      webAudioVolumeSetupFailed = true;
      syncVolumeSliderLockedUI();
      return false;
    }
  }

  /** Apply slider + `video.muted` to the Web Audio gain node (no-op if not routed). */
  function setWebAudioOutputGainFromControls() {
    if (!webAudioVolumeRoute || !webAudioGain || !webAudioCtx) return;
    let v = Math.max(0, Math.min(1, Number(volumeSlider.value)));
    if (!Number.isFinite(v)) v = 1;
    const out = video.muted ? 0 : v;
    try {
      webAudioGain.gain.setValueAtTime(out, webAudioCtx.currentTime);
    } catch (_) {
      webAudioGain.gain.value = out;
    }
  }

  function applyVolumeFromSlider() {
    if (!(volumeSlider instanceof HTMLInputElement)) return;
    let v = Math.max(0, Math.min(1, Number(volumeSlider.value)));
    if (!Number.isFinite(v)) return;

    if (!elementVolumeControlsOutput) {
      const baseline = volPointerBaseline;
      if (
        !webAudioVolumeRoute &&
        baseline != null &&
        Number.isFinite(baseline) &&
        baseline > 0.05 &&
        v === 0
      ) {
        v = Math.max(0, Math.min(1, baseline));
        volumeSlider.value = String(v);
      }
    }

    if (elementVolumeControlsOutput) {
      video.volume = v;
      video.muted = v === 0;
      return;
    }

    if (!ensureWebAudioGainRoute()) return;

    video.volume = 1;
    /* Output level is gain; keep `video.muted` for the mute control (WebKit often ignores muted on this route). */
    setWebAudioOutputGainFromControls();
    void webAudioCtx.resume();
    setMutedUI();
  }

  function bumpVolumeKeyboard(delta) {
    if (elementVolumeControlsOutput) {
      if (delta > 0) video.muted = false;
      video.volume = Math.min(1, Math.max(0, video.volume + delta));
      video.muted = video.volume === 0;
      volumeSlider.value = String(video.volume);
      return;
    }
    if (!ensureWebAudioGainRoute()) return;
    if (delta > 0) video.muted = false;
    const cur = Math.max(0, Math.min(1, Number(volumeSlider.value)));
    const next = Math.min(1, Math.max(0, cur + delta));
    volumeSlider.value = String(next);
    applyVolumeFromSlider();
  }

  function syncVolumeSliderLockedUI() {
    if (!(volumeSlider instanceof HTMLInputElement)) return;
    const enabled =
      elementVolumeControlsOutput ||
      (webAudioVolumeConstructorAvailable() && !webAudioVolumeSetupFailed);
    volumeSlider.disabled = !enabled;
    volumeSlider.setAttribute(
      "aria-label",
      enabled
        ? "Volume"
        : "Volume (not adjustable for this source in this browser)"
    );
  }

  video.addEventListener("loadstart", () => {
    webAudioVolumeSetupFailed = false;
  });

  /** At 1× zoom, movement past this before pointerup cancels tap-to-play (scroll starting on the player). */
  const VIEWPORT_TAP_CANCEL_MOVE_PX = usesCoarsePrimaryPointer ? 30 : 12;
  /** Coarse/touch: cancel tap-to-play if the finger stayed down longer than a quick tap (avoids long-press / slow drags). */
  const VIEWPORT_TAP_MAX_DURATION_MS = usesCoarsePrimaryPointer ? 300 : Infinity;
  /** Two-finger span must reach this (px) before pinch-zoom activates (avoids jitter when touches start close). */
  const PINCH_MIN_START_DIST_PX = 28;
  /** Clamp per-move scale ratio so a bad frame does not explode zoom. */
  const PINCH_FACTOR_MIN = 0.55;
  const PINCH_FACTOR_MAX = 1.85;

  let zoomLevel = 1;
  let panX = 0;
  let panY = 0;
  let panPointer = null;

  /** @type {Map<number, { clientX: number; clientY: number; pointerType: string }>} */
  const viewportPointers = new Map();
  /** @type {{ lastDist: number } | null} */
  let pinchState = null;

  function isTwoFingerTouchPinch() {
    if (viewportPointers.size !== 2) return false;
    const pts = [...viewportPointers.values()];
    return pts[0].pointerType === "touch" && pts[1].pointerType === "touch";
  }

  function getViewportPinchDistance() {
    const pts = [...viewportPointers.values()];
    if (pts.length !== 2) return 0;
    const dx = pts[0].clientX - pts[1].clientX;
    const dy = pts[0].clientY - pts[1].clientY;
    return Math.hypot(dx, dy);
  }

  function getViewportPinchAnchor() {
    const pts = [...viewportPointers.values()];
    if (pts.length !== 2) return null;
    const mx = (pts[0].clientX + pts[1].clientX) / 2;
    const my = (pts[0].clientY + pts[1].clientY) / 2;
    const rect = videoViewport.getBoundingClientRect();
    return {
      x: Math.min(rect.width, Math.max(0, mx - rect.left)),
      y: Math.min(rect.height, Math.max(0, my - rect.top)),
    };
  }

  function releasePanPointerCapture() {
    if (!panPointer) return;
    const pid = panPointer.id;
    try {
      if (videoViewport.hasPointerCapture(pid)) {
        videoViewport.releasePointerCapture(pid);
      }
    } catch (_) {
      /* ignore */
    }
    panPointer = null;
    videoViewport.dataset.panning = "false";
  }

  function promoteRemainingFingerToPan() {
    if (viewportPointers.size !== 1) {
      panPointer = null;
      return;
    }
    const [id, pt] = viewportPointers.entries().next().value;
    if (zoomLevel > 1.001) {
      panPointer = {
        id,
        cx: pt.clientX,
        cy: pt.clientY,
        ox: panX,
        oy: panY,
        dragged: false,
        tapCancelled: true,
      };
      try {
        videoViewport.setPointerCapture(id);
      } catch (_) {
        /* ignore */
      }
      videoViewport.dataset.panning = "true";
    } else {
      panPointer = null;
    }
  }

  function clampPan() {
    if (zoomLevel <= 1) {
      panX = 0;
      panY = 0;
      return;
    }
    const vw = videoViewport.clientWidth;
    const vh = videoViewport.clientHeight;
    const maxX = (vw * (zoomLevel - 1)) / 2;
    const maxY = (vh * (zoomLevel - 1)) / 2;
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  function syncRatePillWidthToZoom() {
    if (!(zoomGroup instanceof HTMLElement) || !(ratePill instanceof HTMLElement)) return;
    const wZoom = zoomGroup.offsetWidth;
    ratePill.style.removeProperty("width");
    const wNatural = Math.ceil(ratePill.getBoundingClientRect().width);
    if (wZoom <= 0) {
      if (wNatural > 0) ratePill.style.width = `${wNatural}px`;
      else ratePill.style.removeProperty("width");
      return;
    }
    ratePill.style.width = `${Math.max(wZoom, wNatural)}px`;
  }

  function applyZoomTransform() {
    zoomLayer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
    videoViewport.dataset.canPan = zoomLevel > 1.001 ? "true" : "false";
    zoomLabel.textContent = `${Math.round(zoomLevel * 100)}%`;
    syncRatePillWidthToZoom();
  }

  /**
   * @param {number} z
   * @param {{ x: number; y: number } | null} anchorViewport — point in videoViewport coords
   *   (top-left origin); omit or null to zoom toward the viewport center (toolbar / keyboard).
   */
  function setZoomLevel(z, anchorViewport = null) {
    const vw = videoViewport.clientWidth;
    const vh = videoViewport.clientHeight;
    const ox = vw / 2;
    const oy = vh / 2;
    const ax = anchorViewport ? anchorViewport.x : ox;
    const ay = anchorViewport ? anchorViewport.y : oy;

    const z0 = zoomLevel;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

    if (next <= 1) {
      zoomLevel = next;
      panX = 0;
      panY = 0;
      clampPan();
      applyZoomTransform();
      return;
    }

    if (Math.abs(next - z0) > 1e-6 && z0 >= 1) {
      const ratio = next / z0;
      panX = ax - ox - ratio * (ax - ox - panX);
      panY = ay - oy - ratio * (ay - oy - panY);
    }

    zoomLevel = next;
    clampPan();
    applyZoomTransform();
  }

  function adjustZoomByStep(deltaSteps) {
    const z =
      Math.round((zoomLevel + deltaSteps * ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP;
    setZoomLevel(z);
  }

  function zoomFromWheel(deltaY, clientX, clientY) {
    const rect = videoViewport.getBoundingClientRect();
    const anchor = {
      x: Math.min(rect.width, Math.max(0, clientX - rect.left)),
      y: Math.min(rect.height, Math.max(0, clientY - rect.top)),
    };
    const factor = deltaY > 0 ? 0.92 : 1.08;
    setZoomLevel(zoomLevel * factor, anchor);
  }

  /** Used until enough frames have been observed (no rVFC or never played). */
  const FALLBACK_FRAME_PERIOD = 1 / 30;
  /** Hold-to-repeat only starts after this many ms so quick taps stay single-step. */
  const FRAME_HOLD_REPEAT_DELAY_MS = 300;
  /** After the initial delay, zoom / playback-rate keys and buttons repeat at this interval. */
  const CHROME_HOLD_INTERVAL_MS = 100;

  const DT_SAMPLE_CAP = 48;
  const MIN_FRAME_PERIOD = 1 / 120;
  const MAX_FRAME_PERIOD = 0.2;
  const MIN_SAMPLES_FOR_PERIOD = 6;

  const framePeriodSamples = [];
  let rVfcHandle = null;
  let measureActive = false;
  let lastMediaTime = null;

  function recordFramePeriod(dt) {
    framePeriodSamples.push(dt);
    if (framePeriodSamples.length > DT_SAMPLE_CAP) framePeriodSamples.shift();
  }

  function getFramePeriodSec() {
    if (framePeriodSamples.length < MIN_SAMPLES_FOR_PERIOD) return null;
    const sorted = framePeriodSamples.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    if (median < MIN_FRAME_PERIOD || median > MAX_FRAME_PERIOD) return null;
    return median;
  }

  function onVideoFrame(_now, metadata) {
    rVfcHandle = null;
    if (!measureActive || video.paused) return;

    const mt = metadata.mediaTime;
    if (lastMediaTime != null) {
      const dt = mt - lastMediaTime;
      if (dt >= MIN_FRAME_PERIOD && dt <= MAX_FRAME_PERIOD) {
        recordFramePeriod(dt);
      }
    }
    lastMediaTime = mt;
    rVfcHandle = video.requestVideoFrameCallback(onVideoFrame);
  }

  function startFramePeriodMeasure() {
    if (typeof video.requestVideoFrameCallback !== "function") return;
    measureActive = true;
    if (rVfcHandle != null) return;
    rVfcHandle = video.requestVideoFrameCallback(onVideoFrame);
  }

  function stopFramePeriodMeasure() {
    measureActive = false;
    if (rVfcHandle != null && typeof video.cancelVideoFrameCallback === "function") {
      try {
        video.cancelVideoFrameCallback(rVfcHandle);
      } catch (_) {
        /* ignore */
      }
    }
    rVfcHandle = null;
    lastMediaTime = null;
  }

  /** While true, `stepByFrame` for that direction chains after each completed seek (comma/period hold). */
  let frameKeyHeldBack = false;
  let frameKeyHeldForward = false;
  /** Same for overlay frame step buttons (pointer hold). */
  let framePointerHeldBack = false;
  let framePointerHeldForward = false;
  /** True after `pointerdown` on a frame step button until `click` skips or rAF clears (no duplicate step). */
  let lastFrameStepViaPointer = false;
  /** After delay, hold chains another frame on comma/period or frame buttons (`FRAME_HOLD_REPEAT_DELAY_MS`). */
  let frameKeyHoldRepeatReadyBack = false;
  let frameKeyHoldRepeatReadyForward = false;
  let framePointerHoldRepeatReadyBack = false;
  let framePointerHoldRepeatReadyForward = false;
  let frameKeyHoldTimerBack = null;
  let frameKeyHoldTimerForward = null;
  let framePointerHoldTimerBack = null;
  let framePointerHoldTimerForward = null;

  function frameHeldForDirection(direction) {
    return direction < 0
      ? frameKeyHeldBack || framePointerHeldBack
      : frameKeyHeldForward || framePointerHeldForward;
  }

  function frameHoldRepeatsAfterDelayForDirection(direction) {
    return direction < 0
      ? (frameKeyHeldBack && frameKeyHoldRepeatReadyBack) ||
          (framePointerHeldBack && framePointerHoldRepeatReadyBack)
      : (frameKeyHeldForward && frameKeyHoldRepeatReadyForward) ||
          (framePointerHeldForward && framePointerHoldRepeatReadyForward);
  }

  function disarmKeyboardFrameHoldRepeat(direction) {
    if (direction === -1) {
      if (frameKeyHoldTimerBack != null) {
        clearTimeout(frameKeyHoldTimerBack);
        frameKeyHoldTimerBack = null;
      }
      frameKeyHoldRepeatReadyBack = false;
    } else {
      if (frameKeyHoldTimerForward != null) {
        clearTimeout(frameKeyHoldTimerForward);
        frameKeyHoldTimerForward = null;
      }
      frameKeyHoldRepeatReadyForward = false;
    }
  }

  function disarmPointerFrameHoldRepeat(direction) {
    if (direction === -1) {
      if (framePointerHoldTimerBack != null) {
        clearTimeout(framePointerHoldTimerBack);
        framePointerHoldTimerBack = null;
      }
      framePointerHoldRepeatReadyBack = false;
    } else {
      if (framePointerHoldTimerForward != null) {
        clearTimeout(framePointerHoldTimerForward);
        framePointerHoldTimerForward = null;
      }
      framePointerHoldRepeatReadyForward = false;
    }
  }

  function armKeyboardFrameHoldRepeat(direction) {
    disarmKeyboardFrameHoldRepeat(direction);
    const tid = window.setTimeout(() => {
      if (direction === -1) {
        frameKeyHoldTimerBack = null;
        if (!frameKeyHeldBack) return;
        frameKeyHoldRepeatReadyBack = true;
      } else {
        frameKeyHoldTimerForward = null;
        if (!frameKeyHeldForward) return;
        frameKeyHoldRepeatReadyForward = true;
      }
      stepByFrame(direction);
    }, FRAME_HOLD_REPEAT_DELAY_MS);
    if (direction === -1) frameKeyHoldTimerBack = tid;
    else frameKeyHoldTimerForward = tid;
  }

  function armPointerFrameHoldRepeat(direction) {
    disarmPointerFrameHoldRepeat(direction);
    const tid = window.setTimeout(() => {
      if (direction === -1) {
        framePointerHoldTimerBack = null;
        if (!framePointerHeldBack) return;
        framePointerHoldRepeatReadyBack = true;
      } else {
        framePointerHoldTimerForward = null;
        if (!framePointerHeldForward) return;
        framePointerHoldRepeatReadyForward = true;
      }
      stepByFrame(direction);
    }, FRAME_HOLD_REPEAT_DELAY_MS);
    if (direction === -1) framePointerHoldTimerBack = tid;
    else framePointerHoldTimerForward = tid;
  }

  /** Suppresses stale `seeked` UI when a newer frame-step seek was started. */
  let frameStepGen = 0;

  function stepByFrame(direction) {
    if (isExternalEmbedSource()) return;
    if (!video.paused) video.pause();
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;

    const fd = getFramePeriodSec() ?? FALLBACK_FRAME_PERIOD;
    const eps = fd * 0.02;
    const idx = Math.floor((video.currentTime + eps) / fd);
    const nextIdx = direction < 0 ? idx - 1 : idx + 1;
    const newTime = Math.max(
      0,
      Math.min(dur - Number.EPSILON, nextIdx * fd)
    );

    if (Math.abs(newTime - video.currentTime) < 1e-6) {
      syncProgressFromVideo();
      updateTimeDisplay();
      return;
    }

    const myGen = (frameStepGen += 1);
    video.addEventListener(
      "seeked",
      () => {
        if (myGen !== frameStepGen) return;
        syncProgressFromVideo();
        updateTimeDisplay();
        if (!frameHeldForDirection(direction)) return;
        if (!frameHoldRepeatsAfterDelayForDirection(direction)) return;
        // Paused video: `requestVideoFrameCallback` often never fires, so holds would stop after
        // one frame. `requestAnimationFrame` runs after the seeked paint path on the main thread.
        requestAnimationFrame(() => {
          if (!frameHoldRepeatsAfterDelayForDirection(direction)) return;
          stepByFrame(direction);
        });
      },
      { once: true }
    );
    video.currentTime = newTime;
  }

  function frameStepDirectionFromKeyEvent(e) {
    if (e.key === ",") return -1;
    if (e.key === ".") return 1;
    if (e.code === "Comma") return -1;
    if (e.code === "Period") return 1;
    return null;
  }

  function clearFrameKeyboardHoldDirection(direction) {
    disarmKeyboardFrameHoldRepeat(direction);
    if (direction === -1) frameKeyHeldBack = false;
    else frameKeyHeldForward = false;
  }

  function clearAllFrameHold() {
    frameKeyHeldBack = false;
    frameKeyHeldForward = false;
    framePointerHeldBack = false;
    framePointerHeldForward = false;
    lastFrameStepViaPointer = false;
    disarmKeyboardFrameHoldRepeat(-1);
    disarmKeyboardFrameHoldRepeat(1);
    disarmPointerFrameHoldRepeat(-1);
    disarmPointerFrameHoldRepeat(1);
  }

  /** @type {Set<() => void>} */
  const chromePointerHoldDisarms = new Set();

  /** Keyboard hold-repeat for zoom (+ / −) and playback rate ([ / ]). */
  let zoomKbActiveDir = /** @type {0 | 1 | -1} */ (0);
  let zoomKbDelayId = null;
  let zoomKbIntervalId = null;
  let rateKbActiveDir = /** @type {0 | 1 | -1} */ (0);
  let rateKbDelayId = null;
  let rateKbIntervalId = null;

  function disarmZoomKbRepeat() {
    zoomKbActiveDir = 0;
    if (zoomKbDelayId != null) {
      clearTimeout(zoomKbDelayId);
      zoomKbDelayId = null;
    }
    if (zoomKbIntervalId != null) {
      clearInterval(zoomKbIntervalId);
      zoomKbIntervalId = null;
    }
  }

  function disarmRateKbRepeat() {
    rateKbActiveDir = 0;
    if (rateKbDelayId != null) {
      clearTimeout(rateKbDelayId);
      rateKbDelayId = null;
    }
    if (rateKbIntervalId != null) {
      clearInterval(rateKbIntervalId);
      rateKbIntervalId = null;
    }
  }

  function disarmZoomRateKeyboardHolds() {
    disarmZoomKbRepeat();
    disarmRateKbRepeat();
  }

  function disarmAllChromePointerHolds() {
    for (const d of [...chromePointerHoldDisarms]) {
      try {
        d();
      } catch (_) {
        /* ignore */
      }
    }
    chromePointerHoldDisarms.clear();
  }

  function isZoomInKeyEvent(e) {
    return (
      e.code === "NumpadAdd" ||
      e.key === "=" ||
      e.key === "+" ||
      e.code === "Equal"
    );
  }

  function isZoomOutKeyEvent(e) {
    return (
      e.code === "NumpadSubtract" ||
      e.code === "Minus" ||
      e.key === "-" ||
      e.key === "_"
    );
  }

  /**
   * @param {1 | -1} dir
   */
  function zoomKbKeydown(dir) {
    disarmZoomKbRepeat();
    zoomKbActiveDir = dir;
    adjustZoomByStep(dir);
    zoomKbDelayId = window.setTimeout(() => {
      zoomKbDelayId = null;
      if (zoomKbActiveDir !== dir) return;
      zoomKbIntervalId = window.setInterval(() => {
        if (zoomKbActiveDir === dir) adjustZoomByStep(dir);
      }, CHROME_HOLD_INTERVAL_MS);
    }, FRAME_HOLD_REPEAT_DELAY_MS);
  }

  /**
   * @param {1 | -1} dir
   */
  function zoomKbKeyup(dir) {
    if (zoomKbActiveDir !== dir) return;
    disarmZoomKbRepeat();
  }

  /**
   * @param {1 | -1} dir  1 = faster, -1 = slower (matches `nudgePlaybackRate`)
   */
  function rateKbKeydown(dir) {
    disarmRateKbRepeat();
    rateKbActiveDir = dir;
    nudgePlaybackRate(dir);
    rateKbDelayId = window.setTimeout(() => {
      rateKbDelayId = null;
      if (rateKbActiveDir !== dir) return;
      rateKbIntervalId = window.setInterval(() => {
        if (rateKbActiveDir === dir) nudgePlaybackRate(dir);
      }, CHROME_HOLD_INTERVAL_MS);
    }, FRAME_HOLD_REPEAT_DELAY_MS);
  }

  /**
   * @param {1 | -1} dir
   */
  function rateKbKeyup(dir) {
    if (rateKbActiveDir !== dir) return;
    disarmRateKbRepeat();
  }

  /**
   * Hold-to-repeat for zoom ± and rate ± buttons (same delay/interval as keyboard).
   * @param {HTMLElement} btn
   * @param {() => void} stepFn
   */
  function wireHeldChromeButton(btn, stepFn) {
    let delayId = null;
    let intervalId = null;
    let viaPointer = false;

    function disarm() {
      if (delayId != null) {
        clearTimeout(delayId);
        delayId = null;
      }
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      chromePointerHoldDisarms.delete(disarm);
    }

    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      viaPointer = true;
      disarm();
      chromePointerHoldDisarms.add(disarm);
      stepFn();
      delayId = window.setTimeout(() => {
        delayId = null;
        intervalId = window.setInterval(() => stepFn(), CHROME_HOLD_INTERVAL_MS);
      }, FRAME_HOLD_REPEAT_DELAY_MS);
    });
    btn.addEventListener("click", () => {
      if (viaPointer) {
        viaPointer = false;
        return;
      }
      stepFn();
    });
    btn.addEventListener("lostpointercapture", () => {
      disarm();
      bumpChromeActivity();
    });
  }

  function revokeBlobUrl() {
    previewVideo.removeAttribute("src");
    previewVideo.load();
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  }

  function exitYoutubeMode() {
    sourceKind = "native";
    player.dataset.source = "native";
    player.classList.remove("player--youtube-only");
    if (ytMount instanceof HTMLElement) {
      ytMount.innerHTML = "";
      ytMount.hidden = true;
    }
    video.hidden = false;
  }

  function parseYouTubeVideoId(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch (_) {
      return null;
    }
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.replace(/^\//, "").split("/")[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.pathname === "/watch" || url.pathname.startsWith("/watch")) {
        const v = url.searchParams.get("v");
        return v && /^[\w-]{11}$/.test(v) ? v : null;
      }
      const embed = url.pathname.match(/^\/embed\/([\w-]{11})/);
      if (embed) return embed[1];
      const shorts = url.pathname.match(/^\/shorts\/([\w-]{11})/);
      if (shorts) return shorts[1];
      const live = url.pathname.match(/^\/live\/([\w-]{11})/);
      if (live) return live[1];
    }
    if (host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")) {
      const embedNc = url.pathname.match(/^\/embed\/([\w-]{11})/);
      if (embedNc) return embedNc[1];
    }
    return null;
  }

  function parseVimeoVideoId(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch (_) {
      return null;
    }
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "player.vimeo.com") {
      const m = url.pathname.match(/^\/video\/(\d+)/);
      return m ? m[1] : null;
    }
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
      const segs = url.pathname.match(/\/(\d{6,})/g);
      if (!segs || !segs.length) return null;
      const last = segs[segs.length - 1].replace(/^\//, "");
      return last || null;
    }
    return null;
  }

  /**
   * @returns {{ kind: "video", video: string } | { kind: "channel", channel: string } | { kind: "clip", clip: string } | null}
   */
  function parseTwitchEmbedTarget(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch (_) {
      return null;
    }
    let host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "m.twitch.tv") host = "twitch.tv";
    if (host === "clips.twitch.tv") {
      const slug = url.pathname.replace(/^\//, "").split("/")[0];
      if (slug && /^[\w-]+$/.test(slug)) return { kind: "clip", clip: slug };
      return null;
    }
    if (host !== "twitch.tv" && !host.endsWith(".twitch.tv")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "videos" && /^\d+$/.test(parts[1] || "")) {
      return { kind: "video", video: `v${parts[1]}` };
    }
    if (parts.length >= 3 && parts[1] === "clip") {
      const slug = parts[2] || "";
      if (slug && /^[\w-]+$/.test(slug)) return { kind: "clip", clip: slug };
      return null;
    }
    if (parts.length === 1) {
      const ch = parts[0];
      const reserved = new Set([
        "videos",
        "directory",
        "downloads",
        "settings",
        "jobs",
        "p",
        "legal",
        "security",
        "subs",
        "turbo",
        "products",
        "search",
      ]);
      if (reserved.has(ch.toLowerCase())) return null;
      if (/^[a-zA-Z0-9_]{4,25}$/.test(ch)) return { kind: "channel", channel: ch };
    }
    return null;
  }

  function isLikelyDirectVideoUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function loadExternalEmbedIframe(kind, iframeSrc, iframeTitle, displayLabel) {
    hasCustomSource = true;
    revokeBlobUrl();
    exitYoutubeMode();
    sourceKind = kind;
    player.dataset.source = kind;
    player.classList.add("player--youtube-only");
    try {
      setZoomLevel(1);
    } catch (_) {
      /* setZoomLevel not ready in edge load orders */
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    syncPreviewVideoSrc();
    hideScrubPreview();
    video.hidden = true;
    if (!(ytMount instanceof HTMLElement)) return;
    ytMount.hidden = false;
    ytMount.innerHTML = "";
    const ifr = document.createElement("iframe");
    ifr.className = "player__youtube-iframe";
    ifr.src = iframeSrc;
    ifr.title = iframeTitle;
    ifr.setAttribute("allowfullscreen", "");
    ifr.setAttribute(
      "allow",
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    );
    ifr.referrerPolicy = "strict-origin-when-cross-origin";
    ytMount.appendChild(ifr);
    if (fileNameEl instanceof HTMLElement) {
      fileNameEl.textContent = displayLabel || iframeTitle;
    }
    clearAllFrameHold();
  }

  function loadYouTubeFromId(videoId, displayLabel) {
    const params = new URLSearchParams({
      rel: "0",
      modestbranding: "1",
      playsinline: "1",
    });
    const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(
      videoId
    )}?${params}`;
    loadExternalEmbedIframe(
      "youtube",
      src,
      "YouTube video",
      displayLabel || `YouTube · ${videoId}`
    );
  }

  function loadVimeoFromId(videoId, displayLabel) {
    const params = new URLSearchParams({
      badge: "0",
      autopause: "0",
      playsinline: "1",
    });
    const src = `https://player.vimeo.com/video/${encodeURIComponent(videoId)}?${params}`;
    loadExternalEmbedIframe(
      "vimeo",
      src,
      "Vimeo video",
      displayLabel || `Vimeo · ${videoId}`
    );
  }

  function loadTwitchEmbed(target, displayLabel) {
    const u = new URL("https://player.twitch.tv/");
    u.searchParams.set("playsinline", "true");
    const h = (window.location && window.location.hostname) || "";
    const parents = [];
    if (h) {
      parents.push(h);
      if (h === "127.0.0.1") parents.push("localhost");
      else if (h === "localhost") parents.push("127.0.0.1");
    }
    if (!parents.length) parents.push("localhost");
    for (const p of parents) u.searchParams.append("parent", p);
    if (target.kind === "video") u.searchParams.set("video", target.video);
    else if (target.kind === "channel") u.searchParams.set("channel", target.channel);
    else u.searchParams.set("clip", target.clip);
    const label =
      displayLabel ||
      (target.kind === "video"
        ? `Twitch · ${target.video}`
        : target.kind === "channel"
          ? `Twitch · ${target.channel} (live)`
          : `Twitch clip · ${target.clip}`);
    loadExternalEmbedIframe("twitch", u.toString(), "Twitch video", label);
  }

  function loadVideoFromHttpUrl(urlStr) {
    if (!isLikelyDirectVideoUrl(urlStr)) {
      if (fileNameEl instanceof HTMLElement) {
        fileNameEl.textContent = "Enter a valid http(s) video URL.";
      }
      return;
    }
    hasCustomSource = true;
    exitYoutubeMode();
    revokeBlobUrl();
    video.hidden = false;
    player.dataset.source = "native";
    syncPipVisibility();
    video.src = urlStr;
    try {
      const host = new URL(urlStr).hostname;
      if (fileNameEl instanceof HTMLElement) fileNameEl.textContent = host || urlStr;
    } catch (_) {
      if (fileNameEl instanceof HTMLElement) fileNameEl.textContent = urlStr;
    }
    const onErr = () => {
      video.removeEventListener("error", onErr);
      hasCustomSource = false;
      if (fileNameEl instanceof HTMLElement) {
        fileNameEl.textContent =
          "Could not play this URL. Try a direct MP4/WebM link, or a YouTube, Vimeo, or Twitch link.";
      }
    };
    video.addEventListener("error", onErr, { once: true });
    video.load();
    syncPreviewVideoSrc();
    video.playbackRate = 1;
    playbackRateSelect.value = "1";
    video.play().catch(() => {});
  }

  function tryLoadFromUrlString(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return;
    const ytId = parseYouTubeVideoId(trimmed);
    if (ytId) {
      loadYouTubeFromId(ytId, `YouTube · ${ytId}`);
      return;
    }
    const vimeoId = parseVimeoVideoId(trimmed);
    if (vimeoId) {
      loadVimeoFromId(vimeoId, `Vimeo · ${vimeoId}`);
      return;
    }
    const twitchTarget = parseTwitchEmbedTarget(trimmed);
    if (twitchTarget) {
      loadTwitchEmbed(twitchTarget);
      return;
    }
    if (!isLikelyDirectVideoUrl(trimmed)) {
      if (fileNameEl instanceof HTMLElement) {
        fileNameEl.textContent =
          "Unsupported URL. Use YouTube, Vimeo, Twitch, or a direct link to a video file (MP4, WebM, …).";
      }
      return;
    }
    loadVideoFromHttpUrl(trimmed);
  }

  function isVideoFile(file) {
    if (!(file instanceof File)) return false;
    if (file.type && file.type.startsWith("video/")) return true;
    return /\.(mp4|webm|mkv|mov|m4v|ogv|ogg|avi|3gp|3g2)$/i.test(file.name);
  }

  function loadVideoFromFile(file) {
    if (!isVideoFile(file)) return;
    hasCustomSource = true;
    exitYoutubeMode();
    revokeBlobUrl();
    blobUrl = URL.createObjectURL(file);
    video.src = blobUrl;
    if (fileNameEl instanceof HTMLElement) fileNameEl.textContent = file.name;
    video.load();
    syncPreviewVideoSrc();
    video.playbackRate = 1;
    playbackRateSelect.value = "1";
    syncPipVisibility();
    video.play().catch(() => {});
  }

  function loadVideoFromNativePayload(payload) {
    if (!payload || !payload.url) return;
    hasCustomSource = true;
    exitYoutubeMode();
    revokeBlobUrl();
    video.src = payload.url;
    if (fileNameEl instanceof HTMLElement) {
      fileNameEl.textContent = payload.displayName || "";
    }
    video.load();
    syncPreviewVideoSrc();
    video.playbackRate = 1;
    playbackRateSelect.value = "1";
    syncPipVisibility();
    video.play().catch(() => {});
  }

  /** True while the OS launch queue is still delivering file handle(s). */
  let pendingOsFileOpen = false;

  /** True when any pointer is inside `#player` (mouse hover / finger over player). */
  let pointerInsidePlayer = false;

  if ("launchQueue" in window && typeof window.launchQueue.setConsumer === "function") {
    window.launchQueue.setConsumer(async (launchParams) => {
      pendingOsFileOpen = true;
      try {
        let raw = launchParams.files;
        if (raw && typeof raw.then === "function") raw = await raw;
        if (!raw) return;

        if (typeof raw[Symbol.asyncIterator] === "function") {
          for await (const handle of raw) {
            const file = await handle.getFile();
            if (isVideoFile(file)) {
              loadVideoFromFile(file);
              return;
            }
          }
          return;
        }

        const list = Array.isArray(raw) ? raw : Array.from(raw);
        for (const handle of list) {
          const file = await handle.getFile();
          if (isVideoFile(file)) {
            loadVideoFromFile(file);
            return;
          }
        }
      } catch (_) {
        /* ignore */
      } finally {
        pendingOsFileOpen = false;
      }
    });
  }

  function applyDemoSampleIfNeeded() {
    if (isExternalEmbedSource()) return;
    if (hasCustomSource || pendingOsFileOpen || pendingNativeInitial || blobUrl) return;
    if (video.currentSrc) return;
    video.src = DEMO_SAMPLE_URL;
    if (fileNameEl instanceof HTMLElement) fileNameEl.textContent = "";
    video.load();
    syncPreviewVideoSrc();
    syncPlaybackRateSelect();
    applyZoomTransform();
    updateTimeDisplay();
    video.play().catch(() => {});
    setState(!video.paused);
  }

  window.addEventListener("load", () => {
    applyDemoSampleIfNeeded();
    window.setTimeout(applyDemoSampleIfNeeded, 350);
  });

  function syncPreviewVideoSrc() {
    const src = video.currentSrc || video.src;
    if (!src) {
      previewVideo.removeAttribute("src");
      previewVideo.load();
      return;
    }
    if (previewVideo.src === src) return;
    previewVideo.src = src;
    previewVideo.load();
  }

  function clearPreviewCanvas() {
    const ctx = previewCanvas.getContext("2d");
    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
  }

  /** Thumbnail only; the hover timestamp is updated from the pointer (`formatTime(t)`) so it tracks immediately. */
  function drawPreviewCanvas() {
    const ctx = previewCanvas.getContext("2d");
    if (!previewVideo.videoWidth) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
      ctx.drawImage(previewVideo, 0, 0, PREVIEW_W, PREVIEW_H);
    } catch (_) {
      ctx.fillStyle = "#222";
      ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
    }
  }

  function setScrubPreviewVisible(show) {
    scrubPreviewActive = show;
    scrubPreview.hidden = !show;
    if (!show) {
      previewDesiredTime = null;
      previewSeekInFlight = false;
      previewSeekGen += 1;
      if (previewSeekRaf != null) {
        cancelAnimationFrame(previewSeekRaf);
        previewSeekRaf = null;
      }
    }
  }

  function hideScrubPreview() {
    setScrubPreviewVisible(false);
    clearPreviewCanvas();
    lastPreviewClientX = null;
    scrubPreview.style.removeProperty("--scrub-preview-w");
    scrubPreview.style.removeProperty("--scrub-preview-h");
  }

  /** Progress track plus a few pixels so preview still shows when hovering slightly off the bar. */
  const SCRUB_HIT_PAD_PX = 6;

  function isPointOverScrubHitZone(clientX, clientY) {
    const r = progress.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const p = SCRUB_HIT_PAD_PX;
    return (
      clientX >= r.left - p &&
      clientX <= r.right + p &&
      clientY >= r.top - p &&
      clientY <= r.bottom + p
    );
  }

  /** While scrubbing, touch often leaves the thin hit strip vertically; still map X to the track. */
  function clampClientXToProgressWrap(clientX) {
    const rect = progressWrap.getBoundingClientRect();
    if (rect.width <= 0) return clientX;
    return Math.min(rect.right, Math.max(rect.left, clientX));
  }

  function syncScrubPreviewToPointer(clientX, clientY) {
    if (isExternalEmbedSource()) {
      if (scrubPreviewActive) hideScrubPreview();
      return;
    }
    const dur = video.duration;
    const durOk = Number.isFinite(dur) && dur > 0;
    const scrubbing = player.dataset.scrubbing === "true";
    if (!durOk) {
      if (scrubPreviewActive && !scrubbing) hideScrubPreview();
      return;
    }
    const over = isPointOverScrubHitZone(clientX, clientY);
    /* Coarse/touch: only show preview while scrubbing (touch began on the bar), not when a
       vertical swipe merely crosses the hit zone. Mouse keeps hover-to-preview. */
    const showFromHover = over && !usesCoarsePrimaryPointer;
    if (scrubbing || showFromHover) {
      if (!scrubPreviewActive) {
        setScrubPreviewVisible(true);
        clearPreviewCanvas();
        if (previewTimeEl instanceof HTMLElement) previewTimeEl.textContent = "";
      }
      const cx = scrubbing ? clampClientXToProgressWrap(clientX) : clientX;
      updateScrubPreviewFromClientX(cx);
    } else if (scrubPreviewActive) {
      hideScrubPreview();
    }
  }

  function endProgressScrubIfNeeded(e) {
    if (player.dataset.scrubbing !== "true") return;
    if (
      e instanceof PointerEvent &&
      scrubPointerId != null &&
      e.pointerId !== scrubPointerId
    ) {
      return;
    }
    let endClientX;
    let endClientY;
    if (e instanceof TouchEvent && e.changedTouches.length) {
      const tid = scrubTouchId;
      for (let i = 0; i < e.changedTouches.length; i += 1) {
        const t = e.changedTouches[i];
        if (tid == null || t.identifier === tid) {
          endClientX = t.clientX;
          endClientY = t.clientY;
          break;
        }
      }
    } else if (e instanceof PointerEvent) {
      endClientX = e.clientX;
      endClientY = e.clientY;
    }
    const capId = scrubPointerId;
    if (capId != null) {
      try {
        if (progress.hasPointerCapture(capId)) {
          progress.releasePointerCapture(capId);
        }
      } catch (_) {
        /* ignore */
      }
    }
    scrubPointerId = null;
    scrubTouchId = null;
    player.dataset.scrubbing = "false";
    syncProgressFromVideo();
    armChromeIdleTimer();
    if (
      endClientX != null &&
      endClientY != null &&
      !isPointOverScrubHitZone(endClientX, endClientY)
    ) {
      hideScrubPreview();
    }
  }

  function timeAtProgressClientX(clientX) {
    const rect = progressWrap.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return null;
    return ratio * dur;
  }

  /**
   * Size and place the scrub preview inside the player. Width uses the same cap as mid-track
   * (vertical space, track width, player width) — it does not shrink when the pointer is near the
   * ends; only horizontal position shifts until the pointer moves inward.
   */
  function layoutScrubPreviewAtRatio(ratio) {
    const wrap = progressWrap.getBoundingClientRect();
    const pr = player.getBoundingClientRect();
    if (wrap.width <= 0) return;

    const pw = wrap.width;
    const r = Math.min(1, Math.max(0, ratio));
    const playerPad = 4;

    const spaceAbove = wrap.top - pr.top - 8;
    let timeBlock = 22;
    if (previewTimeEl instanceof HTMLElement && scrubPreviewActive) {
      const th = Math.ceil(previewTimeEl.getBoundingClientRect().height);
      if (th > 0) timeBlock = th;
    }
    const gap = 4;
    const maxCanvasH = Math.max(24, spaceAbove - gap - timeBlock);
    const maxWVert = maxCanvasH * (16 / 9);

    const maxWTrack = pw * 0.98;
    const maxWPlayer = Math.max(1, pr.width - 2 * playerPad);
    let w = Math.floor(Math.min(160, maxWVert, maxWTrack, maxWPlayer));
    w = Math.max(24, w);

    let lo;
    let hi;
    for (;;) {
      const minCWrap = w / 2;
      const maxCWrap = pw - w / 2;
      const minCPlayer = pr.left + playerPad + w / 2 - wrap.left;
      const maxCPlayer = pr.right - playerPad - w / 2 - wrap.left;
      lo = Math.max(minCWrap, minCPlayer);
      hi = Math.min(maxCWrap, maxCPlayer);
      if (lo <= hi || w <= 24) break;
      w -= 4;
    }

    const centerPx = lo <= hi ? Math.min(Math.max(r * pw, lo), hi) : pw / 2;
    const xPct = (centerPx / pw) * 100;
    scrubPreview.style.left = `${xPct}%`;
    const h = Math.round((w * 9) / 16);
    scrubPreview.style.setProperty("--scrub-preview-w", `${w}px`);
    scrubPreview.style.setProperty("--scrub-preview-h", `${h}px`);
  }

  function positionScrubPreview(clientX) {
    const rect = progressWrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    lastPreviewClientX = clientX;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    layoutScrubPreviewAtRatio(ratio);
  }

  function schedulePreviewSeek(t) {
    previewDesiredTime = t;
    if (previewSeekRaf != null) return;
    previewSeekRaf = requestAnimationFrame(() => {
      previewSeekRaf = null;
      attemptPreviewSeek();
    });
  }

  /**
   * One seek at a time on the hidden preview element (same idea as `stepByFrame`): fast hovers
   * update `previewDesiredTime` and the pipeline drains after each `seeked` without overlapping
   * `currentTime` assignments that confuse the decoder.
   */
  function attemptPreviewSeek() {
    if (!scrubPreviewActive || previewDesiredTime == null) return;
    const dur = previewVideo.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;

    const want = Math.min(Math.max(0, previewDesiredTime), dur - 1e-3);

    if (previewSeekInFlight) return;

    if (Math.abs(previewVideo.currentTime - want) < 0.02) {
      drawPreviewCanvas();
      return;
    }

    previewSeekInFlight = true;
    previewSeekInFlightGen = (previewSeekGen += 1);
    try {
      previewVideo.currentTime = want;
    } catch (_) {
      previewSeekInFlight = false;
    }
  }

  function updateScrubPreviewFromClientX(clientX) {
    const t = timeAtProgressClientX(clientX);
    if (t == null) return;
    lastScrubTime = t;
    if (previewTimeEl instanceof HTMLElement) previewTimeEl.textContent = formatTime(t);
    positionScrubPreview(clientX);
    schedulePreviewSeek(t);
    /* Touch scrub uses document `touchmove` + preventDefault so the native range does not emit
       `input`; keep the thumb and main video in sync with the pointer. */
    if (player.dataset.scrubbing === "true") {
      const dur = video.duration;
      if (Number.isFinite(dur) && dur > 0) {
        const ratio = Math.min(1, Math.max(0, t / dur));
        progress.value = String(Math.round(ratio * 1000));
        video.currentTime = t;
        updateTimeDisplay();
      }
    }
  }

  function updateScrubPreviewFromRatio(ratio) {
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const clamped = Math.min(1, Math.max(0, ratio));
    const t = clamped * dur;
    lastScrubTime = t;
    if (previewTimeEl instanceof HTMLElement) previewTimeEl.textContent = formatTime(t);
    const rect = progressWrap.getBoundingClientRect();
    lastPreviewClientX = rect.left + clamped * rect.width;
    layoutScrubPreviewAtRatio(clamped);
    schedulePreviewSeek(t);
  }

  previewVideo.addEventListener("loadedmetadata", () => {
    if (scrubPreviewActive) schedulePreviewSeek(lastScrubTime);
  });

  previewVideo.addEventListener("seeked", () => {
    if (!scrubPreviewActive) {
      previewSeekInFlight = false;
      return;
    }
    const doneGen = previewSeekInFlightGen;
    previewSeekInFlight = false;
    // Same rhythm as frame-step UI: paint after seeked, then chain the next pending target on rAF.
    requestAnimationFrame(() => {
      if (!scrubPreviewActive) return;
      if (doneGen === previewSeekGen) drawPreviewCanvas();
      requestAnimationFrame(() => {
        if (!scrubPreviewActive) return;
        attemptPreviewSeek();
      });
    });
  });

  /** Wall-clock style with milliseconds (1/1000 s). */
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00.000";
    const msTotal = Math.round(seconds * 1000);
    const ms = msTotal % 1000;
    const totalS = Math.floor(msTotal / 1000);
    const s = totalS % 60;
    const m = Math.floor(totalS / 60) % 60;
    const h = Math.floor(totalS / 3600);
    const pad = (n) => String(n).padStart(2, "0");
    const padMs = (n) => String(n).padStart(3, "0");
    const dec = `.${padMs(ms)}`;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}${dec}` : `${m}:${pad(s)}${dec}`;
  }

  function updateTimeDisplay() {
    const cur = video.currentTime;
    const dur = video.duration;
    timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  }

  function syncProgressFromVideo() {
    const dur = video.duration;
    if (!dur || !Number.isFinite(dur)) {
      progress.value = 0;
      return;
    }
    const ratio = video.currentTime / dur;
    progress.value = String(Math.round(ratio * 1000));
  }

  function setState(playing) {
    player.dataset.state = playing ? "playing" : "paused";
    playPause.setAttribute("aria-label", playing ? "Pause" : "Play");
    playPause.dataset.tooltip = playing
      ? "Pause (Space)"
      : "Play (Space)";
  }

  function setMutedUI() {
    const silentByGain =
      webAudioVolumeRoute &&
      webAudioGain &&
      !video.muted &&
      !video.paused &&
      webAudioGain.gain.value <= 0.0005;
    player.dataset.muted =
      video.muted || (!webAudioVolumeRoute && video.volume === 0) || silentByGain
        ? "true"
        : "false";
    muteBtn.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    muteBtn.dataset.tooltip = video.muted ? "Unmute (M)" : "Mute (M)";
  }

  const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  function playbackRateIndex() {
    const cur = video.playbackRate;
    let bestI = 0;
    for (let i = 1; i < PLAYBACK_RATES.length; i += 1) {
      if (
        Math.abs(PLAYBACK_RATES[i] - cur) <
        Math.abs(PLAYBACK_RATES[bestI] - cur)
      ) {
        bestI = i;
      }
    }
    return bestI;
  }

  function syncPlaybackRateSelect() {
    const r = video.playbackRate;
    const exact = PLAYBACK_RATES.find((x) => Math.abs(x - r) < 0.0001);
    if (exact !== undefined) {
      playbackRateSelect.value = String(exact);
    } else {
      playbackRateSelect.value = String(PLAYBACK_RATES[playbackRateIndex()]);
    }
    requestAnimationFrame(() => syncRatePillWidthToZoom());
  }

  function nudgePlaybackRate(deltaSteps) {
    const i = Math.max(
      0,
      Math.min(
        PLAYBACK_RATES.length - 1,
        playbackRateIndex() + deltaSteps
      )
    );
    video.playbackRate = PLAYBACK_RATES[i];
    playbackRateSelect.value = String(PLAYBACK_RATES[i]);
    requestAnimationFrame(() => syncRatePillWidthToZoom());
  }

  playbackRateSelect.addEventListener("change", () => {
    const v = Number(playbackRateSelect.value);
    if (Number.isFinite(v)) video.playbackRate = v;
  });

  wireHeldChromeButton(rateDownBtn, () => nudgePlaybackRate(-1));
  wireHeldChromeButton(rateUpBtn, () => nudgePlaybackRate(1));

  function wireFrameStepButton(btn, direction) {
    if (!(btn instanceof HTMLElement)) return;
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      lastFrameStepViaPointer = true;
      if (direction < 0) {
        framePointerHeldBack = true;
        framePointerHoldRepeatReadyBack = false;
      } else {
        framePointerHeldForward = true;
        framePointerHoldRepeatReadyForward = false;
      }
      armPointerFrameHoldRepeat(direction);
      stepByFrame(direction);
    });
    btn.addEventListener("click", (e) => {
      if (lastFrameStepViaPointer) {
        lastFrameStepViaPointer = false;
        return;
      }
      stepByFrame(direction);
    });
    btn.addEventListener("lostpointercapture", () => {
      disarmPointerFrameHoldRepeat(direction);
      if (direction < 0) framePointerHeldBack = false;
      else framePointerHeldForward = false;
      bumpChromeActivity();
    });
  }

  wireFrameStepButton(frameBackBtn, -1);
  wireFrameStepButton(frameForwardBtn, 1);

  window.addEventListener(
    "pointerup",
    (e) => {
      if (e.button !== 0) return;
      disarmPointerFrameHoldRepeat(-1);
      disarmPointerFrameHoldRepeat(1);
      framePointerHeldBack = false;
      framePointerHeldForward = false;
      disarmAllChromePointerHolds();
      requestAnimationFrame(() => {
        lastFrameStepViaPointer = false;
        bumpChromeActivity();
      });
    },
    true
  );

  video.addEventListener("ratechange", () => {
    syncPlaybackRateSelect();
  });

  video.addEventListener("timeupdate", () => {
    if (player.dataset.scrubbing !== "true") syncProgressFromVideo();
    updateTimeDisplay();
  });

  video.addEventListener("loadedmetadata", () => {
    framePeriodSamples.length = 0;
    lastMediaTime = null;
    syncPreviewVideoSrc();
    syncPlaybackRateSelect();
    updateTimeDisplay();
    syncProgressFromVideo();
  });

  video.addEventListener("play", () => {
    setState(true);
    lastMediaTime = null;
    startFramePeriodMeasure();
    if (webAudioVolumeRoute && webAudioCtx) {
      void webAudioCtx.resume();
      /* Pause may zero gain to flush buffered samples; restore loudness when playing again. */
      setWebAudioOutputGainFromControls();
    }
  });

  video.addEventListener("pause", () => {
    setState(false);
    stopFramePeriodMeasure();
    /*
     * Mobile WebKit: `MediaElementAudioSourceNode` can keep playing decoded audio briefly
     * after `video.pause()`. Force the gain to zero immediately so pause feels silent.
     */
    if (webAudioVolumeRoute && webAudioGain && webAudioCtx) {
      try {
        webAudioGain.gain.setValueAtTime(0, webAudioCtx.currentTime);
      } catch (_) {
        webAudioGain.gain.value = 0;
      }
    }
  });

  video.addEventListener("volumechange", () => {
    if (!webAudioVolumeRoute) {
      volumeSlider.value = String(video.volume);
    }
    setMutedUI();
  });

  function togglePlay() {
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  playPause.addEventListener("click", togglePlay);

  function blockNativeVideoDrag(e) {
    e.preventDefault();
  }

  video.addEventListener("dragstart", blockNativeVideoDrag);
  videoViewport.addEventListener("dragstart", blockNativeVideoDrag);
  zoomLayer.addEventListener("dragstart", blockNativeVideoDrag);

  function syncPinchChromeSuppression() {
    const suppress =
      viewportPointers.size >= 2 && isTwoFingerTouchPinch();
    if (suppress) hideScrubPreview();
  }

  function beginPinchFromCurrentDistance() {
    if (pinchState) return true;
    const d = getViewportPinchDistance();
    if (d < PINCH_MIN_START_DIST_PX) return false;
    pinchState = { lastDist: d };
    videoViewport.classList.add("player__viewport--pinch");
    releasePanPointerCapture();
    return true;
  }

  function applyPinchZoomMove(e) {
    if (!pinchState) return;
    const d = getViewportPinchDistance();
    const anchor = getViewportPinchAnchor();
    if (!anchor || pinchState.lastDist <= 0) return;
    let factor = d / pinchState.lastDist;
    factor = Math.max(PINCH_FACTOR_MIN, Math.min(PINCH_FACTOR_MAX, factor));
    setZoomLevel(zoomLevel * factor, anchor);
    pinchState.lastDist = d;
    e.preventDefault();
  }

  videoViewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (isExternalEmbedSource()) return;
    viewportPointers.set(e.pointerId, {
      clientX: e.clientX,
      clientY: e.clientY,
      pointerType: e.pointerType,
    });

    if (viewportPointers.size === 2 && isTwoFingerTouchPinch()) {
      if (panPointer) panPointer.tapCancelled = true;
      if (beginPinchFromCurrentDistance()) e.preventDefault();
      syncPinchChromeSuppression();
      return;
    }

    if (viewportPointers.size === 2) {
      syncPinchChromeSuppression();
      return;
    }

    player.focus({ preventScroll: true });
    if (zoomLevel > 1.001) {
      e.preventDefault();
    }
    panPointer = {
      id: e.pointerId,
      cx: e.clientX,
      cy: e.clientY,
      ox: panX,
      oy: panY,
      dragged: false,
      tapCancelled: false,
      downT: performance.now(),
    };
    if (zoomLevel > 1.001) {
      try {
        videoViewport.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      videoViewport.dataset.panning = "true";
    }
    syncPinchChromeSuppression();
  });

  videoViewport.addEventListener("pointermove", (e) => {
    const tracked = viewportPointers.get(e.pointerId);
    if (tracked) {
      tracked.clientX = e.clientX;
      tracked.clientY = e.clientY;
      tracked.pointerType = e.pointerType;
    }

    if (viewportPointers.size === 2 && isTwoFingerTouchPinch()) {
      if (!pinchState) beginPinchFromCurrentDistance();
      if (pinchState) {
        applyPinchZoomMove(e);
        return;
      }
    }

    if (!panPointer || e.pointerId !== panPointer.id) return;
    const dx = e.clientX - panPointer.cx;
    const dy = e.clientY - panPointer.cy;
    if (
      zoomLevel <= 1.001 &&
      !panPointer.tapCancelled &&
      (Math.abs(dx) > VIEWPORT_TAP_CANCEL_MOVE_PX ||
        Math.abs(dy) > VIEWPORT_TAP_CANCEL_MOVE_PX)
    ) {
      panPointer.tapCancelled = true;
    }
    if (zoomLevel <= 1.001) return;
    if (!panPointer.dragged && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      panPointer.dragged = true;
    }
    if (panPointer.dragged) {
      panX = panPointer.ox + dx;
      panY = panPointer.oy + dy;
      clampPan();
      applyZoomTransform();
    }
  });

  function endViewportPointer(e) {
    viewportPointers.delete(e.pointerId);
    if (viewportPointers.size === 0) {
      requestAnimationFrame(() => bumpChromeActivity());
    }
    syncPinchChromeSuppression();

    if (pinchState && viewportPointers.size < 2) {
      pinchState = null;
      videoViewport.classList.remove("player__viewport--pinch");
      promoteRemainingFingerToPan();
      syncPinchChromeSuppression();
      return;
    }

    if (!panPointer || e.pointerId !== panPointer.id) return;
    const dragged = panPointer.dragged;
    const tapCancelled = panPointer.tapCancelled;
    const holdMs = performance.now() - (panPointer.downT ?? performance.now());
    panPointer = null;
    try {
      if (videoViewport.hasPointerCapture(e.pointerId)) {
        videoViewport.releasePointerCapture(e.pointerId);
      }
    } catch (_) {
      /* ignore */
    }
    videoViewport.dataset.panning = "false";
    const tapQuickEnough = holdMs <= VIEWPORT_TAP_MAX_DURATION_MS;
    if (!dragged && zoomLevel <= 1.001 && !tapCancelled && tapQuickEnough) togglePlay();
  }

  videoViewport.addEventListener("pointerup", endViewportPointer);
  videoViewport.addEventListener("pointercancel", endViewportPointer);

  const IDLE_UI_MS = usesCoarsePrimaryPointer ? 3800 : 2000;
  let chromeIdleTimer = null;

  /** True while a continuous interaction should keep the HUD up without a running idle timer. */
  function isChromeInteractionHold() {
    if (pinchState) return true;
    if (player.dataset.scrubbing === "true") return true;
    if (frameKeyHeldBack || frameKeyHeldForward) return true;
    if (framePointerHeldBack || framePointerHeldForward) return true;
    if (zoomKbDelayId != null || zoomKbIntervalId != null) return true;
    if (rateKbDelayId != null || rateKbIntervalId != null) return true;
    if (chromePointerHoldDisarms.size > 0) return true;
    return false;
  }

  function clearChromeIdleTimer() {
    if (chromeIdleTimer != null) {
      clearTimeout(chromeIdleTimer);
      chromeIdleTimer = null;
    }
  }

  function exitChromeIdle() {
    player.classList.remove("player--idle");
  }

  function armChromeIdleTimer() {
    if (isChromeInteractionHold()) {
      clearChromeIdleTimer();
      exitChromeIdle();
      return;
    }
    clearChromeIdleTimer();
    exitChromeIdle();
    chromeIdleTimer = setTimeout(() => {
      chromeIdleTimer = null;
      if (isChromeInteractionHold()) {
        return;
      }
      const ae = document.activeElement;
      if (
        ae instanceof HTMLElement &&
        ((chromeEl && chromeEl.contains(ae)) ||
          (cornerTools && cornerTools.contains(ae)) ||
          (cornerVolume && cornerVolume.contains(ae)))
      ) {
        ae.blur();
      }
      requestAnimationFrame(() => {
        if (isChromeInteractionHold()) return;
        player.classList.add("player--idle");
      });
    }, IDLE_UI_MS);
  }

  function bumpChromeActivity() {
    if (isChromeInteractionHold()) {
      clearChromeIdleTimer();
      exitChromeIdle();
      return;
    }
    armChromeIdleTimer();
  }

  /** Mobile: tap outside #player hides chrome immediately (idle timer is too slow). */
  function dismissChromeForOutsideTap() {
    if (!usesCoarsePrimaryPointer) return;
    clearChromeIdleTimer();
    player.classList.add("player--idle");
    player.classList.add("player--pointer-outside");
    const ae = document.activeElement;
    if (
      ae instanceof HTMLElement &&
      player.contains(ae) &&
      ((chromeEl && chromeEl.contains(ae)) ||
        (cornerTools && cornerTools.contains(ae)) ||
        (cornerVolume && cornerVolume.contains(ae)))
    ) {
      ae.blur();
    }
    hideScrubPreview();
  }

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!usesCoarsePrimaryPointer || e.button !== 0) return;
      if (!(e.target instanceof Node) || !document.documentElement.contains(e.target)) return;
      if (player.contains(e.target)) return;
      if (player.dataset.scrubbing === "true") return;
      if (isChromeInteractionHold()) return;
      dismissChromeForOutsideTap();
    },
    true
  );

  player.addEventListener("pointermove", bumpChromeActivity);
  player.addEventListener("pointerenter", () => {
    pointerInsidePlayer = true;
    player.classList.remove("player--pointer-outside");
    bumpChromeActivity();
  });
  /* Bubble so videoViewport pointerdown runs first and viewportPointers reflects two-finger pinch. */
  player.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Node && player.contains(e.target)) {
      player.classList.remove("player--pointer-outside");
      if (e.pointerType === "touch") {
        activeTouchPointersOnPlayer.add(e.pointerId);
        pointerInsidePlayer = true;
      }
    }
    bumpChromeActivity();
  });
  function forgetPlayerTouchPointer(e) {
    if (e.pointerType !== "touch") return;
    activeTouchPointersOnPlayer.delete(e.pointerId);
  }
  document.addEventListener("pointerup", forgetPlayerTouchPointer, true);
  document.addEventListener("pointercancel", forgetPlayerTouchPointer, true);
  /** Long-press / synthetic “right click”: capture on `document` so it still runs if a child swallows the event. */
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!(e.target instanceof Node) || !player.contains(e.target)) return;
      const cap = e.sourceCapabilities;
      const hoverNone =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(hover: none)").matches;
      const touchLike =
        (cap && cap.firesTouchEvents === true) ||
        e.pointerType === "touch" ||
        (activeTouchPointersOnPlayer.size > 0 && hoverNone);
      if (!touchLike) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
  player.addEventListener("wheel", bumpChromeActivity, { passive: true });
  player.addEventListener("focusin", (e) => {
    if (!(e.target instanceof Node)) return;
    const inChrome = chromeEl && chromeEl.contains(e.target);
    const inCorner = cornerTools && cornerTools.contains(e.target);
    const inCornerVolume = cornerVolume && cornerVolume.contains(e.target);
    if (!inChrome && !inCorner && !inCornerVolume) return;
    exitChromeIdle();
    armChromeIdleTimer();
  });

  /** Touch/stylus leave the window as “mouse” moves; only treat real mouse/pen leave as “outside”. */
  player.addEventListener("pointerleave", (e) => {
    pointerInsidePlayer = false;
    if (e.pointerType === "touch") return;
    clearChromeIdleTimer();
    exitChromeIdle();
    player.classList.add("player--pointer-outside");
  });

  player.addEventListener(
    "wheel",
    (e) => {
      if (isExternalEmbedSource()) return;
      const pr = player.getBoundingClientRect();
      if (
        e.clientX < pr.left ||
        e.clientX > pr.right ||
        e.clientY < pr.top ||
        e.clientY > pr.bottom
      ) {
        return;
      }
      e.preventDefault();
      zoomFromWheel(e.deltaY, e.clientX, e.clientY);
    },
    { passive: false }
  );

  wireHeldChromeButton(zoomInBtn, () => adjustZoomByStep(1));
  wireHeldChromeButton(zoomOutBtn, () => adjustZoomByStep(-1));
  zoomResetBtn.addEventListener("click", () => setZoomLevel(1));

  new ResizeObserver(() => {
    clampPan();
    applyZoomTransform();
  }).observe(videoViewport);

  document.addEventListener("pointermove", (e) => {
    if (
      pinchState ||
      (viewportPointers.size >= 2 && isTwoFingerTouchPinch())
    ) {
      return;
    }
    const scrubbing = player.dataset.scrubbing === "true";
    const pr = player.getBoundingClientRect();
    const outsidePlayer =
      e.clientX < pr.left ||
      e.clientX > pr.right ||
      e.clientY < pr.top ||
      e.clientY > pr.bottom;
    if (!outsidePlayer) {
      player.classList.remove("player--pointer-outside");
    } else if (!scrubbing && !isChromeInteractionHold()) {
      clearChromeIdleTimer();
      exitChromeIdle();
      player.classList.add("player--pointer-outside");
    }
    if (outsidePlayer) {
      if (scrubPreviewActive && !scrubbing) hideScrubPreview();
      if (!scrubbing) return;
    }
    syncScrubPreviewToPointer(e.clientX, e.clientY);
  });

  progress.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    video.pause();
    player.dataset.scrubbing = "true";
    scrubPointerId = e.pointerId;
    try {
      progress.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    syncScrubPreviewToPointer(e.clientX, e.clientY);
    bumpChromeActivity();
  });

  progress.addEventListener("pointermove", (e) => {
    if (player.dataset.scrubbing !== "true") return;
    if (scrubPointerId != null && e.pointerId !== scrubPointerId) return;
    syncScrubPreviewToPointer(e.clientX, e.clientY);
    bumpChromeActivity();
  });

  progress.addEventListener("input", () => {
    const dur = video.duration;
    if (!dur || !Number.isFinite(dur)) return;
    video.pause();
    const t = (Number(progress.value) / 1000) * dur;
    video.currentTime = t;
    updateTimeDisplay();
    if (scrubPreviewActive || player.dataset.scrubbing === "true") {
      if (!scrubPreviewActive) {
        setScrubPreviewVisible(true);
        clearPreviewCanvas();
        if (previewTimeEl instanceof HTMLElement) previewTimeEl.textContent = "";
      }
      updateScrubPreviewFromRatio(Number(progress.value) / 1000);
    }
    if (player.dataset.scrubbing === "true") bumpChromeActivity();
  });

  progress.addEventListener("pointerup", (e) => endProgressScrubIfNeeded(e));
  document.addEventListener("pointerup", (e) => endProgressScrubIfNeeded(e));

  progress.addEventListener("pointercancel", (e) => {
    if (player.dataset.scrubbing !== "true") return;
    if (scrubPointerId != null && e.pointerId !== scrubPointerId) return;
    const capId = scrubPointerId;
    if (capId != null) {
      try {
        if (progress.hasPointerCapture(capId)) {
          progress.releasePointerCapture(capId);
        }
      } catch (_) {
        /* ignore */
      }
    }
    scrubPointerId = null;
    scrubTouchId = null;
    player.dataset.scrubbing = "false";
    syncProgressFromVideo();
    hideScrubPreview();
    armChromeIdleTimer();
  });

  progress.addEventListener(
    "touchstart",
    (e) => {
      const ct = e.changedTouches[0];
      if (!(ct.target === progress || progress.contains(ct.target))) return;
      video.pause();
      player.dataset.scrubbing = "true";
      scrubTouchId = ct.identifier;
      syncScrubPreviewToPointer(ct.clientX, ct.clientY);
      bumpChromeActivity();
    },
    { passive: true }
  );

  function touchForActiveScrub(e) {
    if (scrubTouchId != null) {
      const t = [...e.touches].find((x) => x.identifier === scrubTouchId);
      if (t) return t;
    }
    if (scrubPointerId != null && e.touches.length === 1) return e.touches[0];
    return null;
  }

  document.addEventListener(
    "touchmove",
    (e) => {
      if (player.dataset.scrubbing !== "true") return;
      const t = touchForActiveScrub(e);
      if (!t) return;
      e.preventDefault();
      const pr = player.getBoundingClientRect();
      const inside =
        t.clientX >= pr.left &&
        t.clientX <= pr.right &&
        t.clientY >= pr.top &&
        t.clientY <= pr.bottom;
      if (inside) player.classList.remove("player--pointer-outside");
      syncScrubPreviewToPointer(t.clientX, t.clientY);
      bumpChromeActivity();
    },
    { passive: false }
  );

  function endTouchScrubIfLifted(e) {
    if (player.dataset.scrubbing !== "true" || scrubTouchId == null) return;
    for (let i = 0; i < e.changedTouches.length; i += 1) {
      if (e.changedTouches[i].identifier === scrubTouchId) {
        endProgressScrubIfNeeded(e);
        return;
      }
    }
  }

  document.addEventListener("touchend", endTouchScrubIfLifted, true);
  document.addEventListener("touchcancel", endTouchScrubIfLifted, true);

  function onVolumeSliderInteraction() {
    applyVolumeFromSlider();
  }
  volumeSlider.addEventListener("input", onVolumeSliderInteraction);
  volumeSlider.addEventListener("change", onVolumeSliderInteraction);
  if (volumeSlider instanceof HTMLElement) {
    volumeSlider.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      volPointerBaseline = Number(volumeSlider.value);
    });
    volumeSlider.addEventListener("pointerup", () => {
      volPointerBaseline = null;
    });
    volumeSlider.addEventListener("pointercancel", () => {
      volPointerBaseline = null;
    });
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    loadVideoFromFile(file);
  });

  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    e.preventDefault();
  });

  window.addEventListener("drop", (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) {
      loadVideoFromFile(dt.files[0]);
      return;
    }
    const uriList = dt.getData("text/uri-list");
    const plain = dt.getData("text/plain");
    const uri = (uriList && uriList.split("\n")[0].trim()) || (plain && plain.trim());
    if (uri) tryLoadFromUrlString(uri);
  });

  function submitUrlField() {
    if (!(urlInput instanceof HTMLInputElement)) return;
    tryLoadFromUrlString(urlInput.value);
  }

  if (loadUrlBtn instanceof HTMLElement) {
    loadUrlBtn.addEventListener("click", submitUrlField);
  }
  if (urlInput instanceof HTMLInputElement) {
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitUrlField();
      }
    });
  }

  muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    if (webAudioVolumeRoute && webAudioGain && webAudioCtx) {
      if (!video.muted) {
        let sv = Number(volumeSlider.value);
        if (sv === 0 || !Number.isFinite(sv)) {
          volumeSlider.value = "1";
        }
      }
      setWebAudioOutputGainFromControls();
      void webAudioCtx.resume();
    } else if (!video.muted) {
      const sv = Number(volumeSlider.value);
      if (sv === 0) {
        volumeSlider.value = "1";
        if (elementVolumeControlsOutput) {
          video.volume = 1;
        } else {
          applyVolumeFromSlider();
        }
      }
    }
    setMutedUI();
  });

  function syncPipVisibility() {
    if (!(pipBtn instanceof HTMLElement)) return;
    if (video.disablePictureInPicture === true) {
      pipBtn.hidden = true;
      return;
    }
    pipBtn.hidden = typeof video.requestPictureInPicture !== "function";
  }

  syncPipVisibility();

  pipBtn.addEventListener("click", async () => {
    if (video.disablePictureInPicture === true) return;
    if (typeof video.requestPictureInPicture !== "function") return;
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      /* user gesture / policy */
    }
  });

  fullscreenBtn.addEventListener("click", async () => {
    /*
     * Match v1.1.10: toggle on #player via the standard Fullscreen API first (works in the site
     * iframe on Windows). Exit both standard and WebKit document fullscreen when needed — using
     * only exitFullscreen() misses webkitFullscreenElement on some builds and left "stuck" toggles.
     */
    if (
      !isExternalEmbedSource() &&
      !document.fullscreenElement &&
      !document.webkitFullscreenElement &&
      video.webkitDisplayingFullscreen === true &&
      typeof video.webkitExitFullscreen === "function"
    ) {
      try {
        video.webkitExitFullscreen();
      } catch (_) {
        /* not allowed */
      }
      return;
    }

    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
      } catch (_) {
        /* not allowed */
      }
      try {
        if (document.webkitExitFullscreen && document.webkitFullscreenElement) {
          await document.webkitExitFullscreen();
        }
      } catch (_) {
        /* not allowed */
      }
      return;
    }

    try {
      await player.requestFullscreen();
      return;
    } catch (_) {
      /* not allowed */
    }
    try {
      if (typeof player.webkitRequestFullscreen === "function") {
        await player.webkitRequestFullscreen();
        return;
      }
    } catch (_) {
      /* not allowed */
    }

    if (isExternalEmbedSource()) return;

    try {
      if (typeof video.requestFullscreen === "function") {
        await video.requestFullscreen();
        return;
      }
    } catch (_) {
      /* not allowed */
    }
    if (typeof video.webkitEnterFullscreen === "function") {
      try {
        video.webkitEnterFullscreen();
      } catch (_) {
        /* not allowed */
      }
    }
  });

  function isEditableFocusOutsidePlayer() {
    const ae = document.activeElement;
    if (!(ae instanceof HTMLElement)) return false;
    if (player.contains(ae)) return false;
    if (ae.isContentEditable) return true;
    const tag = ae.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "SELECT") return true;
    if (tag === "INPUT") {
      const type = (ae.type || "text").toLowerCase();
      if (
        type === "button" ||
        type === "checkbox" ||
        type === "radio" ||
        type === "file" ||
        type === "range" ||
        type === "color" ||
        type === "submit" ||
        type === "reset" ||
        type === "hidden"
      ) {
        return false;
      }
      return true;
    }
    return false;
  }

  function shouldHandlePlayerKeyboard(e) {
    if (isExternalEmbedSource()) return false;
    const t = e.target;
    if (t === player || (t instanceof Node && player.contains(t))) return true;
    if (!pointerInsidePlayer) return false;
    if (isEditableFocusOutsidePlayer()) return false;
    return true;
  }

  function onPlayerKeydown(e) {
    if (!shouldHandlePlayerKeyboard(e)) return;
    bumpChromeActivity();
    if (e.code === "BracketLeft") {
      e.preventDefault();
      if (e.repeat) return;
      rateKbKeydown(-1);
      return;
    }
    if (e.code === "BracketRight") {
      e.preventDefault();
      if (e.repeat) return;
      rateKbKeydown(1);
      return;
    }
    if (isZoomInKeyEvent(e)) {
      e.preventDefault();
      if (e.repeat) return;
      zoomKbKeydown(1);
      return;
    }
    if (isZoomOutKeyEvent(e)) {
      e.preventDefault();
      if (e.repeat) return;
      zoomKbKeydown(-1);
      return;
    }
    const frameDir = frameStepDirectionFromKeyEvent(e);
    if (frameDir != null) {
      e.preventDefault();
      if (e.repeat) return;
      if (frameDir === -1) {
        frameKeyHeldBack = true;
        frameKeyHoldRepeatReadyBack = false;
      } else {
        frameKeyHeldForward = true;
        frameKeyHoldRepeatReadyForward = false;
      }
      armKeyboardFrameHoldRepeat(frameDir);
      stepByFrame(frameDir);
      return;
    }
    const step = 5;
    switch (e.key) {
      case " ":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - step);
        break;
      case "ArrowRight":
        e.preventDefault();
        video.currentTime = Math.min(
          video.duration || Infinity,
          video.currentTime + step
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        bumpVolumeKeyboard(0.1);
        break;
      case "ArrowDown":
        e.preventDefault();
        bumpVolumeKeyboard(-0.1);
        break;
      case "m":
      case "M":
        e.preventDefault();
        muteBtn.click();
        break;
      case "f":
      case "F":
        e.preventDefault();
        fullscreenBtn.click();
        break;
      case "0":
        e.preventDefault();
        if (!e.repeat) setZoomLevel(1);
        break;
      default:
        break;
    }
  }

  function onPlayerKeyup(e) {
    if (!shouldHandlePlayerKeyboard(e)) return;
    const frameDir = frameStepDirectionFromKeyEvent(e);
    if (frameDir != null) {
      clearFrameKeyboardHoldDirection(frameDir);
      bumpChromeActivity();
    }
    if (e.code === "BracketLeft") rateKbKeyup(-1);
    if (e.code === "BracketRight") rateKbKeyup(1);
    if (isZoomInKeyEvent(e)) zoomKbKeyup(1);
    if (isZoomOutKeyEvent(e)) zoomKbKeyup(-1);
  }

  document.addEventListener("keydown", onPlayerKeydown, true);
  document.addEventListener("keyup", onPlayerKeyup, true);

  window.addEventListener("blur", () => {
    clearAllFrameHold();
    disarmZoomRateKeyboardHolds();
    disarmAllChromePointerHolds();
    pointerInsidePlayer = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      clearAllFrameHold();
      disarmZoomRateKeyboardHolds();
      disarmAllChromePointerHolds();
    }
  });

  player.tabIndex = 0;

  if (tooltipLayer) {
    function hideTooltip() {
      tooltipLayer.hidden = true;
      tooltipLayer.textContent = "";
    }

    /** True if `node` is inside the interactive subtree of a `[data-tooltip]` host (not just a DOM ancestor). */
    function isPointerOverTooltipHost(node) {
      if (!(node instanceof Element)) return false;
      const host = node.closest("[data-tooltip]");
      if (!host) return false;
      if (host.closest("#player")) {
        const tag = host.tagName;
        if (tag === "BUTTON" || tag === "LABEL" || tag === "SELECT") return true;
        if (host.matches(".player__rate-select-wrap")) return true;
        return false;
      }
      return true;
    }

    function showTooltipFor(el) {
      const text = el.getAttribute("data-tooltip");
      if (!text) {
        hideTooltip();
        return;
      }
      const hostPlayer = el.closest("#player");
      if (hostPlayer instanceof HTMLElement) {
        const probe =
          playPause instanceof HTMLElement ? playPause : hostPlayer.querySelector(".player__btn");
        if (probe instanceof HTMLElement) {
          tooltipLayer.style.fontSize = getComputedStyle(probe).fontSize;
        } else {
          tooltipLayer.style.removeProperty("font-size");
        }
      } else {
        tooltipLayer.style.removeProperty("font-size");
      }
      tooltipLayer.textContent = text;
      tooltipLayer.hidden = false;
      const r = el.getBoundingClientRect();
      const marginEm = 0.55;
      const fs = parseFloat(getComputedStyle(tooltipLayer).fontSize) || 14;
      const margin = Math.max(6, Math.round(fs * marginEm));
      const w = tooltipLayer.offsetWidth;
      const h = tooltipLayer.offsetHeight;
      let top = r.top - h - margin;
      let left = r.left + (r.width - w) / 2;
      if (top < margin) top = r.bottom + margin;
      left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
      tooltipLayer.style.left = `${Math.round(left)}px`;
      tooltipLayer.style.top = `${Math.round(top)}px`;
    }

    document.addEventListener(
      "pointerover",
      (e) => {
        if (!(e.target instanceof Element)) return;
        if (!isPointerOverTooltipHost(e.target)) {
          hideTooltip();
          return;
        }
        const el = e.target.closest("[data-tooltip]");
        if (!el) {
          hideTooltip();
          return;
        }
        showTooltipFor(el);
      },
      true
    );

    document.addEventListener(
      "pointerout",
      (e) => {
        if (!(e.target instanceof Element)) return;
        const host = e.target.closest("[data-tooltip]");
        if (!host) return;
        const rt = e.relatedTarget;
        if (rt instanceof Node && host.contains(rt)) return;
        if (rt instanceof Element) {
          const nextHost = rt.closest("[data-tooltip]");
          if (nextHost && nextHost !== host) return;
        }
        hideTooltip();
      },
      true
    );

    player.addEventListener("pointerleave", hideTooltip);

    document.addEventListener("scroll", hideTooltip, true);
    window.addEventListener("resize", hideTooltip);

    document.addEventListener("focusin", (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest("#player")) return;
      const el = e.target.closest("[data-tooltip]");
      if (el) showTooltipFor(el);
      else hideTooltip();
    });

    document.addEventListener("focusout", () => {
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (!(a instanceof Element)) {
          hideTooltip();
          return;
        }
        if (a.closest("#player")) {
          hideTooltip();
          return;
        }
        const host = a.closest("[data-tooltip]");
        if (!host) hideTooltip();
        else showTooltipFor(host);
      });
    });
  }

  window.addEventListener("pagehide", (e) => {
    clearChromeIdleTimer();
    exitChromeIdle();
    stopFramePeriodMeasure();
    setScrubPreviewVisible(false);
    if (tooltipLayer) {
      tooltipLayer.hidden = true;
      tooltipLayer.textContent = "";
    }
    if (!e.persisted) {
      exitYoutubeMode();
      revokeBlobUrl();
      hasCustomSource = false;
    }
  });

  volumeSlider.value = String(video.volume);
  syncVolumeSliderLockedUI();
  setMutedUI();
  setState(!video.paused);
  syncPreviewVideoSrc();
  syncPlaybackRateSelect();
  applyZoomTransform();
  updateTimeDisplay();

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      syncRatePillWidthToZoom();
      if (scrubPreviewActive && lastPreviewClientX != null) {
        positionScrubPreview(lastPreviewClientX);
      }
    });
    ro.observe(player);
    if (zoomGroup instanceof HTMLElement) ro.observe(zoomGroup);
    if (cornerTools instanceof HTMLElement) ro.observe(cornerTools);
  }
  window.addEventListener("resize", syncRatePillWidthToZoom);

  if (typeof window.videoPlayerNative !== "undefined") {
    pendingNativeInitial = true;
    window.videoPlayerNative
      .getInitialVideoPayload()
      .then((payload) => {
        pendingNativeInitial = false;
        if (payload && payload.url) {
          loadVideoFromNativePayload(payload);
          return;
        }
        applyDemoSampleIfNeeded();
      })
      .catch(() => {
        pendingNativeInitial = false;
        applyDemoSampleIfNeeded();
      });

    window.videoPlayerNative.onOpenVideoPayload((payload) => {
      if (payload && payload.url) loadVideoFromNativePayload(payload);
    });
  }
})();
