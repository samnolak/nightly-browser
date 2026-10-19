// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

const QUEUED_ATTR = "zen-load-queued";
const PREF_ENABLED = "zen.tabs.load-queue.enabled";
const PREF_MAX_CONCURRENT = "zen.tabs.load-queue.max-concurrent";
const DEFAULT_MAX_CONCURRENT = 6;
// Frees a slot even if a load never reports completion (e.g. a hung server).
const LOAD_TIMEOUT_MS = 30000;

/**
 * Bulk-open load queue (PRODUCT_DIRECTIONS B4).
 *
 * When gBrowser.loadTabs() opens more tabs than may load at once, it creates
 * the background tabs lazily (no browser, no content process) and hands them
 * here. The queue binds and restores at most `max-concurrent` of them at a
 * time, one per event-loop task, so opening 120 tabs no longer blocks the UI
 * for seconds while content processes launch. Queued tabs carry the
 * `zen-load-queued` attribute; selecting one loads it immediately (session
 * store restores the selected pending tab).
 */
class nsZenTabLoadQueue {
  #queue = [];
  /** @type {Map<MozTabbrowserTab, number>} loading tab -> timeout id */
  #loading = new Map();
  #pumpScheduled = false;
  #l10n = null;

  constructor() {
    for (const type of ["SSTabRestored", "TabClose", "TabSelect"]) {
      window.addEventListener(type, this);
    }
    window.addEventListener("unload", () => this.#clear(), { once: true });
  }

  get maxConcurrent() {
    const value = Services.prefs.getIntPref(
      PREF_MAX_CONCURRENT,
      DEFAULT_MAX_CONCURRENT
    );
    return Math.min(Math.max(value, 1), 32);
  }

  get queuedTabs() {
    return [...this.#queue];
  }

  get loadingCount() {
    return this.#loading.size;
  }

  /**
   * @param {number} count Number of tabs being opened at once.
   * @returns {boolean} Whether background tabs should be queued.
   */
  shouldQueue(count) {
    return (
      Services.prefs.getBoolPref(PREF_ENABLED, true) &&
      count > this.maxConcurrent
    );
  }

  /**
   * Lazy tabs are restored from a session history entry, which needs a
   * parseable URL and cannot carry POST data.
   *
   * @param {string} uri
   * @param {nsIInputStream} [postData]
   * @returns {boolean}
   */
  canQueue(uri, postData) {
    if (postData || !uri || uri == "about:blank") {
      return false;
    }
    try {
      Services.io.newURI(uri);
      return true;
    } catch {
      return false;
    }
  }

  /** @param {MozTabbrowserTab[]} tabs Lazily created tabs, in load order. */
  enqueue(tabs) {
    for (const tab of tabs) {
      if (tab.closing || !tab.hasAttribute("pending")) {
        continue;
      }
      tab.setAttribute(QUEUED_ATTR, "true");
      // Show where the tab will go instead of "New Tab" while it waits. Zen
      // only relabels tabs whose contents were never shown when asked to.
      const spec = tab.linkedBrowser?.currentURI?.spec;
      if (spec && spec != "about:blank") {
        gBrowser._setTabLabel(tab, spec, {
          isURL: true,
          _zenChangeLabelFlag: true,
        });
      }
      this.#queue.push(tab);
    }
    this.#schedulePump();
  }

  handleEvent(event) {
    const tab = event.target;
    switch (event.type) {
      case "SSTabRestored":
        this.#finish(tab);
        break;
      case "TabClose":
        this.#remove(tab);
        this.#finish(tab);
        break;
      case "TabSelect":
        // Session store restores a selected pending tab right away.
        this.#remove(tab);
        break;
    }
  }

  /**
   * @param {MozTabbrowserTab} tab
   * @returns {string|null} Tooltip line explaining why `tab` is not loaded.
   */
  getLoadStateTooltip(tab) {
    const index = this.#queue.indexOf(tab);
    if (index != -1) {
      return this.#format("zen-tab-load-queued-tooltip", {
        position: index + 1,
        count: this.#queue.length,
      });
    }
    if (tab.hasAttribute("pending") && !tab.selected) {
      return this.#format("zen-tab-unloaded-tooltip");
    }
    return null;
  }

  #format(id, args) {
    this.#l10n ??= new Localization(["browser/zen-general.ftl"], true);
    return this.#l10n.formatValueSync(id, args);
  }

  #remove(tab) {
    const index = this.#queue.indexOf(tab);
    if (index != -1) {
      this.#queue.splice(index, 1);
      tab.removeAttribute(QUEUED_ATTR);
    }
  }

  #finish(tab) {
    if (!this.#loading.has(tab)) {
      return;
    }
    window.clearTimeout(this.#loading.get(tab));
    this.#loading.delete(tab);
    this.#schedulePump();
  }

  #schedulePump() {
    if (this.#pumpScheduled || !this.#queue.length) {
      return;
    }
    this.#pumpScheduled = true;
    window.setTimeout(() => {
      this.#pumpScheduled = false;
      this.#startNext();
    }, 0);
  }

  // Starts at most one load per task: binding a lazy browser can wait for a
  // content process to launch, which is the cost this queue spreads out.
  #startNext() {
    while (this.#loading.size < this.maxConcurrent && this.#queue.length) {
      const tab = this.#queue.shift();
      tab.removeAttribute(QUEUED_ATTR);
      if (tab.closing || !tab.isConnected) {
        continue;
      }
      // Reading some properties of a lazy browser (e.g. webProgress) inserts
      // it early; such a tab is still pending and must be restored here.
      if (!tab.linkedPanel) {
        gBrowser.insertBrowser(tab);
      }
      if (lazy.SessionStore.restoreTabContentInBackground(tab)) {
        this.#loading.set(
          tab,
          window.setTimeout(() => this.#finish(tab), LOAD_TIMEOUT_MS)
        );
      }
      break;
    }
    if (this.#loading.size < this.maxConcurrent) {
      this.#schedulePump();
    }
  }

  #clear() {
    for (const timeout of this.#loading.values()) {
      window.clearTimeout(timeout);
    }
    this.#loading.clear();
    this.#queue = [];
  }
}

window.gZenTabLoadQueue = new nsZenTabLoadQueue();
