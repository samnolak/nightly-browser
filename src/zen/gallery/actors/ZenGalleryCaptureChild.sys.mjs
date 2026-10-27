/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ScreenshotsComponentChild } from "resource:///actors/ScreenshotsComponentChild.sys.mjs";

const MAX_PIXELS = 32_000_000;
const MAX_BYTES = 64 * 1024 * 1024;

export class ZenGalleryCaptureChild extends ScreenshotsComponentChild {
  #token = null;
  #drag = null;

  #page() {
    const url = new URL(this.document.documentURI);
    if (
      !/^https?:$/.test(url.protocol) ||
      this.browsingContext !== this.browsingContext.top
    ) {
      throw new Error("Gallery capture requires a top-level HTTP(S) page");
    }
    const win = this.contentWindow;
    const meta = name =>
      this.document
        .querySelector(`meta[property="${name}"], meta[name="${name}"]`)
        ?.content?.slice(0, 2048) || "";
    const safeURL = value => {
      try {
        if (!value) {
          return "";
        }
        const parsed = new URL(value, url);
        return /^https?:$/.test(parsed.protocol) &&
          !parsed.username &&
          !parsed.password
          ? parsed.href.slice(0, 8192)
          : "";
      } catch {
        return "";
      }
    };
    const icon = safeURL(
      this.document.querySelector('link[rel~="icon"]')?.href
    );
    return {
      url: url.href,
      origin: url.origin,
      title: this.document.title.slice(0, 2048),
      favicon: icon,
      viewport: {
        w: win.innerWidth,
        h: win.innerHeight,
        dpr: win.devicePixelRatio,
      },
      scroll: { x: win.scrollX, y: win.scrollY },
      selectionText: win.getSelection()?.toString().slice(0, 8192) || "",
      pageMeta: {
        ogTitle: meta("og:title"),
        ogImage: safeURL(meta("og:image")),
        description: meta("description"),
        author: meta("author"),
        publishedAt: meta("article:published_time"),
      },
    };
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "Gallery:Metadata":
        return this.#page();
      case "Gallery:Start": {
        this.#page();
        const token = message.data.token;
        this.#token = token;
        if (!(await this.startScreenshotsOverlay())) {
          this.#token = null;
          throw new Error("Screenshot selection could not start");
        }
        await this.overlay.updateWindowDimensions();
        if (this.#token !== token) {
          this.endScreenshotsOverlay();
          throw new Error("Screenshot selection cancelled");
        }
        // The native overlay retains its keyboard and element hit-testing behavior,
        // but neither its buttons nor its shortcuts may export gallery captures.
        this.overlay.copyButton.style.display = "none";
        const save = this.overlay.downloadButton;
        save.textContent = "Save to gallery";
        save.setAttribute("aria-label", "Save to gallery");
        save.setAttribute("title", "Save encrypted screenshot to gallery");
        return true;
      }
      case "Gallery:Bounds": {
        const metadata = this.#page();
        if (!(await this.startScreenshotsOverlay())) {
          throw new Error("Screenshot bounds unavailable");
        }
        await this.overlay.updateWindowDimensions();
        try {
          return {
            region:
              message.data.mode === "full"
                ? this.getFullPageBounds()
                : this.getVisibleBounds(),
            metadata,
          };
        } finally {
          this.endScreenshotsOverlay();
        }
      }
      case "Gallery:Cancel":
        this.#token = null;
        this.endScreenshotsOverlay();
        return null;
      case "Gallery:Drop": {
        const drag = this.#drag;
        this.#drag = null;
        if (
          !drag ||
          drag.token !== message.data.token ||
          Date.now() - drag.at > 60_000 ||
          !drag.image.isConnected
        ) {
          throw new Error("Image drag expired");
        }
        this.#page();
        const image = drag.image;
        const request = image
          .QueryInterface(Ci.nsIImageLoadingContent)
          .getRequest(Ci.nsIImageLoadingContent.CURRENT_REQUEST);
        if (
          !request ||
          !["image/png", "image/jpeg", "image/webp"].includes(request.mimeType)
        ) {
          throw new Error("Only PNG, JPEG and WebP images can be imported");
        }
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (
          !width ||
          !height ||
          width > 32766 ||
          height > 32766 ||
          width * height > MAX_PIXELS
        ) {
          throw new Error("Image exceeds gallery dimensions");
        }
        const canvas = new OffscreenCanvas(width, height);
        try {
          canvas.getContext("2d").drawImage(image, 0, 0);
          const blob = await canvas.convertToBlob({ type: "image/png" });
          if (blob.size > MAX_BYTES) {
            throw new Error("Image exceeds gallery size");
          }
          return {
            bytes: new Uint8Array(await blob.arrayBuffer()),
            metadata: drag.metadata,
          };
        } finally {
          canvas.width = canvas.height = 1;
        }
      }
    }
    return null;
  }

  addEventListeners() {
    // Set this before initialize() emits any events. Native screenshots must
    // never receive this overlay's actions (including copy keyboard shortcuts).
    this.overlay.eventPrefix = "Gallery";
    super.addEventListeners();
  }

  handleEvent(event) {
    if (!event.isTrusted) {
      return;
    }
    if (event.type.startsWith("Gallery:")) {
      if (!this.#token || !this.overlay?.initialized) {
        return;
      }
      // Do not forward these to super: its switch recognizes Screenshots:*.
      // Only trusted chrome-only overlay events may consume the parent token.
      switch (event.type) {
        case "Gallery:Download":
        case "Gallery:Copy":
          this.requestDownloadScreenshot(event.detail.region);
          break;
        case "Gallery:Close":
          this.requestCancelScreenshot();
          break;
        case "Gallery:FocusPanel":
          this.overlay.focus(event.detail.direction);
          break;
      }
      return;
    }
    if (event.type === "dragstart") {
      try {
        const image = event
          .composedPath()
          .find(node => node?.localName === "img");
        if (!image || image.ownerDocument !== this.document) {
          return;
        }
        const metadata = this.#page();
        this.#drag = {
          image,
          metadata,
          token: Services.uuid.generateUUID().toString(),
          at: Date.now(),
        };
        this.sendAsyncMessage("Gallery:Drag", {
          token: this.#drag.token,
          screenX: event.screenX,
          screenY: event.screenY,
        });
      } catch {
        this.#drag = null;
      }
      return;
    }
    if (event.type === "dragend") {
      // The chrome drop query can arrive after dragend; retain only briefly.
      const drag = this.#drag;
      this.contentWindow.setTimeout(() => {
        if (this.#drag === drag) {
          this.#drag = null;
        }
      }, 2000);
      this.sendAsyncMessage("Gallery:DragEnd");
      return;
    }
    super.handleEvent(event);
  }

  requestCopyScreenshot(region) {
    this.requestDownloadScreenshot(region);
  }

  requestDownloadScreenshot(region) {
    if (!this.#token) {
      return;
    }
    const token = this.#token;
    this.#token = null;
    const metadata = this.#page();
    const methods = this.overlay.methodsUsed;
    const source = methods.element > 0 && !methods.region ? "element" : "area";
    const win = this.contentWindow;
    // Hit-test only after the overlay is removed: while it is shown the page
    // root, not the captured element, receives elementFromPoint.
    this.endScreenshotsOverlay();
    const element = this.document.elementFromPoint(
      region.left - win.scrollX + 1,
      region.top - win.scrollY + 1
    );
    if (source === "element" && element) {
      metadata.selector = (
        element.id ? `#${win.CSS.escape(element.id)}` : element.localName
      ).slice(0, 2048);
    }
    this.sendAsyncMessage("Gallery:Region", {
      token,
      region: { ...region, devicePixelRatio: win.devicePixelRatio },
      metadata,
      source,
    });
  }

  requestCancelScreenshot() {
    const token = this.#token;
    this.#token = null;
    this.endScreenshotsOverlay();
    this.sendAsyncMessage("Gallery:Cancelled", { token });
  }
}
