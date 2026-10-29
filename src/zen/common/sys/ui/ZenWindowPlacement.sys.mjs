// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { ZenUIComponent } from "resource:///modules/zen/ui/ZenUIComponent.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "screenManager", () =>
  Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager)
);

// Screens come and go in bursts (a lock or sleep drops every display, a
// placeholder takes their place, then they return one by one); the burst is
// over once no change has come for this long.
const SETTLE_MS = 2000;
// A place the window has kept this long outside a burst is where the user put
// it.
const STABLE_MS = 1000;
const SIZEMODE_WAIT_MS = 1500;

function rectOf(screen) {
  const left = {},
    top = {},
    width = {},
    height = {};
  screen.GetRectDisplayPix(left, top, width, height);
  return {
    left: left.value,
    top: top.value,
    width: width.value,
    height: height.value,
  };
}

function sameRect(a, b) {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * Keeps a browser window on the display the user put it on.
 *
 * While the screen is locked or the Mac sleeps, macOS drops the displays and
 * moves every window onto whatever display is left, and when the displays come
 * back it does not always move them home: the window can end up on another
 * monitor (one that is off, so it looks gone) and stays there, persisted, on
 * the next launch too. This component remembers the window's place while the
 * displays are steady and, once a change of displays has settled, moves the
 * window back to that place if its display is there again.
 */
export class ZenWindowPlacement extends ZenUIComponent {
  #home = null;
  #layout = null;
  #layoutChanged = false;
  #moved = false;
  #settleTimer = null;
  #stableTimer = null;

  init() {
    this.#remember();
    Services.obs.addObserver(this, "screen-information-changed");
    this.window.windowRoot.addEventListener("MozUpdateWindowPos", this);
    this.addEventListener("resize");
    this.addEventListener("sizemodechange");
  }

  uninit() {
    Services.obs.removeObserver(this, "screen-information-changed");
    this.window.windowRoot.removeEventListener("MozUpdateWindowPos", this);
    this.window.clearTimeout(this.#settleTimer);
    this.window.clearTimeout(this.#stableTimer);
  }

  /** The place the window goes back to; for tests. */
  get home() {
    return this.#home;
  }

  /** Whether a change of displays has not settled yet; for tests. */
  get settling() {
    return this.#settleTimer !== null;
  }

  observe(subject, topic) {
    if (topic !== "screen-information-changed") {
      return;
    }
    // A move still waiting to count as the user's came with this change.
    if (this.#stableTimer !== null) {
      this.#moved = true;
    }
    this.window.clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
    if (!sameLayout(this.#layout, currentLayout())) {
      this.#layoutChanged = true;
    }
    this.window.clearTimeout(this.#settleTimer);
    this.#settleTimer = this.window.setTimeout(() => {
      this.#settleTimer = null;
      this.#settle();
    }, SETTLE_MS);
  }

  on_MozUpdateWindowPos() {
    this.#placementChanged();
  }

  on_resize() {
    this.#placementChanged();
  }

  on_sizemodechange() {
    this.#placementChanged();
  }

  #placementChanged() {
    // Moves while the displays change are macOS shuffling windows, not the
    // user placing this one.
    if (this.#settleTimer !== null) {
      this.#moved = true;
      return;
    }
    this.window.clearTimeout(this.#stableTimer);
    this.#stableTimer = this.window.setTimeout(() => {
      this.#stableTimer = null;
      this.#remember();
    }, STABLE_MS);
  }

  #frame() {
    const win = this.window;
    return {
      x: win.screenX,
      y: win.screenY,
      width: win.outerWidth,
      height: win.outerHeight,
    };
  }

  #screenRect(frame) {
    return rectOf(
      lazy.screenManager.screenForRect(
        frame.x,
        frame.y,
        frame.width,
        frame.height
      )
    );
  }

  #remember() {
    const win = this.window;
    if (
      win.closed ||
      win.windowState === win.STATE_MINIMIZED ||
      win.windowState === win.STATE_FULLSCREEN
    ) {
      return;
    }
    const frame = this.#frame();
    this.#home = {
      ...frame,
      screen: this.#screenRect(frame),
      maximized: win.windowState === win.STATE_MAXIMIZED,
    };
    this.#layout = currentLayout();
    this.#layoutChanged = false;
    this.#moved = false;
  }

  async #settle() {
    const home = this.#home;
    const win = this.window;
    if (
      !home ||
      !(this.#layoutChanged || this.#moved) ||
      win.closed ||
      win.windowState === win.STATE_MINIMIZED ||
      win.windowState === win.STATE_FULLSCREEN
    ) {
      this.#remember();
      return;
    }
    const homeScreen = rectOf(
      lazy.screenManager.screenForRect(
        home.screen.left,
        home.screen.top,
        home.screen.width,
        home.screen.height
      )
    );
    if (!sameRect(homeScreen, home.screen)) {
      // Its display is still away: the window stays where macOS put it and
      // goes home once that display is back.
      return;
    }
    if (!sameRect(this.#screenRect(this.#frame()), home.screen)) {
      await this.#moveTo(home);
    }
    this.#remember();
  }

  async #moveTo(home) {
    const win = this.window;
    if (win.windowState === win.STATE_MAXIMIZED) {
      await this.#sizemode(() => win.restore());
    }
    win.moveTo(home.x, home.y);
    if (home.maximized) {
      await this.#sizemode(() => win.maximize());
    } else {
      win.resizeTo(home.width, home.height);
    }
  }

  #sizemode(change) {
    const win = this.window;
    return new Promise(resolve => {
      const timer = win.setTimeout(done, SIZEMODE_WAIT_MS);
      function done() {
        win.clearTimeout(timer);
        win.removeEventListener("sizemodechange", done);
        resolve();
      }
      win.addEventListener("sizemodechange", done);
      change();
    });
  }
}

function currentLayout() {
  return {
    pixels: lazy.screenManager.totalScreenPixels,
    primary: rectOf(lazy.screenManager.primaryScreen),
  };
}

function sameLayout(a, b) {
  return !!a && a.pixels === b.pixels && sameRect(a.primary, b.primary);
}
