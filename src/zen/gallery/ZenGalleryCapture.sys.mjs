/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenGalleryStore } from "resource:///modules/ZenGalleryStore.sys.mjs";
import { ScreenshotsUtils } from "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs";
import {
  setInterval,
  clearInterval,
} from "resource://gre/modules/Timer.sys.mjs";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;
const MAX_FILES = 5000;
const windows = new Map();
const pending = new Map();
let watcherTimer = null;
let scanning = false;
let generation = 0;
let candidates = new Map();
let lastWatcherError = false;

ChromeUtils.registerWindowActor("ZenGalleryCapture", {
  parent: { esModuleURI: "resource:///actors/ZenGalleryCaptureParent.sys.mjs" },
  child: {
    esModuleURI: "resource:///actors/ZenGalleryCaptureChild.sys.mjs",
    events: {
      dragstart: { capture: true },
      dragend: { capture: true },
      "Gallery:Download": {},
      "Gallery:Copy": {},
      "Gallery:Close": {},
      "Gallery:FocusPanel": {},
    },
  },
  matches: ["http://*/*", "https://*/*"],
  allFrames: false,
  safeForUntrustedWebProcess: true,
});

function requireUnlocked() {
  if (ZenGalleryStore.locked) {
    throw new Error("Unlock the gallery before saving images");
  }
}

function pageActor(browser) {
  if (
    !browser?.isConnected ||
    !browser.documentGlobal?.gBrowser ||
    !/^https?$/.test(browser.currentURI?.scheme)
  ) {
    throw new Error("Select an HTTP(S) page to capture");
  }
  return browser.browsingContext.currentWindowGlobal.getActor(
    "ZenGalleryCapture"
  );
}

function bound(actor, browser) {
  return (
    browser?.isConnected &&
    actor.manager === browser.browsingContext.currentWindowGlobal &&
    /^https?$/.test(browser.currentURI?.scheme)
  );
}

function dimensions(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 32766 ||
    height > 32766 ||
    width * height > MAX_PIXELS
  ) {
    throw new Error("Image exceeds gallery dimensions (32 megapixels)");
  }
}

function report(window, text) {
  if (window && !window.closed) {
    Services.prompt.alert(window, "Encrypted gallery", text);
  }
}

async function saveRegion(
  actor,
  browser,
  region,
  metadata,
  source,
  initial = {}
) {
  requireUnlocked();
  if (!bound(actor, browser)) {
    throw new Error("The page changed during capture");
  }
  const { left, top, right, bottom, devicePixelRatio: dpr } = region;
  if (
    ![left, top, right, bottom, dpr].every(Number.isFinite) ||
    dpr <= 0 ||
    dpr > 16
  ) {
    throw new Error("Invalid screenshot bounds");
  }
  dimensions(
    Math.ceil((Math.round(right) - Math.round(left)) * dpr),
    Math.ceil((Math.round(bottom) - Math.round(top)) * dpr)
  );
  const canvas = await ScreenshotsUtils.createCanvas({ ...region }, browser);
  try {
    const blob = await canvas.convertToBlob({ type: "image/png" });
    if (blob.size > MAX_BYTES || !bound(actor, browser)) {
      throw new Error("Screenshot too large or page changed");
    }
    requireUnlocked();
    return await ZenGalleryStore.add(new Uint8Array(await blob.arrayBuffer()), {
      ...initial,
      ...metadata,
      selectionText: metadata.selectionText || initial.selectionText || "",
      // The parent, not content, supplies the authoritative origin and timestamp.
      url: browser.currentURI.spec,
      origin: actor.manager.documentPrincipal.originNoSuffix,
      source,
      createdAt: Date.now(),
      width: canvas.width,
      height: canvas.height,
    });
  } finally {
    canvas.width = canvas.height = 1;
  }
}

// Check raster headers before allowing a decoder to allocate an image. No URL
// fetching is performed: watcher input is a bounded local byte array only.
function rasterType(bytes) {
  if (!bytes.length || bytes.length > MAX_BYTES) {
    throw new Error("Image exceeds gallery size");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, value) =>
    [...value].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    ascii(1, "PNG\r\n\x1a\n") &&
    ascii(12, "IHDR")
  ) {
    dimensions(view.getUint32(16), view.getUint32(20));
    return "image/png";
  }
  if (bytes.length >= 25 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    const uint24 = offset =>
      bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    const checkChunks = (start, end, inFrame = false) => {
      let imageFound = false;
      for (let offset = start; offset + 8 <= end; ) {
        const length = view.getUint32(offset + 4, true);
        const data = offset + 8;
        if (data + length > end) {
          throw new Error("Truncated WebP image");
        }
        if (ascii(offset, "VP8X") && length >= 10 && !inFrame) {
          dimensions(uint24(data + 4) + 1, uint24(data + 7) + 1);
        } else if (
          ascii(offset, "VP8 ") &&
          length >= 10 &&
          bytes[data + 3] === 0x9d &&
          bytes[data + 4] === 1 &&
          bytes[data + 5] === 0x2a
        ) {
          dimensions(
            view.getUint16(data + 6, true) & 0x3fff,
            view.getUint16(data + 8, true) & 0x3fff
          );
          imageFound = true;
        } else if (
          ascii(offset, "VP8L") &&
          length >= 5 &&
          bytes[data] === 0x2f
        ) {
          const bits = view.getUint32(data + 1, true);
          dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
          imageFound = true;
        } else if (ascii(offset, "ANMF")) {
          // Validate every frame before decoding, without copying its payload.
          if (length < 16 || inFrame) {
            throw new Error("Invalid WebP animation frame");
          }
          dimensions(uint24(data + 6) + 1, uint24(data + 9) + 1);
          checkChunks(data + 16, data + length, true);
          imageFound = true;
        }
        offset = data + length + (length & 1);
      }
      if (!imageFound) {
        throw new Error("Invalid WebP image");
      }
    };
    checkChunks(12, bytes.length);
    return "image/webp";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) {
        break;
      }
      while (bytes[offset] === 0xff) {
        offset++;
      }
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) {
        break;
      }
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) {
        break;
      }
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        return "image/jpeg";
      }
      offset += length;
    }
  }
  throw new Error("Only valid PNG, JPEG and WebP raster images are supported");
}

async function rasterize(bytes) {
  const type = rasterType(bytes);
  const window = Services.wm.getMostRecentWindow("navigator:browser");
  if (
    !window ||
    window.closed ||
    typeof window.createImageBitmap !== "function"
  ) {
    throw new Error(
      "Gallery image decoding requires an open browser window with createImageBitmap"
    );
  }
  const bitmap = await window.createImageBitmap(new Blob([bytes], { type }));
  let canvas;
  try {
    dimensions(bitmap.width, bitmap.height);
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    if (blob.size > MAX_BYTES) {
      throw new Error("Image exceeds gallery size");
    }
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
    if (canvas) {
      canvas.width = canvas.height = 1;
    }
  }
}

function hideDrop(state) {
  state.drag = null;
  state.zone?.remove();
  state.zone = null;
}

async function showDrop(actor, browser, token) {
  const window = browser.documentGlobal;
  const state = windows.get(window);
  if (
    !state ||
    ZenGalleryStore.locked ||
    window.gBrowser.selectedBrowser !== browser
  ) {
    return;
  }
  hideDrop(state);
  const drag = { actor, browser, token };
  state.drag = drag;
  const folders = await ZenGalleryStore.folders();
  if (state.drag !== drag || !bound(actor, browser) || ZenGalleryStore.locked) {
    return;
  }
  const doc = window.document;
  const zone = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  zone.id = "zen-gallery-drop-zone";
  zone.setAttribute("role", "region");
  zone.setAttribute("aria-label", "Save image to encrypted gallery");
  zone.style.cssText =
    "position:fixed;z-index:2147483647;bottom:32px;left:50%;transform:translateX(-50%);max-width:80vw;display:flex;flex-wrap:wrap;gap:8px;padding:16px;border-radius:18px;background:color-mix(in srgb,Canvas 80%,transparent);color:CanvasText;backdrop-filter:blur(24px);border:1px solid color-mix(in srgb,CanvasText 25%,transparent);box-shadow:0 8px 32px #0005";
  const chip = (name, folderId = "") => {
    const element = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    element.textContent = name;
    element.dataset.folderId = folderId;
    element.style.cssText =
      "padding:12px;border-radius:12px;backdrop-filter:blur(16px);background:color-mix(in srgb,Canvas 60%,transparent);border:1px solid color-mix(in srgb,CanvasText 20%,transparent)";
    zone.append(element);
  };
  chip("▣ Save to gallery");
  for (const folder of folders) {
    chip(folder.name, folder.id);
  }
  const valid = event =>
    event.isTrusted &&
    state.drag === drag &&
    event.dataTransfer?.sourceTopWindowContext === actor.manager &&
    bound(actor, browser) &&
    !ZenGalleryStore.locked;
  zone.addEventListener("dragover", event => {
    if (valid(event)) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    }
  });
  zone.addEventListener("drop", event => {
    if (!valid(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const folderId =
      event.target.closest("[data-folder-id]")?.dataset.folderId || "";
    hideDrop(state);
    (async () => {
      const result = await actor.sendQuery("Gallery:Drop", { token });
      requireUnlocked();
      if (!bound(actor, browser)) {
        throw new Error("The source page changed");
      }
      rasterType(result.bytes);
      await ZenGalleryStore.add(result.bytes, {
        ...result.metadata,
        url: browser.currentURI.spec,
        origin: actor.manager.documentPrincipal.originNoSuffix,
        createdAt: Date.now(),
        source: "drop",
        folderId,
      });
    })().catch(() =>
      report(
        window,
        "The image could not be saved. Use a PNG, JPEG or WebP image within the gallery size limits, and keep its source page open."
      )
    );
  });
  state.zone = zone;
  doc.documentElement.append(zone);
}

async function regularStat(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  if (file.isSymlink()) {
    return { type: "other" };
  }
  return IOUtils.stat(path);
}

async function listImages(folder) {
  const result = [];
  for (const path of await IOUtils.getChildren(folder)) {
    if (!/\.(png|jpe?g|webp)$/i.test(path)) {
      continue;
    }
    const stat = await regularStat(path);
    if (stat.type !== "regular" || !stat.size || stat.size > MAX_BYTES) {
      continue;
    }
    result.push({
      name: PathUtils.filename(path),
      size: stat.size,
      mtime: stat.lastModified,
    });
    if (result.length > MAX_FILES) {
      throw new Error(
        "Choose a screenshot folder with at most 5000 raster images"
      );
    }
  }
  return result;
}

const sameFile = (a, b) =>
  a && b && a.name === b.name && a.size === b.size && a.mtime === b.mtime;

// eslint-disable-next-line complexity
async function scanFolder() {
  if (scanning || ZenGalleryStore.locked || !windows.size) {
    return;
  }
  scanning = true;
  const epoch = generation;
  try {
    const { watchFolder: folder } = await ZenGalleryStore.settings();
    if (!folder) {
      candidates.clear();
      return;
    }
    const records = await listImages(folder);
    if (epoch !== generation || ZenGalleryStore.locked) {
      return;
    }
    let state = await ZenGalleryStore.getWatchState();
    if (!state?.initialized || state.folder !== folder) {
      // Enabling a folder establishes a baseline, never imports its history.
      await ZenGalleryStore.setWatchState({
        folder,
        files: records,
        initialized: true,
      });
      candidates.clear();
      return;
    }
    const names = new Set(records.map(file => file.name));
    const known = new Map(
      state.files
        .filter(file => names.has(file.name))
        .map(file => [file.name, file])
    );
    const nextCandidates = new Map();
    let invalidRaster = false;
    for (const file of records) {
      if (sameFile(known.get(file.name), file)) {
        continue;
      }
      const previous = candidates.get(file.name);
      if (!sameFile(previous?.file, file)) {
        let metadata = {};
        const active = Services.focus.activeWindow;
        if (windows.has(active)) {
          const browser = active.gBrowser.selectedBrowser;
          try {
            const actor = pageActor(browser);
            metadata = await actor.sendQuery("Gallery:Metadata");
            if (
              !bound(actor, browser) ||
              Services.focus.activeWindow !== active
            ) {
              metadata = {};
            } else {
              metadata.url = browser.currentURI.spec;
              metadata.origin = actor.manager.documentPrincipal.originNoSuffix;
            }
          } catch {}
        }
        nextCandidates.set(file.name, { file, metadata });
        continue;
      }
      if (epoch !== generation || ZenGalleryStore.locked) {
        return;
      }
      if (previous.invalid) {
        invalidRaster = true;
        nextCandidates.set(file.name, previous);
        continue;
      }
      const path = PathUtils.join(folder, file.name);
      if ((await regularStat(path)).type !== "regular") {
        continue;
      }
      const bytes = await IOUtils.read(path, { maxBytes: MAX_BYTES + 1 });
      const stat = await regularStat(path);
      if (
        stat.type !== "regular" ||
        stat.size !== file.size ||
        stat.lastModified !== file.mtime
      ) {
        continue;
      }
      let png;
      try {
        png = await rasterize(bytes);
      } catch {
        invalidRaster = true;
        nextCandidates.set(file.name, { ...previous, invalid: true });
        continue;
      }
      if (
        epoch !== generation ||
        ZenGalleryStore.locked ||
        (await ZenGalleryStore.settings()).watchFolder !== folder
      ) {
        return;
      }
      await ZenGalleryStore.add(png, {
        ...previous.metadata,
        source: "system",
        createdAt: file.mtime,
      });
      known.set(file.name, file);
      state = { folder, files: [...known.values()], initialized: true };
      // Bookkeeping is persisted only after encrypted import, and before any
      // destructive action. It contains names/paths only inside ciphertext.
      await ZenGalleryStore.setWatchState(state);
      const window = Services.wm.getMostRecentWindow("navigator:browser");
      if (window && !ZenGalleryStore.locked && epoch === generation) {
        const remove = Services.prompt.confirmEx(
          window,
          "Screenshot imported",
          `The screenshot was saved in the encrypted gallery. Delete the original file “${file.name}” from the watched folder?`,
          Services.prompt.STD_YES_NO_BUTTONS |
            Services.prompt.BUTTON_POS_1_DEFAULT,
          null,
          null,
          null,
          null,
          {}
        );
        if (remove === 0) {
          const current = await regularStat(path);
          if (
            current.type === "regular" &&
            current.size === file.size &&
            current.lastModified === file.mtime
          ) {
            await IOUtils.remove(path);
          }
        }
      }
    }
    if (epoch !== generation || ZenGalleryStore.locked) {
      return;
    }
    // Prune removed files without forgetting unchanged files still in the folder.
    const files = [...known.values()].filter(file => names.has(file.name));
    if (files.length !== state.files.length) {
      await ZenGalleryStore.setWatchState({ folder, files, initialized: true });
    }
    candidates = nextCandidates;
    if (invalidRaster && !lastWatcherError) {
      report(
        Services.wm.getMostRecentWindow("navigator:browser"),
        "Some new images were not imported because they are invalid or exceed the gallery size limits. Their originals were retained."
      );
    }
    lastWatcherError = invalidRaster;
  } catch {
    if (!ZenGalleryStore.locked && !lastWatcherError) {
      lastWatcherError = true;
      report(
        Services.wm.getMostRecentWindow("navigator:browser"),
        "System screenshot import could not complete. Originals were retained. Check the selected screenshot folder, image size and gallery storage."
      );
    }
  } finally {
    scanning = false;
  }
}

function stopSensitiveWork() {
  generation++;
  candidates.clear();
  for (const state of windows.values()) {
    hideDrop(state);
  }
  for (const [actor, operation] of pending) {
    try {
      actor.sendAsyncMessage("Gallery:Cancel");
    } catch {
      // The actor can be destroyed during a simultaneous navigation and lock.
    }
    operation.reject(new Error("Gallery capture cancelled"));
  }
  pending.clear();
}

Services.obs.addObserver(
  {
    observe(_subject, _topic, data) {
      if (data === "locked") {
        stopSensitiveWork();
      } else if (data === "unlocked") {
        void scanFolder();
      }
    },
  },
  "zen-gallery-state"
);

export const ZenGalleryCapture = {
  startup(window) {
    if (!window.gBrowser || windows.has(window)) {
      return;
    }
    const state = { zone: null, drag: null };
    windows.set(window, state);
    const cancel = () => {
      hideDrop(state);
      for (const [actor, operation] of pending) {
        if (operation.browser.documentGlobal === window) {
          try {
            actor.sendAsyncMessage("Gallery:Cancel");
          } catch {
            // Closing a tab can destroy its actor before TabSelect is delivered.
          }
          pending.delete(actor);
          operation.reject(
            new Error("Capture cancelled because the selected tab changed")
          );
        }
      }
    };
    window.gBrowser.tabContainer.addEventListener("TabSelect", cancel);
    window.addEventListener(
      "unload",
      () => {
        cancel();
        window.gBrowser.tabContainer.removeEventListener("TabSelect", cancel);
        windows.delete(window);
        if (!windows.size) {
          clearInterval(watcherTimer);
          watcherTimer = null;
          stopSensitiveWork();
        }
      },
      { once: true }
    );
    if (!watcherTimer) {
      watcherTimer = setInterval(scanFolder, 3000);
    }
    void scanFolder();
  },

  async capture(browser, mode = "area") {
    requireUnlocked();
    if (!["area", "element", "visible", "full"].includes(mode)) {
      throw new Error("Unsupported capture mode");
    }
    const actor = pageActor(browser);
    if (pending.has(actor)) {
      throw new Error("A screenshot selection is already active");
    }
    const window = browser.documentGlobal;
    this.startup(window);
    window.gBrowser.selectedTab = window.gBrowser.getTabForBrowser(browser);
    window.focus();
    browser.focus();
    if (mode === "visible" || mode === "full") {
      const result = await actor.sendQuery("Gallery:Bounds", { mode });
      return saveRegion(actor, browser, result.region, result.metadata, mode);
    }
    const metadata = await actor.sendQuery("Gallery:Metadata");
    const token = Services.uuid.generateUUID().toString();
    return new Promise((resolve, reject) => {
      pending.set(actor, { token, browser, metadata, resolve, reject });
      actor.sendQuery("Gallery:Start", { token, mode }).catch(error => {
        pending.delete(actor);
        reject(error);
      });
    });
  },

  receive(actor, browser, message) {
    if (message.name === "Gallery:Drag") {
      if (
        typeof message.data?.token === "string" &&
        message.data.token.length < 80
      ) {
        void showDrop(actor, browser, message.data.token).catch(() => {});
      }
      return;
    }
    if (message.name === "Gallery:DragEnd") {
      const state = windows.get(browser.documentGlobal);
      if (state?.drag?.actor === actor) {
        hideDrop(state);
      }
      return;
    }
    const operation = pending.get(actor);
    if (
      !operation ||
      operation.browser !== browser ||
      operation.token !== message.data?.token ||
      !bound(actor, browser)
    ) {
      return;
    }
    pending.delete(actor);
    if (message.name === "Gallery:Cancelled") {
      operation.reject(new Error("Screenshot selection cancelled"));
    } else if (message.name === "Gallery:Region") {
      saveRegion(
        actor,
        browser,
        message.data.region,
        message.data.metadata,
        message.data.source === "element" ? "element" : "area",
        operation.metadata
      ).then(operation.resolve, operation.reject);
    }
  },

  actorDestroyed(actor) {
    const operation = pending.get(actor);
    if (operation) {
      pending.delete(actor);
      operation.reject(new Error("The capture page closed or navigated"));
    }
    for (const state of windows.values()) {
      if (state.drag?.actor === actor) {
        hideDrop(state);
      }
    }
  },

  async chooseWatchFolder(window) {
    requireUnlocked();
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(
      window.browsingContext,
      "Choose your system screenshot folder (new images only)",
      Ci.nsIFilePicker.modeGetFolder
    );
    const result = await new Promise(resolve => picker.open(resolve));
    if (result !== Ci.nsIFilePicker.returnOK) {
      return false;
    }
    const folder = picker.file.path;
    const files = await listImages(folder);
    requireUnlocked();
    generation++;
    candidates.clear();
    await ZenGalleryStore.setWatchState({ folder, files, initialized: true });
    await ZenGalleryStore.setSettings({ watchFolder: folder });
    this.startup(window);
    return true;
  },

  async disableWatcher() {
    requireUnlocked();
    generation++;
    candidates.clear();
    await ZenGalleryStore.setSettings({ watchFolder: "" });
    await ZenGalleryStore.setWatchState({
      folder: "",
      files: [],
      initialized: false,
    });
  },
};

export const startup = window => ZenGalleryCapture.startup(window);
export const capture = (browser, mode) =>
  ZenGalleryCapture.capture(browser, mode);
