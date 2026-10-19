// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  TabStateFlusher:
    "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
});

const PREF_ENABLED = "zen.tab-unloader.enabled";
const PREF_TIMEOUT_MINUTES = "zen.tab-unloader.timeout-minutes";
const PREF_UNLOAD_PINNED = "zen.tab-unloader.unload-pinned";
const DEFAULT_TIMEOUT_MINUTES = 20;
const CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Unloads background tabs that have not been used for
 * `zen.tab-unloader.timeout-minutes` (PRODUCT_DIRECTIONS B4 step 2), in every
 * workspace of this window. Memory-pressure unloading stays with Firefox's
 * TabUnloader (browser.lowMemoryResponseMask).
 *
 * Never unloaded: the selected or otherwise visible tab (split view), tabs
 * playing media or sharing camera/microphone/screen, tabs still loading,
 * tabs with user-entered form data or a beforeunload handler, and pinned or
 * essential tabs unless `zen.tab-unloader.unload-pinned` is set.
 */
class nsZenTabUnloader {
  #interval = null;
  #sweeping = false;

  constructor() {
    Services.prefs.addObserver(PREF_ENABLED, this);
    window.addEventListener("unload", () => this.#uninit(), { once: true });
    this.#updateTimer();
  }

  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  }

  get timeoutMs() {
    const minutes = Services.prefs.getIntPref(
      PREF_TIMEOUT_MINUTES,
      DEFAULT_TIMEOUT_MINUTES
    );
    return Math.max(minutes, 1) * 60 * 1000;
  }

  observe() {
    this.#updateTimer();
  }

  #updateTimer() {
    if (this.enabled && !this.#interval) {
      this.#interval = window.setInterval(
        () => this.sweep(),
        CHECK_INTERVAL_MS
      );
    } else if (!this.enabled && this.#interval) {
      window.clearInterval(this.#interval);
      this.#interval = null;
    }
  }

  #uninit() {
    Services.prefs.removeObserver(PREF_ENABLED, this);
    window.clearInterval(this.#interval);
    this.#interval = null;
  }

  /**
   * @param {MozTabbrowserTab} tab
   * @param {number} [now] Current time in ms since the epoch.
   * @returns {string|null} Why the tab must stay loaded, or null.
   */
  protectionReason(tab, now = Date.now()) {
    if (tab.closing || !tab.linkedPanel || tab.hasAttribute("pending")) {
      return "not-loaded";
    }
    if (tab.hasAttribute("zen-empty-tab")) {
      return "empty-tab";
    }
    if (
      tab.selected ||
      tab.splitview?.hasActiveTab ||
      (tab.group?.hasAttribute("split-view-group") &&
        tab.group.tabs.some(t => t.selected))
    ) {
      return "visible";
    }
    if (
      (tab.pinned || tab.hasAttribute("zen-essential")) &&
      !Services.prefs.getBoolPref(PREF_UNLOAD_PINNED, false)
    ) {
      return "pinned";
    }
    if (
      tab.soundPlaying ||
      tab.hasAttribute("soundplaying") ||
      tab.hasAttribute("pictureinpicture")
    ) {
      return "media";
    }
    if (tab.hasAttribute("sharing")) {
      return "sharing";
    }
    if (tab.hasAttribute("busy")) {
      return "loading";
    }
    if (now - tab.lastAccessed < this.timeoutMs) {
      return "recent";
    }
    return null;
  }

  async #hasFormInput(tab) {
    await lazy.TabStateFlusher.flush(tab.linkedBrowser);
    const state = JSON.parse(lazy.SessionStore.getTabState(tab));
    return !!state.formdata;
  }

  /**
   * Unloads every tab that is not protected.
   *
   * @param {number} [now] Current time in ms since the epoch.
   * @returns {Promise<MozTabbrowserTab[]>} The tabs that were unloaded.
   */
  async sweep(now = Date.now()) {
    if (this.#sweeping || !this.enabled) {
      return [];
    }
    this.#sweeping = true;
    const unloaded = [];
    try {
      const tabs = window.gZenWorkspaces?.allStoredTabs ?? gBrowser.tabs;
      for (const tab of [...tabs]) {
        if (this.protectionReason(tab, now)) {
          continue;
        }
        if (await this.#hasFormInput(tab)) {
          continue;
        }
        // The flush is async; the tab may have been selected or closed since.
        if (this.protectionReason(tab, now)) {
          continue;
        }
        // Without force, discardBrowser() keeps tabs whose beforeunload
        // handler would ask the user to stay.
        if (gBrowser.discardBrowser(tab)) {
          unloaded.push(tab);
        }
      }
    } finally {
      this.#sweeping = false;
    }
    return unloaded;
  }
}

window.gZenTabUnloader = new nsZenTabUnloader();
