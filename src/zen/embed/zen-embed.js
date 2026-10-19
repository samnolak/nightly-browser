/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The chrome of one embedder pane (ZenEmbedHost): ?pane=<token> names the
// pane, ?url= an optional first page. The embedder drives the browser through
// zen-embed-command ("op\ntext") and hears where it is through
// zen-embed-location ("flags\nurl\ntitle"). Its agent tools run scripts in the
// page through zen-embed-script ("requestId\nkind\nargsLength\n" + args +
// source), answered with zen-embed-script-result ("requestId\nstatus\ntext"),
// by the ZenEmbedAgent actor in the page's process.
//
// A window a page opens (window.open, target=_blank) is this document too
// (AppWindow::CreateNewContentWindow): its browser is made from the window's
// initialOpenWindowInfo, and zen-embed-ready names the window of the opener
// ("pane\nopenerOuterWindowId"), so the embedder shows it as a tab of its own.
// So is a link the context menu opens in a new tab (window.arguments[0]: a
// property bag with the url, the page's principal and the opener).
//
// Popups are the embedder's to draw: the <select> dropdown (SelectParent's
// #ContentSelectDropdown), form autocomplete (AutoCompleteParent's
// browser.autoCompletePopup) and the page's context menu (ContextMenuParent's
// #contentAreaContextMenu) are stand-ins here that never open. They send
// zen-embed-popup ("popupId\n" + JSON, see ZenEmbedPopups) and
// zen-embed-popup-closed ("popupId") when the page closes one; the embedder
// answers zen-embed-popup-choice ("popupId\nindex", -1 for dismissed). The
// keyboard stays with the page meanwhile, as it does in a native dropdown.
//
// The embedder's device mode (command 7, ZenEmbedDevice) emulates a device in
// the page: devicePixelRatio, user agent, a phone's viewport rules and
// orientation (responsive design mode), touch (pointer:coarse, TouchEvent,
// the mouse acting as a finger: ZenEmbedAgentChild). The embedder sizes the
// window to the device's viewport itself.
//
// The page's questions (alert/confirm/prompt, sign-in, permissions, file
// pickers, downloads) are the embedder's to answer: ZenEmbedDialogs, through
// this window's gBrowser (tab-modal prompts) and PopupNotifications.

const { ZenEmbedDialogs } = ChromeUtils.importESModule("resource:///actors/ZenEmbedDialogs.sys.mjs");

const EMBED_DOCUMENT = "chrome://browser/content/zen-embed.xhtml";

const COMMAND_NAVIGATE = 1;
const COMMAND_RELOAD = 2;
const COMMAND_BACK = 3;
const COMMAND_FORWARD = 4;
const COMMAND_STOP = 5;
const COMMAND_CLOSE = 6;
const COMMAND_DEVICE = 7;

const LOCATION_LOADING = 1;
const LOCATION_CAN_GO_BACK = 2;
const LOCATION_CAN_GO_FORWARD = 4;

// ZenEmbedHost.mm's kScript* values.
const SCRIPT_UNDEFINED = 1;
const SCRIPT_ERROR = 2;
const SCRIPT_NO_PAGE = 3;

// Only the embed windows' browsers (messagemanagergroup="zen-embed") get the
// actor; registered once per process, by the first embed window. It lives in
// web content processes, which is safe: the child only answers its parent's
// queries and takes nothing from the page.
function registerAgentActor() {
  try {
    ChromeUtils.registerWindowActor("ZenEmbedAgent", {
      child: { esModuleURI: "resource:///actors/ZenEmbedAgentChild.sys.mjs" },
      messageManagerGroups: ["zen-embed"],
      safeForUntrustedWebProcess: true,
      allFrames: false,
    });
  } catch (e) {
    if (e.name != "NotSupportedError") {
      throw e;
    }
  }
}

// The documents whose actor answered once. Gecko drops a query to a child
// actor that fails to load (JSActorManager::ReceiveRawMessage), so a script
// would never be answered: a document's first script waits for ZenEmbed:Ready
// at most AGENT_START_MS and fails with an error the embedder sees instead.
const startedAgents = new WeakSet();
const AGENT_START_MS = 10000;

async function startedAgent(windowGlobal) {
  const actor = windowGlobal.getActor("ZenEmbedAgent");
  if (startedAgents.has(windowGlobal)) {
    return actor;
  }
  let timer;
  const started = await Promise.race([
    actor.sendQuery("ZenEmbed:Ready").then(() => true),
    new Promise(resolve => (timer = setTimeout(() => resolve(false), AGENT_START_MS))),
  ]).finally(() => clearTimeout(timer));
  if (!started) {
    throw new Error("The page's script agent did not start (ZenEmbedAgentChild could not load).");
  }
  startedAgents.add(windowGlobal);
  return actor;
}

// A rectangle in screen CSS pixels (where Gecko places popups) in this
// window's content, top-left origin: points, as the embedder lays it out.
function windowRect(x, y, width = 0, height = 0) {
  return {
    x: x - window.mozInnerScreenX,
    y: y - window.mozInnerScreenY,
    width,
    height,
  };
}

function copyString(text) {
  Cc["@mozilla.org/widget/clipboardhelper;1"]
    .getService(Ci.nsIClipboardHelper)
    .copyString(text);
}

// The one popup the embedder shows for this window. Its JSON:
//   { kind: "select" | "autocomplete" | "menu",
//     rect: { x, y, width, height },   // the anchor, window points
//     items: [{ kind: "item" | "header" | "separator", label, detail,
//               command, disabled, indent }],
//     selected: index or -1 }
// A menu's items name a command (the embedder labels them); the others carry
// the page's text. The embedder answers with an index into items.
const ZenEmbedPopups = {
  nextId: 1,
  current: null, // { id, choose(index), dismiss() }

  open(kind, rect, items, selected, handlers) {
    this.dismissCurrent();
    const id = this.nextId++;
    this.current = { id, ...handlers };
    this.send(id, kind, rect, items, selected);
    return id;
  },

  // New items or selection of the popup that is still shown.
  update(id, kind, rect, items, selected) {
    if (this.current?.id == id) {
      this.send(id, kind, rect, items, selected);
    }
  },

  send(id, kind, rect, items, selected) {
    const json = JSON.stringify({ kind, rect, items, selected });
    Services.obs.notifyObservers(window, "zen-embed-popup", `${id}\n${json}`);
  },

  // The page closed it.
  closed(id) {
    if (this.current?.id != id) {
      return;
    }
    this.current = null;
    Services.obs.notifyObservers(window, "zen-embed-popup-closed", String(id));
  },

  // The embedder's answer.
  choose(id, index) {
    const popup = this.current;
    if (popup?.id != id) {
      return;
    }
    this.current = null;
    if (index < 0) {
      popup.dismiss();
    } else {
      popup.choose(index);
    }
  },

  dismissCurrent() {
    const popup = this.current;
    if (popup) {
      this.closed(popup.id);
      popup.dismiss();
    }
  },
};

// SelectParent fills and opens #ContentSelectDropdown (it creates it only when
// the document has none): its items go to the embedder, the chosen one is
// "commanded" as a click on it would, and the popup "hides" as it would.
const ZenEmbedSelect = {
  menulist: null,
  popup: null,
  id: 0,
  rect: null,
  elements: [],
  observer: null,

  init(container) {
    const menulist = document.createXULElement("menulist");
    menulist.id = "ContentSelectDropdown";
    menulist.setAttribute("popuponly", "true");
    menulist.setAttribute("hidden", "true");
    const popup = menulist.appendChild(document.createXULElement("menupopup"));
    popup.id = "ContentSelectDropdownPopup";
    popup.setAttribute("activateontab", "true");
    popup.setAttribute("position", "after_start");
    popup.setAttribute("tabspecific", "true");
    popup.setAttribute("level", "parent");
    container.appendChild(menulist);
    this.menulist = menulist;
    this.popup = popup;
    popup.openPopupAtScreenRect = (position, x, y, width, height) =>
      this.open(windowRect(x, y, width, height));
    popup.hidePopup = () => this.hide();
    popup.getOuterScreenRect = () => new DOMRect(0, 0, 0, 0);
    Object.defineProperty(popup, "state", {
      configurable: true,
      get: () => (this.id ? "open" : "closed"),
    });
    // Forms:UpdateDropDown keeps the scroll position of the real popup.
    Object.defineProperty(popup, "scrollBox", {
      configurable: true,
      value: { scrollbox: { scrollTop: 0 } },
    });
    // The page changed the <select> while it is open: SelectParent refills it.
    this.observer = new MutationObserver(() => this.update());
  },

  open(rect) {
    this.rect = rect;
    if (this.id) {
      this.update();
      return;
    }
    const { items, selected } = this.read();
    this.id = ZenEmbedPopups.open("select", rect, items, selected, {
      choose: index => this.choose(index),
      dismiss: () => this.hide(),
    });
    this.observer.observe(this.popup, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["label", "disabled", "hidden"],
    });
  },

  update() {
    if (this.id) {
      const { items, selected } = this.read();
      ZenEmbedPopups.update(this.id, "select", this.rect, items, selected);
    }
  },

  read() {
    const items = [];
    this.elements = [];
    let selected = -1;
    for (const element of this.popup.children) {
      const kind = {
        menuitem: "item",
        menucaption: "header",
        menuseparator: "separator",
      }[element.localName];
      if (!kind || element.hidden) {
        continue;
      }
      if (element == this.menulist.selectedItem) {
        selected = items.length;
      }
      this.elements.push(element);
      items.push({
        kind,
        label: element.getAttribute("label") ?? "",
        disabled: element.hasAttribute("disabled"),
        indent: element.hasAttribute("indented"),
      });
    }
    return { items, selected };
  },

  choose(index) {
    const element = this.elements[index];
    if (element?.localName == "menuitem" && !element.hasAttribute("disabled")) {
      // SelectParentHelper's "command" listener on the popup.
      element.dispatchEvent(new Event("command", { bubbles: true }));
    }
    this.hide();
  },

  hide() {
    if (!this.id) {
      return;
    }
    const id = this.id;
    this.id = 0;
    this.elements = [];
    this.observer.disconnect();
    ZenEmbedPopups.closed(id);
    // SelectParentHelper's "popuphidden" listener: the page hears the
    // dropdown closed (change/input events after a choice).
    this.popup.dispatchEvent(new Event("popuphidden", { bubbles: true }));
  },
};

// AutoCompleteParent's browser.autoCompletePopup: what it sets and calls on a
// richlistbox popup. The keyboard stays in the page's field, whose controller
// moves the selection here (selectBy) and picks it (Enter).
const ZenEmbedAutoComplete = {
  element: null,
  id: 0,
  rect: null,
  index: -1,

  init(container) {
    const element = document.createXULElement("box");
    element.id = "zen-embed-autocomplete";
    element.hidden = true;
    container.appendChild(element);
    this.element = element;
    Object.defineProperties(element, {
      selectedIndex: {
        configurable: true,
        get: () => this.index,
        set: index => {
          this.index = index;
          this.update();
        },
      },
      popupOpen: { configurable: true, get: () => !!this.id },
      state: { configurable: true, get: () => (this.id ? "open" : "closed") },
    });
    Object.assign(element, {
      view: null,
      mInput: null,
      maxRows: 6,
      openPopupAtScreenRect: (position, x, y, width, height) =>
        this.open(windowRect(x, y, width, height)),
      invalidate: () => this.update(),
      adjustHeight() {},
      // browser.constrainPopup: nothing of the popup is on Nightly's screen.
      setConstraintRect() {},
      closePopup: () => this.hide(),
      hidePopup: () => this.hide(),
      selectBy: (reverse, page) => this.selectBy(reverse, page),
      navigateSecondaryAction: () => false,
      maybeActivateSecondaryAction: () => false,
      maybeLeaveSecondaryAction: () => false,
    });
  },

  open(rect) {
    this.rect = rect;
    if (this.id) {
      this.update();
      return;
    }
    // AutoCompleteParent tells the page the popup is open (its field then
    // sends the arrow keys here).
    this.element.dispatchEvent(new Event("popupshowing"));
    this.id = ZenEmbedPopups.open(
      "autocomplete",
      rect,
      this.read(),
      this.index,
      {
        choose: index => {
          this.index = index;
          // The page's field fills the entry and closes the popup.
          this.element.view?.handleEnter(true);
        },
        dismiss: () => this.hide(),
      }
    );
  },

  update() {
    if (this.id) {
      ZenEmbedPopups.update(this.id, "autocomplete", this.rect, this.read(), this.index);
    }
  },

  read() {
    const view = this.element.view;
    const items = [];
    for (let i = 0; i < (view?.matchCount ?? 0); i++) {
      const comment = view.getCommentAt(i) ?? "";
      items.push({
        kind: "item",
        label: view.getLabelAt(i) || view.getValueAt(i) || "",
        // Logins and addresses keep JSON in their comments.
        detail: comment.startsWith("{") ? "" : comment,
        disabled: false,
      });
    }
    return items;
  },

  selectBy(reverse, page) {
    const count = this.element.view?.matchCount ?? 0;
    if (!count) {
      return;
    }
    const step = page ? this.element.maxRows : 1;
    let index = this.index;
    if (index < 0) {
      index = reverse ? count - 1 : 0;
    } else {
      index += reverse ? -step : step;
      // Past either end the field's own text is selected again.
      if (index < 0 || index >= count) {
        index = page ? Math.min(Math.max(index, 0), count - 1) : -1;
      }
    }
    this.element.selectedIndex = index;
  },

  hide() {
    if (!this.id) {
      return;
    }
    const id = this.id;
    this.id = 0;
    ZenEmbedPopups.closed(id);
    // AutoCompleteParent reads the selection, then clears its state.
    this.element.dispatchEvent(new Event("popuphidden"));
    this.index = -1;
  },
};

// ContextMenuParent fills nsContextMenu.contentData and opens
// #contentAreaContextMenu at the pointer: the embedder shows the commands
// that apply to what was clicked, and they run here.
const ZenEmbedContextMenu = {
  init(container) {
    window.nsContextMenu = { contentData: null };
    const element = document.createXULElement("box");
    element.id = "contentAreaContextMenu";
    element.hidden = true;
    container.appendChild(element);
    element.openPopupAtScreen = (x, y) => this.open(windowRect(x, y));
  },

  open(rect) {
    const data = window.nsContextMenu.contentData;
    if (!data) {
      return;
    }
    const commands = this.commands(data);
    if (!commands.length) {
      data.actor.hiding();
      return;
    }
    ZenEmbedPopups.open(
      "menu",
      rect,
      commands.map(c =>
        c
          ? { kind: "item", command: c.id, label: "", disabled: !c.enabled }
          : { kind: "separator", label: "" }
      ),
      -1,
      {
        choose: index => {
          commands[index]?.run();
          data.actor.hiding();
        },
        dismiss: () => data.actor.hiding(),
      }
    );
  },

  // What applies to the clicked node; null between groups.
  commands({ context, browser, selectionInfo, principal, referrerInfo, linkReferrerInfo, userContextId }) {
    const list = [];
    const add = (id, run, enabled = true) => list.push({ id, run, enabled });
    const separate = () => {
      if (list.length && list.at(-1)) {
        list.push(null);
      }
    };
    const edit = (id, command, enabled = true) =>
      add(id, () => ZenEmbed.doCommand(command), enabled && ZenEmbed.canDoCommand(command));
    const selected = !!selectionInfo?.text;
    if (context.onLink && context.linkURL) {
      add("open-link", () =>
        ZenEmbed.openTab(context.linkURL, principal, linkReferrerInfo, userContextId)
      );
      add("copy-link", () => copyString(context.linkURL));
      separate();
    }
    if ((context.onImage || context.onCanvas) && context.mediaURL) {
      add("open-image", () =>
        ZenEmbed.openTab(context.mediaURL, principal, referrerInfo, userContextId)
      );
      add("copy-image", () => ZenEmbed.doCommand("cmd_copyImage"));
      add("copy-image-link", () => copyString(context.mediaURL));
      separate();
    }
    if (context.onEditable) {
      edit("undo", "cmd_undo");
      separate();
      edit("cut", "cmd_cut", selected);
      edit("copy", "cmd_copy", selected);
      edit("paste", "cmd_paste");
      edit("delete", "cmd_delete", selected);
      separate();
      edit("select-all", "cmd_selectAll");
    } else if (selected) {
      edit("copy", "cmd_copy");
      edit("select-all", "cmd_selectAll");
    } else if (!context.onLink && !context.onImage && !context.onCanvas) {
      add("back", () => browser.goBack(), browser.canGoBack);
      add("forward", () => browser.goForward(), browser.canGoForward);
      add("reload", () => browser.reload());
      separate();
      edit("select-all", "cmd_selectAll");
    }
    if (!list.at(-1)) {
      list.pop();
    }
    return list;
  },
};

// The emulated device of this window's page: null, or
//   { mobile, dpr, userAgent, touch, landscape }
// mobile: a phone or tablet (the page's meta viewport applies, screen is the
// viewport, maxTouchPoints and orientation are emulated); dpr: 0 for the
// display's own; userAgent: "" for Nightly's own. The settings live on the
// top browsing context, which a process switch replaces (only the user agent
// carries over), so they are set again on every new one.
const ZenEmbedDevice = {
  device: null,

  init() {
    Services.obs.addObserver(this, "browsing-context-attached");
  },

  uninit() {
    Services.obs.removeObserver(this, "browsing-context-attached");
  },

  // The embedder's JSON; "" ends the device mode. Reloads a loaded page when
  // what it reads only at load (user agent, viewport rules, touch API) changed.
  set(text) {
    let device = null;
    if (text) {
      try {
        const value = JSON.parse(text);
        device = {
          mobile: !!value.mobile,
          dpr: Number(value.dpr) > 0 ? Number(value.dpr) : 0,
          userAgent: typeof value.userAgent == "string" ? value.userAgent : "",
          touch: !!value.touch,
          landscape: !!value.landscape,
        };
      } catch (e) {
        console.error("zen-embed: bad device", e);
        return;
      }
    }
    const before = this.device;
    this.device = device;
    const bc = ZenEmbed.browser.browsingContext;
    if (bc) {
      this.apply(bc);
    }
    this.touchDocument();
    const atLoad = d => `${d?.mobile ?? false}\n${d?.touch ?? false}\n${d?.userAgent ?? ""}`;
    const spec = ZenEmbed.browser.currentURI?.spec ?? "about:blank";
    if (atLoad(before) != atLoad(device) && spec != "about:blank") {
      ZenEmbed.browser.reload();
    }
  },

  apply(bc) {
    const device = this.device;
    const mobile = !!device?.mobile;
    // As the browser's enterResponsiveMode, on this context (at attach time
    // the browser still names the one it replaces); the embed never zooms.
    if (bc.inRDMPane != mobile) {
      bc.inRDMPane = mobile;
    }
    const dpr = device?.dpr ?? 0;
    if (bc.overrideDPPX != dpr) {
      bc.overrideDPPX = dpr;
    }
    const userAgent = device?.userAgent ?? "";
    if (bc.customUserAgent != userAgent) {
      bc.customUserAgent = userAgent;
    }
    const touch = device?.touch ? "enabled" : "none";
    if (bc.touchEventsOverride != touch) {
      bc.touchEventsOverride = touch;
    }
    if (mobile) {
      bc.setRDMPaneMaxTouchPoints(device.touch ? 5 : 0);
      if (device.landscape) {
        bc.setOrientationOverride("landscape-primary", 90);
      } else {
        bc.setOrientationOverride("portrait-primary", 0);
      }
    } else {
      bc.resetOrientationOverride();
    }
  },

  // While the device touches, the page's document turns the mouse into a
  // finger (ZenEmbedAgentChild); called for each new document.
  touchDocument() {
    const spec = ZenEmbed.browser.currentURI?.spec ?? "about:blank";
    if (!this.device?.touch || spec == "about:blank") {
      return;
    }
    try {
      ZenEmbed.browser.browsingContext?.currentWindowGlobal
        ?.getActor("ZenEmbedAgent")
        .sendAsyncMessage("ZenEmbed:Touch");
    } catch (e) {
      // The document went away meanwhile: the next one is told.
    }
  },

  // A new top browsing context of this window's browser (a process switch,
  // a page from the back-forward cache): before any of its scripts run.
  observe(subject, topic) {
    if (
      topic == "browsing-context-attached" &&
      this.device &&
      !subject.parent &&
      subject.browserId == ZenEmbed.browser?.browserId
    ) {
      this.apply(subject);
    }
  },

  QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
};

const ZenEmbed = {
  browser: null,
  loading: false,
  opener: 0,
  // A link this window was opened for (the context menu's "open in new tab").
  firstLoad: null,

  // The window's <browser>, before the document finishes loading: a page's
  // new window waits for it (AppWindow::CreateNewContentWindow) and takes over
  // the browsing context the opener made (initialOpenWindowInfo).
  createBrowser() {
    const openWindowInfo = window.docShell.treeOwner
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIAppWindow).initialOpenWindowInfo;
    const args = window.arguments?.[0];
    const opened = args instanceof Ci.nsIPropertyBag2 ? args : null;
    const browser = document.createXULElement("browser");
    browser.id = "zen-embed-browser";
    const attributes = {
      messagemanagergroup: "zen-embed",
      type: "content",
      primary: "true",
      remote: "true",
      maychangeremoteness: "true",
      flex: "1",
      autocompletepopup: "zen-embed-autocomplete",
    };
    for (const [name, value] of Object.entries(attributes)) {
      browser.setAttribute(name, value);
    }
    let userContextId = 0;
    if (openWindowInfo) {
      userContextId = openWindowInfo.originAttributes.userContextId;
      if (openWindowInfo.isRemote) {
        browser.setAttribute(
          "remoteType",
          ChromeUtils.predictRemoteTypeForURI(null, { window, userContextId })
        );
      }
      browser.openWindowInfo = openWindowInfo;
      const opener = openWindowInfo.parent?.top?.embedderElement?.documentGlobal;
      this.opener = opener?.docShell?.outerWindowID ?? 0;
    } else if (opened) {
      userContextId = opened.getPropertyAsUint32("userContextId");
      this.opener = opened.getPropertyAsUint64("opener");
      this.firstLoad = {
        url: opened.getPropertyAsAString("url"),
        triggeringPrincipal: opened.getPropertyAsInterface("triggeringPrincipal", Ci.nsIPrincipal),
        referrerInfo: opened.hasKey("referrerInfo")
          ? opened.getPropertyAsInterface("referrerInfo", Ci.nsIReferrerInfo)
          : null,
      };
    }
    if (userContextId) {
      browser.setAttribute("usercontextid", userContextId);
    }
    document.documentElement.appendChild(browser);
    this.browser = browser;
  },

  init() {
    const params = new URLSearchParams(location.search);
    const popups = document.getElementById("zen-embed-popups");
    ZenEmbedSelect.init(popups);
    ZenEmbedAutoComplete.init(popups);
    ZenEmbedContextMenu.init(popups);
    this.browser.addProgressListener(
      this,
      Ci.nsIWebProgress.NOTIFY_LOCATION | Ci.nsIWebProgress.NOTIFY_STATE_WINDOW
    );
    this.browser.addEventListener("pagetitlechanged", () => this.report());
    // window.close() in a page some script opened (BrowserElementParent): the
    // window goes, and the embedder closes its tab.
    this.browser.addEventListener("DOMWindowClose", () => window.close());
    for (const key of document.querySelectorAll("#zen-embed-keys > key")) {
      key.addEventListener("command", () => this.doCommand(key.dataset.command));
    }
    Services.obs.addObserver(this, "zen-embed-command");
    Services.obs.addObserver(this, "zen-embed-script");
    Services.obs.addObserver(this, "zen-embed-popup-choice");
    ZenEmbedDevice.init();
    ZenEmbedDialogs.start();
    window.gBrowser = ZenEmbedDialogs.tabDialogBox(window, this.browser);
    window.PopupNotifications = ZenEmbedDialogs.popupNotifications(window);
    window.addEventListener("unload", () => this.uninit(), { once: true });
    // Keys go to the page whenever the embedder focuses the pane.
    window.addEventListener("activate", () => this.browser.focus());
    const pane = params.get("pane") || "0";
    Services.obs.notifyObservers(
      window,
      "zen-embed-ready",
      this.opener ? `${pane}\n${this.opener}` : pane
    );
    if (this.firstLoad) {
      const { url, triggeringPrincipal, referrerInfo } = this.firstLoad;
      this.firstLoad = null;
      try {
        this.browser.loadURI(Services.io.newURI(url), { triggeringPrincipal, referrerInfo });
      } catch (e) {
        console.error(e);
      }
    } else if (params.get("url")) {
      this.navigate(params.get("url"));
    }
  },

  uninit() {
    ZenEmbedPopups.dismissCurrent();
    ZenEmbedDialogs.windowClosed(window);
    Services.obs.removeObserver(this, "zen-embed-command");
    Services.obs.removeObserver(this, "zen-embed-script");
    Services.obs.removeObserver(this, "zen-embed-popup-choice");
    ZenEmbedDevice.uninit();
    this.browser.removeProgressListener(this);
  },

  navigate(url) {
    this.browser.fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  },

  // A page's link in a window of its own, which the embedder shows as a tab:
  // loaded as the page itself would (its principal and referrer).
  openTab(url, triggeringPrincipal, referrerInfo, userContextId) {
    const args = Cc["@mozilla.org/hash-property-bag;1"].createInstance(
      Ci.nsIWritablePropertyBag2
    );
    args.setPropertyAsAString("url", url);
    args.setPropertyAsInterface("triggeringPrincipal", triggeringPrincipal);
    if (referrerInfo) {
      args.setPropertyAsInterface("referrerInfo", referrerInfo);
    }
    args.setPropertyAsUint64("opener", window.docShell.outerWindowID);
    args.setPropertyAsUint32("userContextId", userContextId ?? 0);
    Services.ww.openWindow(window, EMBED_DOCUMENT, "_blank", "chrome,dialog=no,all", args);
  },

  observe(subject, topic, data) {
    if (subject != window) {
      return;
    }
    if (topic == "zen-embed-script") {
      this.runScript(data);
      return;
    }
    if (topic == "zen-embed-popup-choice") {
      const [id, index] = data.split("\n").map(Number);
      ZenEmbedPopups.choose(id, index);
      return;
    }
    if (topic != "zen-embed-command") {
      return;
    }
    const newline = data.indexOf("\n");
    const op = Number(data.slice(0, newline));
    const text = data.slice(newline + 1);
    switch (op) {
      case COMMAND_NAVIGATE:
        this.navigate(text);
        break;
      case COMMAND_RELOAD:
        this.browser.reload();
        break;
      case COMMAND_BACK:
        if (this.browser.canGoBack) {
          this.browser.goBack();
        }
        break;
      case COMMAND_FORWARD:
        if (this.browser.canGoForward) {
          this.browser.goForward();
        }
        break;
      case COMMAND_STOP:
        this.browser.stop();
        break;
      case COMMAND_CLOSE:
        window.close();
        break;
      case COMMAND_DEVICE:
        ZenEmbedDevice.set(text);
        break;
    }
  },

  canDoCommand(command) {
    const controller = document.commandDispatcher.getControllerForCommand(command);
    return !!controller?.isCommandEnabled(command);
  },

  doCommand(command) {
    const controller = document.commandDispatcher.getControllerForCommand(command);
    if (controller?.isCommandEnabled(command)) {
      controller.doCommand(command);
    }
  },

  // A script of the embedder's agent tools, in the top-level document.
  async runScript(data) {
    const fields = data.split("\n", 3);
    const id = fields[0];
    const kind = Number(fields[1]);
    const argsLength = Number(fields[2]);
    const rest = data.slice(fields.join("\n").length + 1);
    const args = rest.slice(0, argsLength);
    const source = rest.slice(argsLength);
    let result;
    try {
      const windowGlobal = this.browser.browsingContext?.currentWindowGlobal;
      result = windowGlobal
        ? await (await startedAgent(windowGlobal)).sendQuery("ZenEmbed:Script", { kind, source, args })
        : { status: SCRIPT_NO_PAGE, text: "No page is loaded." };
    } catch (e) {
      // The document went away meanwhile (a navigation), or the actor failed.
      result = { status: SCRIPT_ERROR, text: String(e?.message ?? e) };
    }
    const status = result?.status ?? SCRIPT_UNDEFINED;
    Services.obs.notifyObservers(
      window,
      "zen-embed-script-result",
      `${id}\n${status}\n${result?.text ?? ""}`
    );
  },

  report() {
    let flags = 0;
    if (this.loading) {
      flags |= LOCATION_LOADING;
    }
    if (this.browser.canGoBack) {
      flags |= LOCATION_CAN_GO_BACK;
    }
    if (this.browser.canGoForward) {
      flags |= LOCATION_CAN_GO_FORWARD;
    }
    const url = this.browser.currentURI?.spec ?? "";
    const title = this.browser.contentTitle ?? "";
    Services.obs.notifyObservers(window, "zen-embed-location", `${flags}\n${url}\n${title}`);
  },

  // nsIWebProgressListener, top-level document only.
  onLocationChange(webProgress) {
    if (webProgress.isTopLevel) {
      this.report();
      ZenEmbedDevice.touchDocument();
    }
  },

  onStateChange(webProgress, request, stateFlags) {
    if (!webProgress.isTopLevel || !(stateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) {
      return;
    }
    if (stateFlags & Ci.nsIWebProgressListener.STATE_START) {
      this.loading = true;
      this.report();
    } else if (stateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
      this.loading = false;
      this.report();
    }
  },

  QueryInterface: ChromeUtils.generateQI([
    "nsIObserver",
    "nsIWebProgressListener",
    "nsISupportsWeakReference",
  ]),
};

// The browser exists before the document has loaded (see createBrowser).
window.addEventListener("DOMContentLoaded", () => ZenEmbed.createBrowser(), { once: true });
window.addEventListener(
  "load",
  () => {
    registerAgentActor();
    ZenEmbed.init();
  },
  { once: true }
);
