/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Scripts of an embedder's agent tools (ZenEmbedHost Script messages, relayed
// by zen-embed.js) in the top-level document of an embed window's browser.
// Registered for the embed browsers only (messageManagerGroups "zen-embed");
// it answers its parent's queries and nothing the page sends.
//  - kind 1, the page's world: the source runs as a classic script of the
//    page (its globals), as WKWebView's evaluateJavaScript does. The value
//    comes back as it is when a string, else as JSON.
//  - kind 2, the embedder's isolated world: the source is a function called
//    with the JSON array of arguments spread, its Promise awaited, in a
//    sandbox that sees the DOM through Xrays (the page's globals and patched
//    built-ins stay out), as a WKContentWorld. The value comes back as JSON.
// Neither gives the page user activation, and the page's CSP does not apply.
//
// The embedder's device mode emulates touch (zen-embed.js ZenEmbedDevice sets
// the top browsing context's touchEventsOverride and sends ZenEmbed:Touch to
// each document meanwhile): the mouse is a finger then, as in devtools'
// responsive design mode (its TouchSimulator): the left button's down, moves
// and up become touchstart, touchmove and touchend through APZ, which also
// makes the tap's click (and pans the page), the real click and hover are
// dropped, and a long press opens the context menu.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  addDebuggerToGlobal: "resource://gre/modules/jsdebugger.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "dbg", () => {
  // eslint-disable-next-line mozilla/reject-globalThis-modification
  lazy.addDebuggerToGlobal(globalThis);
  return new Debugger();
});

// ZenEmbedHost.mm's kScript* values.
const SCRIPT_PAGE = 1;
const SCRIPT_ISOLATED = 2;
const VALUE = 0;
const UNDEFINED = 1;
const ERROR = 2;
const NO_PAGE = 3;

// The isolated call: the caller's function with the arguments parsed from one
// string (no source splicing of values), its Promise awaited, the answer
// tagged ("v" + JSON, "e" + the exception, undefined for nothing to send).
const ISOLATED_HEAD = "(async (__ompArgs) => {\nconst __ompFn = (\n";
const ISOLATED_TAIL = `
);
let __ompValue;
try {
  __ompValue = await __ompFn(...JSON.parse(__ompArgs));
} catch (e) {
  let text;
  try { text = String(e); } catch (_) { text = "Error"; }
  const stack = e !== null && typeof e === "object" && typeof e.stack === "string" ? e.stack : "";
  return "e" + text + (stack && stack !== text ? "\\n" + stack : "");
}
if (__ompValue === undefined || typeof __ompValue === "function" || typeof __ompValue === "symbol") return undefined;
let __ompJson;
try { __ompJson = JSON.stringify(__ompValue); }
catch (e) { return "eTypeError: the result cannot be sent back as JSON: " + (e && e.message); }
return __ompJson === undefined ? undefined : "v" + __ompJson;
})`;

function describe(error) {
  let text;
  try {
    text = String(error);
  } catch (_) {
    text = "Error";
  }
  let stack = "";
  try {
    stack = typeof error?.stack == "string" ? error.stack : "";
  } catch (_) {}
  return stack && stack != text ? `${text}\n${stack}` : text;
}

const MOUSE_EVENTS = [
  "mousedown",
  "mousemove",
  "mouseup",
  "mouseenter",
  "mouseover",
  "mouseout",
  "mouseleave",
  "click",
];
const STATE_HOVER = 0x00000004; // ElementState::HOVER

// One per tab of this process (its chrome event handler sees the mouse events
// of all its documents), from the first ZenEmbed:Touch on; idle whenever the
// tab does not emulate touch, so touch turns off without the listeners going.
const touchSimulators = new WeakMap();

class TouchSimulator {
  #target = null;
  #contextMenuTimeout = 0;

  static install(docShell) {
    const handler = docShell?.chromeEventHandler;
    if (handler && !touchSimulators.has(handler)) {
      touchSimulators.set(handler, new TouchSimulator(handler));
    }
  }

  constructor(handler) {
    for (const type of MOUSE_EVENTS) {
      // Trusted events only: the page's own dispatched events stay as they are.
      handler.addEventListener(type, this, true, false);
    }
  }

  handleEvent(event) {
    // documentGlobal: a node's window (ownerGlobal exists in chrome windows only).
    const win = event.target?.documentGlobal;
    if (!win || win.browsingContext?.top?.touchEventsOverride != "enabled") {
      this.#target = null;
      return;
    }
    // The real mouse only (not the clicks and mouse events touch makes).
    if (
      event.button ||
      event.inputSource != event.MOZ_SOURCE_MOUSE ||
      event.isSynthesized
    ) {
      return;
    }
    let type = "";
    switch (event.type) {
      case "mouseenter":
      case "mouseover":
      case "mouseout":
      case "mouseleave":
        // A finger does not hover.
        InspectorUtils.removeContentState(event.target, STATE_HOVER);
        break;
      case "mousedown":
        this.#target = event.target;
        if (
          Services.prefs.getBoolPref("ui.click_hold_context_menus", false) &&
          !event.originalTarget.closest?.("scrollbar")
        ) {
          this.#contextMenuTimeout = this.#longPress(event);
        }
        type = "touchstart";
        break;
      case "mousemove":
        if (this.#target) {
          type = "touchmove";
        }
        break;
      case "mouseup":
        if (this.#target) {
          this.#target = null;
          win.clearTimeout(this.#contextMenuTimeout);
          type = "touchend";
        }
        break;
    }
    if (type) {
      win.synthesizeTouchEvent(
        type,
        [{ identifier: 0, offsetX: event.clientX, offsetY: event.clientY, radiiX: 0, radiiY: 0 }],
        0,
        { isAsyncEnabled: true }
      );
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  #longPress({ target, clientX, clientY, screenX, screenY }) {
    const view = target.documentGlobal;
    const menu = new view.PointerEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      view,
      screenX,
      screenY,
      clientX,
      clientY,
    });
    return view.setTimeout(
      () => target.dispatchEvent(menu),
      Services.prefs.getIntPref("ui.click_hold_context_menus.delay", 500)
    );
  }
}

export class ZenEmbedAgentChild extends JSWindowActorChild {
  #sandbox = null;

  async receiveMessage({ name, data }) {
    if (name == "ZenEmbed:Ready") {
      return true; // the actor loaded (zen-embed.js startedAgent)
    }
    if (name == "ZenEmbed:Touch") {
      // The page emulates touch (zen-embed.js sends this for each new
      // document then): the tab's mouse acts as a finger from now on.
      TouchSimulator.install(this.docShell);
      return null;
    }
    if (name != "ZenEmbed:Script") {
      return null;
    }
    const win = this.contentWindow;
    if (!win?.document) {
      return { status: NO_PAGE, text: "The page is gone." };
    }
    try {
      switch (data.kind) {
        case SCRIPT_PAGE:
          return this.#evaluate(win, data.source);
        case SCRIPT_ISOLATED:
          return await this.#call(win, data.source, data.args);
        default:
          return { status: ERROR, text: "Unknown script kind." };
      }
    } catch (e) {
      return { status: ERROR, text: describe(e) };
    }
  }

  didDestroy() {
    this.#sandbox = null;
  }

  #evaluate(win, source) {
    const global = lazy.dbg.makeGlobalObjectReference(win);
    const completion = global.executeInGlobal(source, {
      bypassCSP: true,
      url: win.document.baseURI,
    });
    if (!completion) {
      return { status: ERROR, text: "The script was stopped." };
    }
    if ("throw" in completion) {
      return { status: ERROR, text: describe(this.#unwrap(completion.throw)) };
    }
    const value = this.#unwrap(completion.return);
    if (value === undefined || value === null) {
      return { status: UNDEFINED };
    }
    if (typeof value == "string") {
      return { status: VALUE, text: value };
    }
    if (typeof value == "function" || typeof value == "symbol") {
      return { status: UNDEFINED };
    }
    let json;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      return { status: UNDEFINED };
    }
    return json === undefined ? { status: UNDEFINED } : { status: VALUE, text: json };
  }

  // A debuggee value as the page's own (Xrays waived: plain page objects
  // serialize with their own properties).
  #unwrap(value) {
    if (value instanceof Debugger.Object) {
      return Cu.waiveXrays(value.unsafeDereference());
    }
    return value;
  }

  async #call(win, source, args) {
    this.#sandbox ??= Cu.Sandbox(win, {
      sandboxName: "Ombra",
      sandboxPrototype: win,
      sameZoneAs: win,
      wantComponents: false,
      wantXrays: true,
    });
    const fn = Cu.evalInSandbox(
      ISOLATED_HEAD + source + ISOLATED_TAIL,
      this.#sandbox,
      null,
      "ombra-isolated",
      1
    );
    const answer = await fn(args || "[]");
    if (typeof answer != "string") {
      return { status: UNDEFINED };
    }
    return answer[0] == "v"
      ? { status: VALUE, text: answer.slice(1) }
      : { status: ERROR, text: answer.slice(1) };
  }
}
