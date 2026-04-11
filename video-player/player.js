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

  const PREVIEW_W = 160;
  const PREVIEW_H = 90;

  let blobUrl = null;
  let scrubPreviewActive = false;
  /** Last pointer X while preview is shown; used to reflow size on resize. */
  let lastPreviewClientX = null;
  let previewSeekRaf = null;
  /** Latest scrub time while preview is active; not cleared until seek pipeline catches up or hide. */
  let previewDesiredTime = null;
  let previewSeekInFlight = false;
  let lastScrubTime = 0;

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 0.25;

  let zoomLevel = 1;
  let panX = 0;
  let panY = 0;
  let panPointer = null;

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
    const w = zoomGroup.offsetWidth;
    if (w > 0) ratePill.style.width = `${w}px`;
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

  function frameHeldForDirection(direction) {
    return direction < 0
      ? frameKeyHeldBack || framePointerHeldBack
      : frameKeyHeldForward || framePointerHeldForward;
  }

  /** Suppresses stale `seeked` UI when a newer frame-step seek was started. */
  let frameStepGen = 0;

  function stepByFrame(direction) {
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
        // Paused video: `requestVideoFrameCallback` often never fires, so holds would stop after
        // one frame. `requestAnimationFrame` runs after the seeked paint path on the main thread.
        requestAnimationFrame(() => {
          if (!frameHeldForDirection(direction)) return;
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
    if (direction === -1) frameKeyHeldBack = false;
    else frameKeyHeldForward = false;
  }

  function clearAllFrameHold() {
    frameKeyHeldBack = false;
    frameKeyHeldForward = false;
    framePointerHeldBack = false;
    framePointerHeldForward = false;
    lastFrameStepViaPointer = false;
  }

  function revokeBlobUrl() {
    previewVideo.removeAttribute("src");
    previewVideo.load();
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  }

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

  function drawPreviewCanvas() {
    if (scrubPreviewActive && previewTimeEl instanceof HTMLElement) {
      const ct = previewVideo.currentTime;
      if (Number.isFinite(ct)) previewTimeEl.textContent = formatTime(ct);
    }
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

  function syncScrubPreviewToPointer(clientX, clientY) {
    const durOk = Number.isFinite(video.duration) && video.duration > 0;
    const over = durOk && isPointOverScrubHitZone(clientX, clientY);
    if (over) {
      if (!scrubPreviewActive) {
        setScrubPreviewVisible(true);
        clearPreviewCanvas();
        if (previewTimeEl instanceof HTMLElement) previewTimeEl.textContent = "";
      }
      updateScrubPreviewFromClientX(clientX);
    } else if (scrubPreviewActive) {
      hideScrubPreview();
    }
  }

  function endProgressScrubIfNeeded(e) {
    if (player.dataset.scrubbing !== "true") return;
    player.dataset.scrubbing = "false";
    syncProgressFromVideo();
    const ev = e;
    if (ev && "clientX" in ev && !isPointOverScrubHitZone(ev.clientX, ev.clientY)) {
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
   * One seek at a time on the hidden preview element; fast scrubs update previewDesiredTime and
   * drain after each seeked so the decoder is not flooded (smoother than overlapping seeks).
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
    positionScrubPreview(clientX);
    schedulePreviewSeek(t);
  }

  function updateScrubPreviewFromRatio(ratio) {
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const clamped = Math.min(1, Math.max(0, ratio));
    const t = clamped * dur;
    lastScrubTime = t;
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
    previewSeekInFlight = false;
    // Paused preview element: rVFC is unreliable; rAF runs after seek so the label matches the frame drawn.
    requestAnimationFrame(() => {
      if (!scrubPreviewActive) return;
      drawPreviewCanvas();
      requestAnimationFrame(() => {
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
    if (!video.duration || !Number.isFinite(video.duration)) {
      progress.value = 0;
      return;
    }
    const ratio = video.currentTime / video.duration;
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
    player.dataset.muted = video.muted || video.volume === 0 ? "true" : "false";
    muteBtn.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    muteBtn.dataset.tooltip = video.muted ? "Unmute (M)" : "Mute (M)";
  }

  const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

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
  }

  playbackRateSelect.addEventListener("change", () => {
    const v = Number(playbackRateSelect.value);
    if (Number.isFinite(v)) video.playbackRate = v;
  });

  rateDownBtn.addEventListener("click", () => nudgePlaybackRate(-1));
  rateUpBtn.addEventListener("click", () => nudgePlaybackRate(1));

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
      if (direction < 0) framePointerHeldBack = true;
      else framePointerHeldForward = true;
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
      if (direction < 0) framePointerHeldBack = false;
      else framePointerHeldForward = false;
    });
  }

  wireFrameStepButton(frameBackBtn, -1);
  wireFrameStepButton(frameForwardBtn, 1);

  window.addEventListener(
    "pointerup",
    (e) => {
      if (e.button !== 0) return;
      framePointerHeldBack = false;
      framePointerHeldForward = false;
      requestAnimationFrame(() => {
        lastFrameStepViaPointer = false;
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
  });

  video.addEventListener("pause", () => {
    setState(false);
    stopFramePeriodMeasure();
  });

  video.addEventListener("volumechange", () => {
    volumeSlider.value = String(video.volume);
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

  videoViewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
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
    };
    if (zoomLevel > 1.001) {
      try {
        videoViewport.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      videoViewport.dataset.panning = "true";
    }
  });

  videoViewport.addEventListener("pointermove", (e) => {
    if (!panPointer || e.pointerId !== panPointer.id) return;
    if (zoomLevel <= 1.001) return;
    const dx = e.clientX - panPointer.cx;
    const dy = e.clientY - panPointer.cy;
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
    if (!panPointer || e.pointerId !== panPointer.id) return;
    const dragged = panPointer.dragged;
    panPointer = null;
    try {
      if (videoViewport.hasPointerCapture(e.pointerId)) {
        videoViewport.releasePointerCapture(e.pointerId);
      }
    } catch (_) {
      /* ignore */
    }
    videoViewport.dataset.panning = "false";
    if (!dragged && zoomLevel <= 1.001) togglePlay();
  }

  videoViewport.addEventListener("pointerup", endViewportPointer);
  videoViewport.addEventListener("pointercancel", endViewportPointer);

  const IDLE_UI_MS = 2000;
  let chromeIdleTimer = null;

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
    clearChromeIdleTimer();
    exitChromeIdle();
    chromeIdleTimer = setTimeout(() => {
      chromeIdleTimer = null;
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
        player.classList.add("player--idle");
      });
    }, IDLE_UI_MS);
  }

  function bumpChromeActivity() {
    armChromeIdleTimer();
  }

  player.addEventListener("mousemove", bumpChromeActivity);
  player.addEventListener("mouseenter", () => {
    player.classList.remove("player--pointer-outside");
    bumpChromeActivity();
  });
  player.addEventListener("pointerdown", bumpChromeActivity, true);
  player.addEventListener("keydown", bumpChromeActivity, true);
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

  player.addEventListener("mouseleave", () => {
    clearChromeIdleTimer();
    exitChromeIdle();
    player.classList.add("player--pointer-outside");
  });

  player.addEventListener(
    "wheel",
    (e) => {
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

  zoomInBtn.addEventListener("click", () => adjustZoomByStep(1));
  zoomOutBtn.addEventListener("click", () => adjustZoomByStep(-1));
  zoomResetBtn.addEventListener("click", () => setZoomLevel(1));

  new ResizeObserver(() => {
    clampPan();
    applyZoomTransform();
  }).observe(videoViewport);

  document.addEventListener("pointermove", (e) => {
    const pr = player.getBoundingClientRect();
    if (
      e.clientX < pr.left ||
      e.clientX > pr.right ||
      e.clientY < pr.top ||
      e.clientY > pr.bottom
    ) {
      if (scrubPreviewActive) hideScrubPreview();
      return;
    }
    syncScrubPreviewToPointer(e.clientX, e.clientY);
  });

  progress.addEventListener("pointerdown", (e) => {
    player.dataset.scrubbing = "true";
    syncScrubPreviewToPointer(e.clientX, e.clientY);
  });

  progress.addEventListener("input", () => {
    if (!video.duration || !Number.isFinite(video.duration)) return;
    const t = (Number(progress.value) / 1000) * video.duration;
    video.currentTime = t;
    updateTimeDisplay();
    if (scrubPreviewActive) {
      updateScrubPreviewFromRatio(Number(progress.value) / 1000);
    }
  });

  progress.addEventListener("pointerup", (e) => endProgressScrubIfNeeded(e));
  document.addEventListener("pointerup", (e) => endProgressScrubIfNeeded(e));

  progress.addEventListener("pointercancel", () => {
    player.dataset.scrubbing = "false";
    syncProgressFromVideo();
    hideScrubPreview();
  });

  volumeSlider.addEventListener("input", () => {
    const v = Number(volumeSlider.value);
    video.volume = v;
    video.muted = v === 0;
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;

    revokeBlobUrl();
    blobUrl = URL.createObjectURL(file);
    video.src = blobUrl;
    fileNameEl.textContent = file.name;
    video.load();
    syncPreviewVideoSrc();
    video.playbackRate = 1;
    playbackRateSelect.value = "1";
    video.play().catch(() => {});
  });

  muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) {
      video.volume = 1;
      volumeSlider.value = "1";
    }
  });

  if (!document.pictureInPictureEnabled) {
    pipBtn.hidden = true;
  }

  pipBtn.addEventListener("click", async () => {
    if (!document.pictureInPictureEnabled) return;
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
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await player.requestFullscreen();
      }
    } catch {
      /* not allowed */
    }
  });

  player.addEventListener("keydown", (e) => {
    if (e.target !== player && !player.contains(e.target)) return;
    if (e.code === "BracketLeft") {
      e.preventDefault();
      if (!e.repeat) nudgePlaybackRate(-1);
      return;
    }
    if (e.code === "BracketRight") {
      e.preventDefault();
      if (!e.repeat) nudgePlaybackRate(1);
      return;
    }
    const frameDir = frameStepDirectionFromKeyEvent(e);
    if (frameDir != null) {
      e.preventDefault();
      if (e.repeat) return;
      if (frameDir === -1) frameKeyHeldBack = true;
      else frameKeyHeldForward = true;
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
        video.volume = Math.min(1, video.volume + 0.1);
        video.muted = false;
        volumeSlider.value = String(video.volume);
        break;
      case "ArrowDown":
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        volumeSlider.value = String(video.volume);
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
      case "+":
      case "=":
        e.preventDefault();
        if (!e.repeat) adjustZoomByStep(1);
        break;
      case "-":
      case "_":
        e.preventDefault();
        if (!e.repeat) adjustZoomByStep(-1);
        break;
      case "0":
        e.preventDefault();
        if (!e.repeat) setZoomLevel(1);
        break;
      default:
        break;
    }
  });

  player.addEventListener("keyup", (e) => {
    if (e.target !== player && !player.contains(e.target)) return;
    const frameDir = frameStepDirectionFromKeyEvent(e);
    if (frameDir != null) clearFrameKeyboardHoldDirection(frameDir);
  });

  window.addEventListener("blur", clearAllFrameHold);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") clearAllFrameHold();
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
    if (!e.persisted) revokeBlobUrl();
  });

  volumeSlider.value = String(video.volume);
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
})();
