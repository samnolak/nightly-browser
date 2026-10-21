/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Augur v1: preconnection for the embedder's intents. The embedder sends
// Command{speculate} (ZenEmbedHost.mm) just before a navigation it is about to
// cause: an agent's open, click or goto, or an address the user committed.
// ZenEmbedHost passes its JSON here as zen-embed-speculate, the subject being
// the target window's chrome window (none for window 0, a pane about to open):
//   {"v":1,"id":"<16 hex>","source":"agent_open|agent_click|agent_goto|
//    address_commit","action":"hint","url":"https://…","p":0.98,
//    "leadMs":250,"ttlMs":10000}
//   {"v":1,"id":"<16 hex>","action":"cancel"}
// A hint may open up to three connections to the URL's origin, DNS, TCP and
// TLS only (nsISpeculativeConnect through zen-embed-preconnect, whose
// overrider lets it while network.http.speculative-parallel-limit stays 0);
// never an HTTP request, so no cookie is sent. The OriginAttributes are the
// window's (a pane about to open: the default ones), never the JSON's.
//
// How many: the probability p the navigation follows, calibrated per source
// (online Platt scaling over its outcomes), against what a connection saves
// (the lead before the navigation, up to CONNECT_MS) and what a wasted one
// costs (MISS_COST_MS): socket j opens when p·q_j·S − (1 − p·q_j)·C > 0 and p
// is at least its floor, q_j being how likely the navigation needs a j-th
// connection. An origin known to speak HTTP/2 or HTTP/3 gets one. Budgets:
// GLOBAL_SOCKETS for all live hints, ORIGIN_SOCKETS per origin and
// OriginAttributes, one batch per origin per ORIGIN_EPOCH_MS, MAX_CANDIDATES
// hints, MAX_TTL_MS. Nothing while ombra.augur.enabled is false, offline, on a
// mobile link, under critical memory pressure or while quitting.
//
// Outcomes: a hint is a hit (1) when a top-level navigation to its origin
// starts before it expires, a miss (0) when it is cancelled, expires, or its
// window navigates elsewhere first. They train the calibration, saved
// atomically in <profile>/augur-calibration.json: per source {a, b, n,
// sumSquaredError}, no URL, origin or history.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "log", () =>
  console.createInstance({
    prefix: "ZenEmbedAugur",
    maxLogLevelPref: "ombra.augur.log-level",
  })
);
ChromeUtils.defineLazyGetter(lazy, "linkService", () =>
  Cc["@mozilla.org/network/network-link-service;1"].getService(Ci.nsINetworkLinkService)
);

const ENABLED_PREF = "ombra.augur.enabled";
const CALIBRATION_FILE = "augur-calibration.json";
const CALIBRATION_VERSION = 1;
const SAVE_DELAY_MS = 2000;

const SOURCES = ["agent_open", "agent_click", "agent_goto", "address_commit"];
const HINT_KEYS = ["v", "id", "source", "action", "url", "p", "leadMs", "ttlMs"];
const ID_PATTERN = /^[0-9a-f]{16}$/;
const MAX_URL_LENGTH = 8192;
const MAX_LEAD_MS = 5000;
const MIN_TTL_MS = 100;
const MAX_WIRE_TTL_MS = 30000;

// Expected utility (ms): connection setup saved, and the cost of a wasted one.
const CONNECT_MS = 130;
const MISS_COST_MS = 6;
// Socket j: how likely the navigation needs it, and the policy floor for p.
const SOCKET_NEED = [1.0, 0.7, 0.5];
const SOCKET_FLOORS = [0.1, 0.5, 0.9];

// Budgets.
const GLOBAL_SOCKETS = 6;
const ORIGIN_SOCKETS = 3;
const ORIGIN_EPOCH_MS = 2000;
const MAX_CANDIDATES = 128;
const MAX_TTL_MS = 10000;
// Origins whose protocol a navigation showed (HTTP/2, HTTP/3 or not).
const MAX_KNOWN_PROTOCOLS = 256;

// Calibration.
const MIN_OUTCOMES = 20;
const LEARNING_RATE = 0.02;
const REGULARIZATION = 1e-3;
const CLIP = 1e-4;
const BRIER_WINDOW = 200;
const BRIER_MARGIN = 0.02;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function logit(p) {
  const clipped = clamp(p, CLIP, 1 - CLIP);
  return Math.log(clipped / (1 - clipped));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function isInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function initialCalibration() {
  return { a: 1, b: 0, n: 0, sumSquaredError: 0 };
}

// What a navigation and a hint share to match: the OriginAttributes that key
// connections, and the host (an http hint matches its https upgrade).
function attributesKey(attributes) {
  return `${attributes.userContextId ?? 0}:${attributes.privateBrowsingId ?? 0}`;
}

// The strict reading of a Command{speculate}: the intent, or null.
function parseIntent(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json != "object" || Array.isArray(json)) {
    return null;
  }
  if (Object.keys(json).some(key => !HINT_KEYS.includes(key))) {
    return null;
  }
  if (json.v !== 1 || typeof json.id != "string" || !ID_PATTERN.test(json.id)) {
    return null;
  }
  if (json.action == "cancel") {
    return { action: "cancel", id: json.id };
  }
  if (json.action != "hint" || !SOURCES.includes(json.source)) {
    return null;
  }
  if (typeof json.p != "number" || !(json.p >= 0 && json.p <= 1)) {
    return null;
  }
  if (!isInteger(json.leadMs, 0, MAX_LEAD_MS) || !isInteger(json.ttlMs, MIN_TTL_MS, MAX_WIRE_TTL_MS)) {
    return null;
  }
  if (typeof json.url != "string" || json.url.length > MAX_URL_LENGTH) {
    return null;
  }
  let uri;
  try {
    uri = Services.io.newURI(json.url);
  } catch {
    return null;
  }
  if (!(uri.schemeIs("https") || uri.schemeIs("http")) || uri.userPass || !uri.asciiHost) {
    return null;
  }
  return {
    action: "hint",
    id: json.id,
    source: json.source,
    uri,
    p: json.p,
    leadMs: json.leadMs,
    ttlMs: Math.min(json.ttlMs, MAX_TTL_MS),
  };
}

// How many connections a hint is worth: the expected-utility rule with the
// policy floors, one for an HTTP/2 or HTTP/3 origin.
function socketsFor(p, leadMs, multiplexed) {
  const saving = Math.min(CONNECT_MS, Math.max(0, leadMs));
  let sockets = 0;
  for (let j = 0; j < SOCKET_NEED.length; j++) {
    const need = p * SOCKET_NEED[j];
    if (need * saving - (1 - need) * MISS_COST_MS <= 0 || p < SOCKET_FLOORS[j]) {
      break;
    }
    sockets = j + 1;
  }
  return multiplexed ? Math.min(sockets, 1) : sockets;
}

let gStarted = false;
// Intent id -> candidate, oldest first.
const gCandidates = new Map();
// attributesKey|host -> { lastBatchAt, live }.
const gOrigins = new Map();
// attributesKey|host -> true for HTTP/2 or HTTP/3, false otherwise; oldest
// first.
const gProtocols = new Map();
let gLiveSockets = 0;
let gMemoryCritical = false;
let gShuttingDown = false;
let gObservingNetwork = false;
let gExpiryTimer = null;
// source -> { a, b, n, sumSquaredError }, and source -> the last
// BRIER_WINDOW outcomes { applied, raw, y } (not saved).
const gCalibration = new Map(SOURCES.map(source => [source, initialCalibration()]));
const gRecent = new Map(SOURCES.map(source => [source, []]));
let gCalibrationLoaded = null;
let gSaveTask = null;

export const ZenEmbedAugur = {
  // browser-before-ui-startup (EmbedComponents.manifest): once per process,
  // only in an embedder's runtime.
  init() {
    if (gStarted || !Services.env.get("NIGHTLY_EMBED_SERVICE")) {
      return;
    }
    gStarted = true;
    Services.obs.addObserver(this, "zen-embed-speculate");
    Services.obs.addObserver(this, "memory-pressure");
    Services.obs.addObserver(this, "memory-pressure-stop");
    Services.obs.addObserver(this, "quit-application-granted");
    Services.prefs.addObserver(ENABLED_PREF, this);
    gSaveTask = new lazy.DeferredTask(() => this.saveCalibration(), SAVE_DELAY_MS);
    lazy.AsyncShutdown.profileBeforeChange.addBlocker("ZenEmbedAugur: calibration", () =>
      gSaveTask.finalize()
    );
    gCalibrationLoaded = this.loadCalibration();
  },

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, true);
  },

  observe(subject, topic, data) {
    switch (topic) {
      case "zen-embed-speculate":
        this.onIntent(subject, data);
        break;
      case "http-on-opening-request":
        this.onNavigationStart(subject);
        break;
      case "http-on-examine-response":
        this.onDocumentResponse(subject);
        break;
      case "memory-pressure":
        if (data == "low-memory" || data == "low-memory-ongoing") {
          gMemoryCritical = true;
        }
        break;
      case "memory-pressure-stop":
        gMemoryCritical = false;
        break;
      case "quit-application-granted":
        gShuttingDown = true;
        this.dropAll();
        break;
      case "nsPref:changed":
        if (!this.enabled) {
          this.dropAll();
        }
        break;
    }
  },

  // Whether a hint may connect now.
  canConnect() {
    if (!this.enabled || gShuttingDown || gMemoryCritical || Services.io.offline) {
      return false;
    }
    try {
      const link = lazy.linkService;
      if (link.linkStatusKnown && !link.isLinkUp) {
        return false;
      }
      if (link.linkType == Ci.nsINetworkLinkService.LINK_TYPE_MOBILE) {
        return false;
      }
    } catch {
      // No link service: nothing says the network is constrained.
    }
    return true;
  },

  onIntent(window, text) {
    if (!this.enabled || gShuttingDown) {
      return;
    }
    const intent = parseIntent(text);
    if (!intent) {
      lazy.log.warn("Rejected a malformed intent.");
      return;
    }
    if (intent.action == "cancel") {
      const candidate = gCandidates.get(intent.id);
      if (candidate && !candidate.outcome) {
        candidate.state = "cancelled";
        this.resolve(candidate, 0);
      }
      return;
    }
    if (gCandidates.has(intent.id)) {
      return;
    }
    let attributes = {};
    let windowId = 0;
    if (window) {
      if (window.closed) {
        return;
      }
      const browser =
        window.document.getElementById("zen-embed-browser") ?? window.gBrowser?.selectedBrowser;
      const browsingContext = browser?.browsingContext;
      if (!browsingContext) {
        return;
      }
      const { userContextId, privateBrowsingId } = browsingContext.originAttributes;
      attributes = { userContextId, privateBrowsingId };
      windowId = window.docShell.outerWindowID;
    }
    const now = ChromeUtils.now();
    const host = intent.uri.asciiHost;
    const originKey = `${attributesKey(attributes)}|${host}`;
    const calibration = gCalibration.get(intent.source);
    const pCalibrated =
      calibration.n >= MIN_OUTCOMES ? sigmoid(calibration.a * logit(intent.p) + calibration.b) : intent.p;
    const candidate = {
      id: intent.id,
      windowId,
      source: intent.source,
      host,
      originKey,
      attributesKey: attributesKey(attributes),
      pRaw: intent.p,
      pCalibrated,
      expectedLeadMs: intent.leadMs,
      createdAt: now,
      expiresAt: now + intent.ttlMs,
      requestedSockets: socketsFor(pCalibrated, intent.leadMs, gProtocols.get(originKey) === true),
      startedSockets: 0,
      state: "queued",
      outcome: null,
    };
    if (gCandidates.size >= MAX_CANDIDATES) {
      // The oldest goes without an outcome: it says nothing of the source.
      const [oldest] = gCandidates.values();
      this.release(oldest);
      gCandidates.delete(oldest.id);
    }
    gCandidates.set(candidate.id, candidate);
    this.start(candidate, intent.uri, attributes, now);
    this.watchNetwork();
    this.scheduleExpiry();
  },

  // Opens what the candidate is worth within the budgets.
  start(candidate, uri, attributes, now) {
    let sockets = 0;
    if (candidate.requestedSockets && this.canConnect()) {
      // Origins with no live socket and no batch in this epoch are done with.
      for (const [key, batch] of gOrigins) {
        if (batch.live <= 0 && now - batch.lastBatchAt >= ORIGIN_EPOCH_MS) {
          gOrigins.delete(key);
        }
      }
      let origin = gOrigins.get(candidate.originKey);
      if (!origin) {
        origin = { lastBatchAt: -Infinity, live: 0 };
        gOrigins.set(candidate.originKey, origin);
      }
      if (now - origin.lastBatchAt >= ORIGIN_EPOCH_MS) {
        sockets = Math.min(
          candidate.requestedSockets,
          ORIGIN_SOCKETS - origin.live,
          GLOBAL_SOCKETS - gLiveSockets
        );
      }
      if (sockets > 0) {
        origin.lastBatchAt = now;
        origin.live += sockets;
        gLiveSockets += sockets;
        const principal = Services.scriptSecurityManager.createContentPrincipal(
          Services.io.newURI(uri.prePath),
          attributes
        );
        Services.obs.notifyObservers(principal, "zen-embed-preconnect", String(sockets));
      }
    }
    candidate.startedSockets = Math.max(0, sockets);
    candidate.state = "running";
    lazy.log.info(
      `${candidate.id} ${candidate.source}: p ${candidate.pRaw} -> ${candidate.pCalibrated.toFixed(3)}, ` +
        `lead ${candidate.expectedLeadMs} ms, ${candidate.startedSockets}/${candidate.requestedSockets} sockets`
    );
  },

  // Gives the candidate's sockets back to the budgets.
  release(candidate) {
    if (!candidate.startedSockets) {
      return;
    }
    gLiveSockets -= candidate.startedSockets;
    const origin = gOrigins.get(candidate.originKey);
    if (origin) {
      origin.live -= candidate.startedSockets;
    }
    candidate.startedSockets = 0;
  },

  // A labeled outcome (1 hit, 0 miss). The connections are left to Gecko's
  // idle timeout; a used candidate stays until it expires, for the protocol
  // its navigation shows.
  resolve(candidate, y) {
    candidate.outcome = y ? "hit" : "miss";
    if (y) {
      candidate.state = "used";
    } else {
      gCandidates.delete(candidate.id);
    }
    lazy.log.info(`${candidate.id} ${candidate.source}: ${candidate.state}, y=${y}`);
    this.release(candidate);
    this.learn(candidate, y).catch(console.error);
    this.watchNetwork();
  },

  // Cancels everything, without outcomes (disabled, quitting).
  dropAll() {
    for (const candidate of gCandidates.values()) {
      this.release(candidate);
    }
    gCandidates.clear();
    gOrigins.clear();
    gLiveSockets = 0;
    this.watchNetwork();
    if (gExpiryTimer) {
      lazy.clearTimeout(gExpiryTimer);
      gExpiryTimer = null;
    }
  },

  scheduleExpiry() {
    if (gExpiryTimer) {
      lazy.clearTimeout(gExpiryTimer);
      gExpiryTimer = null;
    }
    let next = Infinity;
    for (const candidate of gCandidates.values()) {
      next = Math.min(next, candidate.expiresAt);
    }
    if (next == Infinity) {
      return;
    }
    gExpiryTimer = lazy.setTimeout(() => {
      gExpiryTimer = null;
      const now = ChromeUtils.now();
      for (const candidate of [...gCandidates.values()]) {
        if (candidate.expiresAt > now) {
          continue;
        }
        if (candidate.outcome) {
          gCandidates.delete(candidate.id);
        } else {
          candidate.state = "expired";
          this.resolve(candidate, 0);
        }
      }
      this.watchNetwork();
      this.scheduleExpiry();
    }, Math.max(0, next - ChromeUtils.now()));
  },

  // Navigations matter only while there are candidates.
  watchNetwork() {
    const want = gCandidates.size > 0;
    if (want == gObservingNetwork) {
      return;
    }
    gObservingNetwork = want;
    if (want) {
      Services.obs.addObserver(this, "http-on-opening-request");
      Services.obs.addObserver(this, "http-on-examine-response");
    } else {
      Services.obs.removeObserver(this, "http-on-opening-request");
      Services.obs.removeObserver(this, "http-on-examine-response");
    }
  },

  // A top-level document channel: its host, OriginAttributes key and chrome
  // window id, or null.
  topLevelDocument(subject) {
    if (!(subject instanceof Ci.nsIHttpChannel)) {
      return null;
    }
    const loadInfo = subject.loadInfo;
    if (
      !loadInfo ||
      !loadInfo.isTopLevelLoad ||
      loadInfo.externalContentPolicyType != Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
      return null;
    }
    let host;
    try {
      host = subject.URI.asciiHost;
    } catch {
      return null;
    }
    const chrome = loadInfo.browsingContext?.top?.embedderElement?.ownerGlobal;
    return {
      host,
      attributesKey: attributesKey(loadInfo.originAttributes),
      windowId: chrome?.docShell?.outerWindowID ?? 0,
      redirected: loadInfo.redirectChain.length > 0,
    };
  },

  onNavigationStart(subject) {
    const navigation = this.topLevelDocument(subject);
    if (!navigation) {
      return;
    }
    for (const candidate of [...gCandidates.values()]) {
      if (candidate.outcome) {
        continue;
      }
      if (candidate.host == navigation.host && candidate.attributesKey == navigation.attributesKey) {
        this.resolve(candidate, 1);
      } else if (!navigation.redirected && candidate.windowId && candidate.windowId == navigation.windowId) {
        // Its window went elsewhere first.
        this.resolve(candidate, 0);
      }
    }
  },

  // Learns whether a hinted origin speaks HTTP/2 or HTTP/3 from its
  // navigation (memory only).
  onDocumentResponse(subject) {
    const navigation = this.topLevelDocument(subject);
    if (!navigation) {
      return;
    }
    const key = `${navigation.attributesKey}|${navigation.host}`;
    if (![...gCandidates.values()].some(candidate => candidate.originKey == key)) {
      return;
    }
    let protocol;
    try {
      protocol = subject.protocolVersion;
    } catch {
      return;
    }
    gProtocols.delete(key);
    gProtocols.set(key, protocol == "h2" || protocol == "h3");
    if (gProtocols.size > MAX_KNOWN_PROTOCOLS) {
      gProtocols.delete(gProtocols.keys().next().value);
    }
  },

  // One online Platt scaling step for the candidate's source, after the
  // calibration file is read.
  async learn(candidate, y) {
    await gCalibrationLoaded;
    const calibration = gCalibration.get(candidate.source);
    const x = logit(candidate.pRaw);
    const learned = sigmoid(calibration.a * x + calibration.b);
    const rate = LEARNING_RATE / Math.sqrt(1 + calibration.n / 100);
    const error = learned - y;
    calibration.a -= rate * (error * x + REGULARIZATION * (calibration.a - 1));
    calibration.b -= rate * (error + REGULARIZATION * calibration.b);
    calibration.n += 1;
    calibration.sumSquaredError += (candidate.pCalibrated - y) ** 2;

    const recent = gRecent.get(candidate.source);
    recent.push({ applied: candidate.pCalibrated, raw: candidate.pRaw, y });
    if (recent.length > BRIER_WINDOW) {
      recent.shift();
    }
    if (recent.length >= MIN_OUTCOMES) {
      let applied = 0;
      let raw = 0;
      for (const outcome of recent) {
        applied += (outcome.applied - outcome.y) ** 2;
        raw += (outcome.raw - outcome.y) ** 2;
      }
      if ((applied - raw) / recent.length > BRIER_MARGIN) {
        // Calibrated worse than the prior: back to it.
        lazy.log.info(`${candidate.source}: calibration rolled back to the prior.`);
        gCalibration.set(candidate.source, initialCalibration());
        recent.length = 0;
      }
    }
    gSaveTask.arm();
  },

  get calibrationPath() {
    return PathUtils.join(PathUtils.profileDir, CALIBRATION_FILE);
  },

  async loadCalibration() {
    let json;
    try {
      json = await IOUtils.readJSON(this.calibrationPath);
    } catch (e) {
      if (!DOMException.isInstance(e) || e.name != "NotFoundError") {
        lazy.log.warn(`Could not read ${CALIBRATION_FILE}: ${e.message}`);
      }
      return;
    }
    if (json?.version !== CALIBRATION_VERSION || typeof json.sources != "object" || !json.sources) {
      return;
    }
    for (const source of SOURCES) {
      const saved = json.sources[source];
      if (
        saved &&
        Number.isFinite(saved.a) &&
        Number.isFinite(saved.b) &&
        Number.isInteger(saved.n) &&
        saved.n >= 0 &&
        Number.isFinite(saved.sumSquaredError) &&
        saved.sumSquaredError >= 0
      ) {
        const { a, b, n, sumSquaredError } = saved;
        gCalibration.set(source, { a, b, n, sumSquaredError });
      }
    }
  },

  async saveCalibration() {
    const sources = {};
    for (const [source, { a, b, n, sumSquaredError }] of gCalibration) {
      sources[source] = { a, b, n, sumSquaredError };
    }
    const path = this.calibrationPath;
    try {
      await IOUtils.writeJSON(
        path,
        { version: CALIBRATION_VERSION, sources },
        { tmpPath: `${path}.tmp` }
      );
    } catch (e) {
      lazy.log.warn(`Could not write ${CALIBRATION_FILE}: ${e.message}`);
    }
  },

  QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
};
