/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The questions a page of an embedder pane asks (ZenEmbedHost), answered by
// the embedder instead of Nightly's own windows and doorhangers:
//  - alert, confirm, prompt, beforeunload and HTTP/proxy sign-in: PromptParent
//    opens them through the window's gBrowser.getTabDialogBox (tabDialogBox
//    below; zen-embed.js installs it);
//  - site permissions (location, notifications, camera and microphone,
//    storage access, ...): PermissionUI and WebRTCParent show them through
//    the window's PopupNotifications (popupNotifications below);
//  - <input type=file> and "save as" pickers: @mozilla.org/filepicker;1;
//  - downloads: @mozilla.org/helperapplauncherdialog;1 asks where to save
//    (the embedder answers with a path, or none), and the download list
//    reports their progress until they end.
// Each question goes to the embedder as zen-embed-dialog ("id\n" + JSON) on
// its pane's window; the answer comes back as zen-embed-dialog-reply
// ("id\n" + JSON). A question Nightly withdraws (the page navigated, closed,
// or the tab's process crashed) is zen-embed-dialog-closed ("id"). Downloads
// report zen-embed-download ("id\n" + JSON, id the question that chose their
// path); zen-embed-download-cancel ("id") stops one.
// Pages of a browser window the embedder shows whole (the Browser page,
// browserWindow below) keep Nightly's own prompts, doorhangers and download
// flow, as in Nightly, except what Nightly would put on screen outside that
// window: the system's open and save panels (a sheet on a window that is
// never on screen) are the embedder's, a sheet on its own window ("panel"
// below), and its panels (doorhangers, menus, the downloads and site panels)
// draw their own background, as no NSPopover hosts them. Any other window
// (an ordinary Nightly window) keeps the system file picker.
//
// Questions (JSON): { kind, origin, ... }
//   alert | confirm | prompt | beforeunload: { message, default (prompt) }
//   auth: { host, port, realm, proxy, user, failed }
//   permission: { permission: "geolocation" | "notifications" | "camera" |
//                 "microphone" | "camera-microphone" | "storage-access" |
//                 "other", message }
//   file: { multiple, directory, accept: [".png", "image/*", ...] }
//   download: { name, size (-1 unknown), url }
//   panel: { mode: "open" | "multiple" | "folder" | "save", title, name,
//            extension, directory, okLabel, filterIndex,
//            filters: [{ title, patterns: ["*.html", "*"] }] }
//   print: { printInfo: base64 secure NSPrintInfo archive, pageSetup, windowId }
//          (nsPrintDialogX asks from its parent; routed through the chrome window).
// Answers (JSON):
//   alert: {}; confirm, beforeunload: { ok }; prompt: { ok, value };
//   auth: { ok, user, password }; permission: { answer: "deny" | "once" |
//   "always" }; file: { paths: [...] | null }; download: { path | null };
//   panel: { paths: [...] | null, filterIndex }.
//   print: { printInfo: updated secure archive } or {} on cancellation.
// Download states (JSON): { state: "saving" | "finished" | "failed" |
//   "canceled", received, total, path, error }.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  nsUnknownContentTypeDialog: "resource://gre/modules/HelperAppDlg.sys.mjs",
});

const FILE_PICKER_CONTRACT = "@mozilla.org/filepicker;1";
const HELPER_APP_DIALOG_CONTRACT = "@mozilla.org/helperapplauncherdialog;1";
const FILE_PICKER_CID = Components.ID("{4c7a5f5e-5d2f-4b3e-9a62-1f0b7f9c2e11}");
const HELPER_APP_DIALOG_CID = Components.ID("{a3e2b0d4-8c51-4f7a-b6c9-2d4e7f1a9b03}");
// The system file picker these replace, for windows other than the
// embedder's (the parent process's own picker, as nsFilePickerSelector makes).
const NATIVE_FILE_PICKER_CONTRACT = "@mozilla.org/parent/filepicker;1";

let gNextId = 1;
// id -> { window, resolve(answer | null) }
const gPending = new Map();
// Paths the embedder chose for downloads -> the question's id.
const gExpectedDownloads = new Map();
// Download -> { id, window }
const gDownloads = new Map();
let gStarted = false;

function originOf(principalOrUri) {
  try {
    const uri = principalOrUri?.URI ?? principalOrUri;
    return uri?.prePath ?? "";
  } catch {
    return "";
  }
}

// The embed window a browsing context belongs to; null for any other window.
function embedWindowOf(browsingContext) {
  const win = browsingContext?.top?.topChromeWindow;
  return win?.document?.documentElement?.getAttribute("windowtype") == "zen:embed" ? win : null;
}

// The browser window the embedder shows whole that a browsing context (a
// page's, or the chrome's own) belongs to; null for any other window.
function browserWindowOf(browsingContext) {
  const win = browsingContext?.top?.topChromeWindow;
  return win?.document?.documentElement?.hasAttribute("zen-embedded") ? win : null;
}

// nsIFilePickerShownCallback as XPCOM passes it (an object) or as a script
// calling this picker directly does (a function).
function pickerDone(callback, result) {
  if (typeof callback == "function") {
    callback(result);
  } else {
    callback?.done(result);
  }
}

function windowAlive(win) {
  return win && !win.closed;
}

// An nsISimpleEnumerator over `items` (the picker's files).
function enumerate(items) {
  const array = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  for (const item of items) {
    array.appendElement(item);
  }
  return array.enumerate();
}

// What PromptParent asks for and reads back (the keys commonDialog.js writes).
const PROMPT_RESULTS = ["ok", "value", "user", "pass", "checked", "buttonNumClicked"];

export const ZenEmbedDialogs = {
  // Once per process (the first embed or browser window): the pickers and
  // the download list become the embedder's.
  start() {
    if (gStarted) {
      return;
    }
    gStarted = true;
    const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    registrar.registerFactory(FILE_PICKER_CID, "Zen embed file picker", FILE_PICKER_CONTRACT, {
      createInstance: iid => new EmbedFilePicker().QueryInterface(iid),
    });
    registrar.registerFactory(
      HELPER_APP_DIALOG_CID,
      "Zen embed download dialog",
      HELPER_APP_DIALOG_CONTRACT,
      { createInstance: iid => EmbedHelperAppDialog.QueryInterface(iid) }
    );
    Services.obs.addObserver(this, "zen-embed-dialog-reply");
    Services.obs.addObserver(this, "zen-embed-download-cancel");
    Services.obs.addObserver(this, "zen-embed-print-panel");
    lazy.Downloads.getList(lazy.Downloads.ALL).then(list => list.addView(DownloadView));
  },

  // A browser window the embedder shows whole (ZenEmbedBrowser marks it
  // zen-embedded). Its popups are windows of their own on screen, never
  // NSPopovers (the window they would hang from is never on screen), so its
  // panels draw Nightly's own background, border and shadow (`nonnative`):
  // the native-popover style leaves that to the popover and they showed
  // transparent.
  browserWindow(win) {
    this.start();
    win.addEventListener(
      "popupshowing",
      event => {
        if (event.target.localName == "panel") {
          event.target.setAttribute("nonnative", "true");
        }
      },
      true
    );
  },

  // Asks the embedder from `win`'s pane; resolves with its answer, or null
  // when it was withdrawn (abort) or the window went.
  ask(win, question) {
    if (!windowAlive(win)) {
      return { id: 0, answer: Promise.resolve(null) };
    }
    const id = gNextId++;
    const answer = new Promise(resolve => gPending.set(id, { window: win, resolve }));
    Services.obs.notifyObservers(win, "zen-embed-dialog", `${id}\n${JSON.stringify(question)}`);
    return { id, answer };
  },

  // Nightly withdrew question `id`: the embedder closes its card.
  abort(id) {
    const pending = gPending.get(id);
    if (!pending) {
      return;
    }
    gPending.delete(id);
    if (windowAlive(pending.window)) {
      Services.obs.notifyObservers(pending.window, "zen-embed-dialog-closed", String(id));
    }
    pending.resolve(null);
  },

  // The window is going: every question it asked is withdrawn.
  windowClosed(win) {
    for (const [id, pending] of gPending) {
      if (pending.window == win) {
        gPending.delete(id);
        pending.resolve(null);
      }
    }
  },

  observe(subject, topic, data) {
    if (topic == "zen-embed-print-panel") {
      const question = JSON.parse(data);
      // Print preview's parent is its print.html subdialog, not the pane's
      // chrome window. The transport is registered only on the latter.
      const win = Services.wm.getOuterWindowWithId(question.windowId)?.browsingContext?.topChromeWindow;
      const callback = subject.QueryInterface(Ci.nsIObserver);
      this.ask(win, question).answer.then(answer => {
        callback.observe(null, "zen-embed-print-result", answer?.printInfo ?? "");
      });
      return;
    }
    const newline = data.indexOf("\n");
    const id = Number(newline < 0 ? data : data.slice(0, newline));
    if (topic == "zen-embed-download-cancel") {
      for (const [download, entry] of gDownloads) {
        if (entry.id == id) {
          download.finalize(true).catch(console.error);
        }
      }
      return;
    }
    const pending = gPending.get(id);
    if (!pending || pending.window != subject) {
      return;
    }
    gPending.delete(id);
    let answer = null;
    try {
      answer = JSON.parse(data.slice(newline + 1));
    } catch (e) {
      console.error(e);
    }
    pending.resolve(answer);
  },

  // window.gBrowser of an embed window, as PromptParent uses it: its prompts
  // are tab-modal, shown by the embedder.
  tabDialogBox(win, browser) {
    const box = {
      open(uri, options, bag) {
        const args = {};
        for (const property of bag.enumerator) {
          args[property.name] = property.value;
        }
        const { id, answer } = ZenEmbedDialogs.ask(win, promptQuestion(args));
        const dialog = { promptID: null, abort: () => ZenEmbedDialogs.abort(id) };
        const closedPromise = answer.then(reply => {
          applyPromptAnswer(args, reply);
          for (const name of PROMPT_RESULTS) {
            if (name in args) {
              bag.setProperty(name, args[name]);
            }
          }
        });
        return { dialog, closedPromise };
      },
      abortAllDialogs() {},
    };
    return {
      get selectedBrowser() {
        return browser;
      },
      getTabDialogBox: () => box,
      getTabForBrowser: () => null,
      setTabLabelForAuthPrompts() {},
    };
  },

  // window.PopupNotifications of an embed window: permission doorhangers
  // become the embedder's permission cards; any other doorhanger (password
  // saving, add-ons) is dismissed without an answer.
  popupNotifications(win) {
    const shown = new Map(); // notification id -> notification
    const self = {
      panel: win.document.createXULElement("vbox"),
      show(browser, id, message, anchorId, mainAction, secondaryActions, options = {}) {
        const notification = {
          id,
          browser,
          message,
          anchorID: anchorId,
          mainAction,
          secondaryActions: secondaryActions ?? [],
          options,
          removed: false,
          remove: (withoutUserResponse = false) => self.remove(notification, withoutUserResponse),
        };
        shown.get(id)?.remove();
        shown.set(id, notification);
        askPermission(win, notification).then(
          () => {},
          e => {
            console.error(e);
            self.remove(notification, true);
          }
        );
        return notification;
      },
      getNotification(id) {
        return shown.get(id) ?? null;
      },
      remove(notification, withoutUserResponse = false) {
        if (shown.get(notification.id) != notification) {
          return;
        }
        shown.delete(notification.id);
        notification.removed = true;
        if (notification.questionId) {
          ZenEmbedDialogs.abort(notification.questionId);
        }
        notification.options.eventCallback?.call(notification, "removed", null, withoutUserResponse);
      },
      locallyDismiss() {},
    };
    return self;
  },
};

// ── prompts ──

function promptQuestion(args) {
  const origin = originOf(args.promptPrincipal ?? args.channel?.URI);
  if (args.inPermitUnload) {
    return { kind: "beforeunload", origin, message: args.text ?? "" };
  }
  switch (args.promptType) {
    case "alert":
    case "alertCheck":
      return { kind: "alert", origin, message: args.text ?? "" };
    case "confirm":
    case "confirmCheck":
    case "confirmEx":
      return { kind: "confirm", origin, message: args.text ?? "" };
    case "prompt":
      return { kind: "prompt", origin, message: args.text ?? "", default: args.value ?? "" };
    case "promptUserAndPass":
    case "promptPassword": {
      const uri = args.channel?.URI;
      const proxy = !!args.authInfo?.flags && !!(args.authInfo.flags & Ci.nsIAuthInformation.AUTH_PROXY);
      return {
        kind: "auth",
        origin,
        host: uri?.host ?? "",
        port: uri?.port > 0 ? uri.port : uri?.scheme == "https" ? 443 : 80,
        realm: args.authInfo?.realm ?? "",
        proxy,
        user: args.user ?? "",
        failed: !!(args.authInfo?.flags & Ci.nsIAuthInformation.PREVIOUS_FAILED),
      };
    }
    default:
      // select dialogs (a plug-in era leftover) and anything newer: cancelled.
      return { kind: "alert", origin, message: args.text ?? "" };
  }
}

function applyPromptAnswer(args, reply) {
  const ok = !!reply?.ok;
  switch (args.promptType) {
    case "alert":
    case "alertCheck":
      args.ok = true;
      return;
    case "confirmEx":
      // Button 0 is the accept button of every confirmEx a page can cause
      // (beforeunload); 1 cancels.
      args.ok = ok;
      args.buttonNumClicked = ok ? 0 : 1;
      return;
    case "prompt":
      args.ok = ok;
      if (ok) {
        args.value = String(reply.value ?? "");
      }
      return;
    case "promptUserAndPass":
    case "promptPassword":
      args.ok = ok;
      if (ok) {
        args.user = String(reply.user ?? "");
        args.pass = String(reply.password ?? "");
      }
      return;
    default:
      args.ok = ok;
  }
}

// ── permissions ──

const PERMISSION_IDS = {
  geolocation: "geolocation",
  "web-notifications": "notifications",
  "storage-access": "storage-access",
  "persistent-storage": "other",
  midi: "other",
  "xr-session": "other",
};

async function askPermission(win, notification) {
  const { id, browser, options } = notification;
  let permission = PERMISSION_IDS[id];
  if (id == "webRTC-shareDevices") {
    // WebRTCParent fills the device lists of the window's (hidden) webRTC
    // panel content on "showing" and sets the main action's callback there.
    options.eventCallback?.call(notification, "showing");
    const doc = win.document;
    const camera = !doc.getElementById("webRTC-selectCamera")?.hidden;
    const microphone = !doc.getElementById("webRTC-selectMicrophone")?.hidden;
    const screen = !doc.getElementById("webRTC-selectWindowOrScreen")?.hidden;
    if (screen) {
      // Choosing a window or screen to share needs a picker the embedder has
      // not: refused, as a dismissed doorhanger is.
      notification.remove(true);
      return;
    }
    permission = camera && microphone ? "camera-microphone" : camera ? "camera" : "microphone";
  }
  if (!permission) {
    notification.remove(true);
    return;
  }
  options.eventCallback?.call(notification, "shown");
  const origin = originOf(options.displayURI ?? browser?.currentURI);
  const message = typeof notification.message == "string" ? notification.message : "";
  const { id: questionId, answer } = ZenEmbedDialogs.ask(win, {
    kind: "permission",
    origin,
    permission,
    message,
  });
  notification.questionId = questionId;
  const reply = await answer;
  notification.questionId = 0;
  if (notification.removed) {
    return; // withdrawn by Nightly meanwhile
  }
  if (!reply) {
    notification.remove(true);
    return;
  }
  const allow = reply.answer == "once" || reply.answer == "always";
  if (allow) {
    notification.mainAction?.callback?.({
      checkboxChecked: reply.answer == "always",
      source: "button",
    });
  } else {
    // The deny action fires at once (no security delay); without one the
    // removal without an answer denies.
    const deny = notification.secondaryActions.find(a => a.disableSecurityDelay);
    if (deny) {
      deny.callback?.({ checkboxChecked: false, source: "button" });
    } else {
      notification.remove(true);
      return;
    }
  }
  notification.remove(false);
}

// ── file pickers ──

const FILTER_ACCEPT = [
  [Ci.nsIFilePicker.filterImages, "image/*"],
  [Ci.nsIFilePicker.filterAudio, "audio/*"],
  [Ci.nsIFilePicker.filterVideo, "video/*"],
  [Ci.nsIFilePicker.filterHTML, ".html"],
  [Ci.nsIFilePicker.filterText, ".txt"],
  [Ci.nsIFilePicker.filterXML, ".xml"],
  [Ci.nsIFilePicker.filterPDF, ".pdf"],
];

// The filter masks' titles and patterns, as nsBaseFilePicker::AppendFilters
// reads them.
const FILTER_MASKS = [
  [Ci.nsIFilePicker.filterAll, "all"],
  [Ci.nsIFilePicker.filterHTML, "html"],
  [Ci.nsIFilePicker.filterText, "text"],
  [Ci.nsIFilePicker.filterImages, "image"],
  [Ci.nsIFilePicker.filterXML, "xml"],
  [Ci.nsIFilePicker.filterXUL, "xul"],
  [Ci.nsIFilePicker.filterApps, "apps"],
  [Ci.nsIFilePicker.filterAudio, "audio"],
  [Ci.nsIFilePicker.filterVideo, "video"],
  [Ci.nsIFilePicker.filterPDF, "pdf"],
];

function maskFilters(mask) {
  const titles = Services.strings.createBundle("chrome://global/locale/filepicker.properties");
  const patterns = Services.strings.createBundle("chrome://global/content/filepicker.properties");
  const filters = [];
  for (const [flag, name] of FILTER_MASKS) {
    if (mask & flag) {
      // Applications are bundles: any file, as the system picker treats them.
      const filter = name == "apps" ? "*" : patterns.GetStringFromName(`${name}Filter`);
      filters.push({ title: titles.GetStringFromName(`${name}Title`), patterns: splitPatterns(filter) });
    }
  }
  return filters;
}

function splitPatterns(filter) {
  return filter
    .split(";")
    .map(p => p.trim())
    .filter(Boolean);
}

const PICKER_MODES = {
  [Ci.nsIFilePicker.modeOpen]: "open",
  [Ci.nsIFilePicker.modeOpenMultiple]: "multiple",
  [Ci.nsIFilePicker.modeGetFolder]: "folder",
  [Ci.nsIFilePicker.modeSave]: "save",
};

class EmbedFilePicker {
  #window = null;
  // A browser window the embedder shows whole: the system panel, shown by
  // the embedder on its own window ("panel").
  #browserWindow = null;
  #origin = "";
  #title = "";
  #mode = Ci.nsIFilePicker.modeOpen;
  #accept = [];
  #filters = [];
  #files = [];
  // The system picker, for any other window.
  #native = null;

  defaultString = "";
  defaultExtension = "";
  filterIndex = 0;
  displayDirectory = null;
  displaySpecialDirectory = "";
  addToRecentDocs = false;
  okButtonLabel = "";
  capture = Ci.nsIFilePicker.captureNone;

  init(browsingContext, title, mode) {
    this.#window = embedWindowOf(browsingContext);
    this.#browserWindow = this.#window ? null : browserWindowOf(browsingContext);
    this.#origin = originOf(browsingContext?.top?.currentWindowGlobal?.documentPrincipal);
    this.#title = title ?? "";
    this.#mode = mode;
    if (!this.#window && !this.#browserWindow) {
      // Not an embedder's window: the system picker, as in Nightly.
      this.#native = Cc[NATIVE_FILE_PICKER_CONTRACT].createInstance(Ci.nsIFilePicker);
      this.#native.init(browsingContext, title, mode);
    }
  }

  isModeSupported(mode) {
    return this.#native ? this.#native.isModeSupported(mode) : Promise.resolve(true);
  }

  appendFilters(mask) {
    this.#native?.appendFilters(mask);
    if (this.#browserWindow) {
      this.#filters.push(...maskFilters(mask));
    }
    for (const [flag, accept] of FILTER_ACCEPT) {
      if (mask & flag) {
        this.#accept.push(accept);
      }
    }
  }

  appendFilter(title, filter) {
    this.#native?.appendFilter(title, filter);
    this.#filters.push({ title, patterns: splitPatterns(filter) });
    for (const part of filter.split(";")) {
      const pattern = part.trim();
      if (pattern.startsWith("*.")) {
        this.#accept.push(pattern.slice(1));
      }
    }
  }

  appendRawFilter(filter) {
    this.#native?.appendRawFilter(filter);
    const value = filter.trim();
    if (value) {
      this.#accept.push(value);
      // ".ext" or a MIME type ("image/*"), as a page's accept lists them.
      this.#filters.push(
        value.startsWith(".") ? { title: "", patterns: [`*${value}`] } : { title: "", mimeTypes: [value] }
      );
    }
  }

  get mode() {
    return this.#mode;
  }

  get file() {
    return this.#native ? this.#native.file : (this.#files[0] ?? null);
  }

  get fileURL() {
    if (this.#native) {
      return this.#native.fileURL;
    }
    return this.#files[0] ? Services.io.newFileURI(this.#files[0]) : null;
  }

  get files() {
    return this.#native ? this.#native.files : enumerate(this.#files);
  }

  // Only content-process pickers read these; FilePickerParent reads files.
  get domFileOrDirectory() {
    return this.#native ? this.#native.domFileOrDirectory : null;
  }

  get domFileOrDirectoryEnumerator() {
    return this.#native ? this.#native.domFileOrDirectoryEnumerator : enumerate([]);
  }

  get domFilesInWebKitDirectory() {
    return this.#native ? this.#native.domFilesInWebKitDirectory : enumerate([]);
  }

  #openNative(callback) {
    const native = this.#native;
    native.defaultString = this.defaultString;
    native.defaultExtension = this.defaultExtension;
    native.filterIndex = this.filterIndex;
    native.addToRecentDocs = this.addToRecentDocs;
    native.okButtonLabel = this.okButtonLabel;
    if (this.displayDirectory) {
      native.displayDirectory = this.displayDirectory;
    }
    if (this.displaySpecialDirectory) {
      native.displaySpecialDirectory = this.displaySpecialDirectory;
    }
    native.open({
      done: result => {
        this.filterIndex = native.filterIndex;
        pickerDone(callback, result);
      },
    });
  }

  open(callback) {
    if (this.#native) {
      this.#openNative(callback);
      return;
    }
    if (this.#browserWindow) {
      this.#openPanel(callback);
      return;
    }
    const save = this.#mode == Ci.nsIFilePicker.modeSave;
    const question = save
      ? { kind: "download", origin: this.#origin, name: this.defaultString || "download", size: -1, url: "" }
      : {
          kind: "file",
          origin: this.#origin,
          multiple: this.#mode == Ci.nsIFilePicker.modeOpenMultiple,
          directory: this.#mode == Ci.nsIFilePicker.modeGetFolder,
          accept: [...new Set(this.#accept)],
        };
    const { id, answer } = ZenEmbedDialogs.ask(this.#window, question);
    answer.then(reply => {
      const paths = save ? (reply?.path ? [reply.path] : []) : (reply?.paths ?? []);
      this.#files = [];
      for (const path of paths) {
        try {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(String(path));
          this.#files.push(file);
        } catch (e) {
          console.error(e);
        }
      }
      if (save && this.#files.length) {
        // Whatever saves it (saveURL, Save Page As) reports through the
        // download list: tracked as this question's download.
        gExpectedDownloads.set(this.#files[0].path, { id, window: this.#window });
      }
      const result = this.#files.length
        ? save
          ? Ci.nsIFilePicker.returnReplace
          : Ci.nsIFilePicker.returnOK
        : Ci.nsIFilePicker.returnCancel;
      pickerDone(callback, result);
    });
  }

  // The embedder's own open or save panel, a sheet on its window, for a
  // browser window it shows whole; the page, Save Page As, a download Nightly
  // asks where to save, Save to PDF and imports get it as from the system
  // picker.
  #openPanel(callback) {
    const save = this.#mode == Ci.nsIFilePicker.modeSave;
    let directory = this.displayDirectory?.path ?? "";
    if (!directory && this.displaySpecialDirectory) {
      try {
        directory = Services.dirsvc.get(this.displaySpecialDirectory, Ci.nsIFile).path;
      } catch {}
    }
    const { answer } = ZenEmbedDialogs.ask(this.#browserWindow, {
      kind: "panel",
      origin: this.#origin,
      mode: PICKER_MODES[this.#mode] ?? "open",
      title: this.#title,
      name: this.defaultString,
      extension: this.defaultExtension,
      directory,
      okLabel: this.okButtonLabel,
      filterIndex: this.filterIndex,
      filters: this.#filters,
    });
    answer.then(reply => {
      this.#files = [];
      for (const path of reply?.paths ?? []) {
        try {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(String(path));
          this.#files.push(file);
        } catch (e) {
          console.error(e);
        }
      }
      if (Number.isInteger(reply?.filterIndex) && reply.filterIndex >= 0) {
        this.filterIndex = reply.filterIndex;
      }
      let result = Ci.nsIFilePicker.returnCancel;
      if (this.#files.length) {
        // The panel asked before replacing a file, as the system picker does.
        result = save && this.#files[0].exists() ? Ci.nsIFilePicker.returnReplace : Ci.nsIFilePicker.returnOK;
      }
      pickerDone(callback, result);
    });
  }

  close() {
    this.#native?.close();
  }

  QueryInterface = ChromeUtils.generateQI(["nsIFilePicker"]);
}

// ── downloads ──

// Nightly's own download dialog (HelperAppDlg) answers for a download of any
// window but an embed window's: a browser window the embedder shows whole
// asks where to save, or not, as Nightly does, through the file picker (there
// the embedder's panel).
function downloadEmbedWindow(launcher) {
  try {
    return embedWindowOf(BrowsingContext.get(launcher.browsingContextId));
  } catch {
    return null;
  }
}

const EmbedHelperAppDialog = {
  // Asked what to do with content Nightly does not show: saved, where the
  // embedder says.
  show(launcher, windowContext, reason) {
    if (!downloadEmbedWindow(launcher)) {
      new lazy.nsUnknownContentTypeDialog().show(launcher, windowContext, reason);
      return;
    }
    launcher.promptForSaveDestination();
  },

  promptForSaveToFileAsync(launcher, windowContext, defaultFileName, suggestedFileExtension, forcePrompt) {
    const win = downloadEmbedWindow(launcher);
    if (!win) {
      new lazy.nsUnknownContentTypeDialog().promptForSaveToFileAsync(
        launcher,
        windowContext,
        defaultFileName,
        suggestedFileExtension,
        forcePrompt
      );
      return;
    }
    const { id, answer } = ZenEmbedDialogs.ask(win, {
      kind: "download",
      origin: "",
      name: launcher.suggestedFileName || defaultFileName || "download",
      size: launcher.contentLength,
      url: launcher.source?.spec ?? "",
    });
    answer.then(reply => {
      if (!reply?.path) {
        launcher.saveDestinationAvailable(null);
        return;
      }
      try {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(String(reply.path));
        gExpectedDownloads.set(file.path, { id, window: win });
        launcher.saveDestinationAvailable(file, true);
      } catch (e) {
        console.error(e);
        launcher.saveDestinationAvailable(null);
      }
    });
  },

  QueryInterface: ChromeUtils.generateQI(["nsIHelperAppLauncherDialog"]),
};

const DownloadView = {
  onDownloadAdded(download) {
    const expected = gExpectedDownloads.get(download.target.path);
    if (!expected) {
      return;
    }
    gExpectedDownloads.delete(download.target.path);
    gDownloads.set(download, expected);
    this.report(download);
  },

  onDownloadChanged(download) {
    this.report(download);
  },

  onDownloadRemoved(download) {
    gDownloads.delete(download);
  },

  report(download) {
    const entry = gDownloads.get(download);
    if (!entry) {
      return;
    }
    const state = download.succeeded
      ? "finished"
      : download.canceled
        ? "canceled"
        : download.error
          ? "failed"
          : "saving";
    const json = JSON.stringify({
      state,
      received: download.currentBytes,
      total: download.hasProgress ? download.totalBytes : -1,
      path: download.target.path,
      error: download.error ? String(download.error.message ?? download.error) : null,
    });
    Services.obs.notifyObservers(
      windowAlive(entry.window) ? entry.window : null,
      "zen-embed-download",
      `${entry.id}\n${json}`
    );
    if (download.stopped && !download.hasPartialData) {
      gDownloads.delete(download);
    }
  },
};

ZenEmbedDialogs.QueryInterface = ChromeUtils.generateQI(["nsIObserver"]);
