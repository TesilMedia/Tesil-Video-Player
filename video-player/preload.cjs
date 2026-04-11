"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("videoPlayerNative", {
  isPackagedApp: true,
  getInitialVideoPayload: () => ipcRenderer.invoke("get-initial-video-payload"),
  onOpenVideoPayload: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on("open-video-file", listener);
    return () => {
      ipcRenderer.removeListener("open-video-file", listener);
    };
  },
});
