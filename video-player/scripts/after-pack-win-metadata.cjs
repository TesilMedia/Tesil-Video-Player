"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const rcedit = require("rcedit");
const toIco = require("to-ico");

const projectRoot = path.join(__dirname, "..");
const iconPngPath = path.join(projectRoot, "build", "icon.png");

/**
 * With `signAndEditExecutable: false`, electron-builder skips its bundled rcedit step, so the
 * unpacked exe keeps default Electron version strings and icon. Patch strings + icon here
 * using `rcedit` and `to-ico` (no winCodeSign unpack).
 */
module.exports = async (context) => {
  if (context.electronPlatformName !== "win32") return;

  const { appOutDir } = context;
  const appInfo = context.packager.appInfo;
  const exePath = path.join(appOutDir, `${appInfo.productFilename}.exe`);
  if (!fs.existsSync(exePath)) return;

  const fileVersion = appInfo.shortVersion || appInfo.buildVersion;
  const productVersion =
    appInfo.shortVersionWindows != null
      ? appInfo.shortVersionWindows
      : appInfo.getVersionInWeirdWindowsForm();

  const versionString = {
    FileDescription: appInfo.productName,
    ProductName: appInfo.productName,
    LegalCopyright: appInfo.copyright,
  };
  const company = appInfo.companyName;
  if (company) {
    versionString.CompanyName = company;
  }

  const options = {
    "version-string": versionString,
    "file-version": fileVersion,
    "product-version": productVersion,
  };

  let tmpIco = null;
  if (fs.existsSync(iconPngPath)) {
    const icoBuf = await toIco([fs.readFileSync(iconPngPath)], { resize: true });
    tmpIco = path.join(os.tmpdir(), `tesil-vp-icon-${process.pid}-${Date.now()}.ico`);
    fs.writeFileSync(tmpIco, icoBuf);
    options.icon = tmpIco;
  }

  try {
    await rcedit(exePath, options);
  } finally {
    if (tmpIco) {
      try {
        fs.unlinkSync(tmpIco);
      } catch (_) {
        /* ignore */
      }
    }
  }
};
