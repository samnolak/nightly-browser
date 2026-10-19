/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { GalleryCommands } = ChromeUtils.importESModule(
  "resource:///modules/ZenGalleryUI.sys.mjs"
);
const $ = id => document.getElementById(id);
const command = (action, args) => GalleryCommands.run(window, action, args);
const MAX_CARDS = 80;
const MAX_URLS = 96;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_DECRYPTS = 4;
let locked = true;
let generation = 0;
let shots = [];
let columns = [];
let selected = new Set();
let cards = new Map();
let urls = new Map();
let cacheBytes = 0;
let queue = [];
const decodingURLs = new Set();
let active = 0;
let pending = new Set();
let frame = 0;
let searchTimer;
let refreshTimer;
let viewerId = null;
let viewerURL = null;
let viewerVersion = 0;
let loading = false;

let viewerLoading = false;
let viewerRequest = null;
function report(message) {
  $("status").textContent = message;
}

async function perform(action, args) {
  try {
    return await command(action, args);
  } catch {
    // Errors from OS services or file operations may contain private paths or
    // metadata. Never surface their exception text or log it to the console.
    report(
      locked
        ? "Gallery is locked. Unlock was not completed; you can retry."
        : "The operation could not be completed. Check your selection and system permissions, then retry."
    );
    return undefined;
  }
}

function closeViewer() {
  viewerVersion++;
  viewerId = null;
  viewerRequest = null;
  $("full-image").removeAttribute("src");
  $("full-image").alt = "";
  if (viewerURL) {
    URL.revokeObjectURL(viewerURL);
    viewerURL = null;
  }
  $("viewer-title").textContent = "";
  $("metadata").replaceChildren();
  $("palette").replaceChildren();
  $("note").value = "";
  if ($("viewer").open) {
    $("viewer").close();
  }
}

function clearImages() {
  queue = [];
  // In-flight decrypts keep their slots until they settle; their generation
  // checks prevent them from repopulating a locked or refreshed document.
  pending.clear();
  for (const { url } of urls.values()) {
    URL.revokeObjectURL(url);
  }
  urls.clear();
  cacheBytes = 0;
  for (const card of cards.values()) {
    card.querySelector("img").removeAttribute("src");
  }
  cards.clear();
  $("masonry").replaceChildren();
  closeViewer();
  for (const url of decodingURLs) {
    URL.revokeObjectURL(url);
  }
  decodingURLs.clear();
}

function clearGallery() {
  generation++;
  loading = false;
  clearImages();
  shots = [];
  columns = [];
  selected.clear();
  $("masonry").style.height = "0px";
  $("count").textContent = "0 screenshots";
  updateSelection();
}

function lockView() {
  locked = true;
  clearTimeout(searchTimer);
  clearTimeout(refreshTimer);
  clearGallery();
  $("gallery").hidden = true;
  $("lock").hidden = true;
  $("locked-screen").hidden = false;
  $("filters").reset();
  for (const id of ["bulk-tags", "folder-name", "watch-path"]) {
    $(id).value = "";
    if (id === "watch-path") {
      $(id).textContent = "";
    }
  }
  $("auto-tags").checked = false;
  $("watch-enabled").checked = false;
  $("idle-minutes").value = "";
  $("settings").hidden = true;
  $("settings-toggle").setAttribute("aria-expanded", "false");
  setFolders([]);
  report("Gallery locked. Decrypted previews and metadata have been cleared.");
}

function filters() {
  const result = {};
  for (const id of ["text", "tag", "site", "color"]) {
    if ($(id).value.trim()) {
      result[id] = $(id).value.trim();
    }
  }
  if ($("folder").value) {
    result.folderId = $("folder").value;
  }
  if ($("from").value) {
    result.from = new Date(`${$("from").value}T00:00:00`).getTime();
  }
  if ($("to").value) {
    const end = new Date(`${$("to").value}T00:00:00`);
    end.setDate(end.getDate() + 1);
    result.to = end.getTime() - 1;
  }
  return result;
}

function setFolders(folders) {
  for (const [id, title] of [
    ["folder", "All folders"],
    ["bulk-folder", "No folder"],
  ]) {
    const previous = $(id).value;
    $(id).replaceChildren(new Option(title, ""));
    for (const folder of folders) {
      $(id).appendChild(new Option(folder.name, folder.id));
    }
    $(id).value = previous;
  }
}

async function loadSettings(version) {
  const [folders, settings] = await Promise.all([
    command("folders"),
    command("settings"),
  ]);
  if (version !== generation || locked) {
    return;
  }
  setFolders(folders);
  $("auto-tags").checked = settings.autoTags;
  $("idle-minutes").value = settings.idleMinutes;
  $("watch-enabled").checked = !!settings.watchFolder;
  $("watch-path").textContent =
    settings.watchFolder || "System screenshot import is off";
}

async function reload() {
  if (locked) {
    return;
  }
  const version = ++generation;
  clearImages();
  shots = [];
  selected.clear();
  updateSelection();
  columns = [];
  $("masonry").style.height = "0px";
  loading = true;
  const query = filters();
  try {
    const settingsRequest = loadSettings(version);
    // Attach the rejection handler immediately, not after metadata paging.
    const settingsDone = settingsRequest.catch(() => {
      if (version === generation && !locked) {
        report("Gallery settings could not be loaded.");
      }
    });
    for (let offset = 0; ; offset += 500) {
      const result = await command("query", { ...query, offset, limit: 500 });
      if (version !== generation || locked) {
        return;
      }
      shots.push(...result.items);
      $("count").textContent = `${result.total} screenshots`;
      layout();
      if (
        offset + result.items.length >= result.total ||
        !result.items.length
      ) {
        break;
      }
      // Paint the first viewport before fetching remaining RAM-index pages.
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    await settingsDone;
    if (version === generation && !locked) {
      report("");
      loading = false;
      $("empty").hidden = shots.length !== 0;
      updateSelection();
    }
  } catch {
    if (version === generation && !locked) {
      loading = false;
      report("Gallery could not be loaded. Lock and unlock to retry.");
    }
  }
}

function layout() {
  const width = Math.max(1, $("viewport").clientWidth - 24);
  const count = Math.max(1, Math.min(8, Math.floor(width / 210)));
  const gap = 12;
  const cardWidth = (width - (count - 1) * gap) / count;
  columns = Array.from({ length: count }, () => ({ height: 0, items: [] }));
  for (const shot of shots) {
    let column = 0;
    for (let i = 1; i < count; i++) {
      if (columns[i].height < columns[column].height) {
        column = i;
      }
    }
    const height =
      Math.max(
        96,
        Math.min(360, (cardWidth * shot.height) / Math.max(1, shot.width))
      ) + 44;
    const entry = {
      shot,
      x: column * (cardWidth + gap),
      y: columns[column].height,
      width: cardWidth,
      height,
    };
    columns[column].items.push(entry);
    columns[column].height += height + gap;
  }
  $("masonry").style.height =
    `${Math.max(0, ...columns.map(column => column.height))}px`;
  scheduleRender();
}

function scheduleRender() {
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }
}

function visibleEntries() {
  const start = Math.max(0, $("viewport").scrollTop - 250);
  const end = start + $("viewport").clientHeight + 500;
  const entries = [];
  for (const { items } of columns) {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (items[middle].y + items[middle].height < start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    for (let i = low; i < items.length && items[i].y < end; i++) {
      entries.push(items[i]);
    }
  }
  return entries.sort((a, b) => a.y - b.y).slice(0, MAX_CARDS);
}

function render() {
  if (locked) {
    return;
  }
  const visible = visibleEntries();
  const wanted = new Set(visible.map(entry => entry.shot.shotId));
  for (const [id, card] of cards) {
    if (!wanted.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
  queue = queue.filter(item => wanted.has(item.id));
  for (const entry of visible) {
    const { shot } = entry;
    let card = cards.get(shot.shotId);
    if (!card) {
      card = document.createElement("article");
      card.className = "shot";
      card.setAttribute("role", "listitem");
      card.dataset.id = shot.shotId;
      const preview = document.createElement("button");
      preview.className = "preview";
      preview.setAttribute("aria-label", `View ${shot.title || "screenshot"}`);
      const image = document.createElement("img");
      image.alt = "";
      const caption = document.createElement("span");
      caption.className = "caption";
      caption.textContent = shot.title || shot.origin || "Screenshot";
      preview.append(image, caption);
      preview.addEventListener("click", () => showViewer(shot.shotId));
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "pick";
      checkbox.setAttribute(
        "aria-label",
        `Select ${shot.title || "screenshot"}`
      );
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selected.add(shot.shotId);
        } else {
          selected.delete(shot.shotId);
        }
        updateSelection();
      });
      card.append(preview, checkbox);
      cards.set(shot.shotId, card);
      $("masonry").appendChild(card);
    }
    card.style.transform = `translate(${entry.x}px, ${entry.y}px)`;
    card.style.width = `${entry.width}px`;
    card.style.height = `${entry.height}px`;
    card.classList.toggle("selected", selected.has(shot.shotId));
    card.querySelector(".pick").checked = selected.has(shot.shotId);
    const cached = urls.get(shot.shotId);
    if (cached) {
      // Touch the LRU without allocating a new image or decoding it again.
      urls.delete(shot.shotId);
      urls.set(shot.shotId, cached);
      const image = card.querySelector("img");
      if (image.getAttribute("src") !== cached.url) {
        image.src = cached.url;
      }
    } else if (
      !pending.has(shot.shotId) &&
      !queue.some(item => item.id === shot.shotId)
    ) {
      queue.push({ id: shot.shotId, version: generation });
    }
  }
  trimCache();
  drain();
}

function trimCache() {
  for (const [id, cached] of urls) {
    if (urls.size <= MAX_URLS && cacheBytes <= MAX_CACHE_BYTES) {
      break;
    }
    URL.revokeObjectURL(cached.url);
    cacheBytes -= cached.bytes;
    urls.delete(id);
    cards.get(id)?.querySelector("img").removeAttribute("src");
  }
}

function drain() {
  while (!locked && active < MAX_DECRYPTS && queue.length) {
    const { id, version } = queue.shift();
    if (!cards.has(id) || version !== generation) {
      continue;
    }
    active++;
    pending.add(id);
    loadThumbnail(id, version).finally(() => {
      active--;
      if (version === generation) {
        pending.delete(id);
      }
      drain();
    });
  }
}

async function loadThumbnail(id, version) {
  let url;
  try {
    const bytes = await command("bytes", { id, kind: "thumb" });
    if (locked || version !== generation || !cards.has(id)) {
      return;
    }
    url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    decodingURLs.add(url);
    const image = cards.get(id).querySelector("img");
    image.src = url;
    await image.decode();
    decodingURLs.delete(url);
    if (locked || version !== generation || !cards.has(id)) {
      URL.revokeObjectURL(url);
      return;
    }
    urls.set(id, { url, bytes: bytes.byteLength });
    cacheBytes += bytes.byteLength;
    trimCache();
  } catch {
    if (url) {
      decodingURLs.delete(url);
      URL.revokeObjectURL(url);
    }
    if (!locked && version === generation) {
      cards.get(id)?.querySelector("img").removeAttribute("src");
      report("A screenshot preview could not be decrypted or decoded.");
    }
  }
}

function updateSelection() {
  $("selected-count").textContent = `${selected.size} selected`;
  for (const id of [
    "apply-tags",
    "move-folder",
    "export",
    "delete",
    "select-none",
  ]) {
    $(id).disabled = !selected.size;
  }
  $("select-all").disabled = loading || !shots.length;
  for (const [id, card] of cards) {
    card.classList.toggle("selected", selected.has(id));
    card.querySelector(".pick").checked = selected.has(id);
  }
}

function metadataValue(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return typeof value === "object"
    ? JSON.stringify(value, null, 2)
    : String(value);
}

async function showViewer(id) {
  const shot = shots.find(item => item.shotId === id);
  if (locked || !shot) {
    return;
  }
  closeViewer();
  viewerId = id;
  const version = viewerVersion;
  const epoch = generation;
  $("viewer-title").textContent = shot.title || "Screenshot";
  $("note").value = shot.note || "";
  $("full-image").alt = shot.title || "Screenshot";
  $("open-source").disabled = !shot.url;
  $("copy-link").disabled = !shot.url;
  // Sharing goes through Ombra (B2): disabled, with the reason, while Ombra cannot share.
  $("share-team").disabled = true;
  $("share-team-reason").textContent = "";
  command("teamState")
    .then(team => {
      if (viewerId === id) {
        $("share-team").disabled = !team.ready;
        $("share-team-reason").textContent = team.ready ? "" : team.text;
      }
    })
    .catch(() => {});
  for (const [key, value] of Object.entries(shot)) {
    const term = document.createElement("dt");
    term.textContent = key;
    const description = document.createElement("dd");
    description.textContent =
      key === "createdAt"
        ? new Date(value).toLocaleString()
        : metadataValue(value);
    $("metadata").append(term, description);
  }
  for (const color of shot.colors || []) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
      continue;
    }
    const button = document.createElement("button");
    button.style.backgroundColor = color;
    button.title = `Filter by ${color}`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => {
      $("color").value = color;
      closeViewer();
      reload();
    });
    $("palette").appendChild(button);
  }
  $("viewer").showModal();
  viewerRequest = { id, version, epoch };
  loadViewerImage();
}

async function loadViewerImage() {
  if (viewerLoading || !viewerRequest || locked) {
    return;
  }
  const { id, version, epoch } = viewerRequest;
  viewerRequest = null;
  viewerLoading = true;
  const bytes = await perform("bytes", { id, kind: "image" });
  if (bytes && !locked && version === viewerVersion && epoch === generation) {
    viewerURL = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    $("full-image").src = viewerURL;
  }
  viewerLoading = false;
  if (viewerRequest) {
    loadViewerImage();
  }
}

function adjacentViewer(direction) {
  const index = shots.findIndex(shot => shot.shotId === viewerId);
  const shot = shots[index + direction];
  if (shot) {
    showViewer(shot.shotId);
  }
}

let lastActivity = 0;
for (const type of ["pointerdown", "pointermove", "keydown", "wheel"]) {
  document.addEventListener(
    type,
    event => {
      const now = Date.now();
      if (event.isTrusted && !locked && now - lastActivity >= 30000) {
        lastActivity = now;
        // User input, never an interval, extends the store's inactivity window.
        // A simultaneous lock is expected to reject this non-mutating request.
        command("activity").catch(() => {});
      }
    },
    { passive: true }
  );
}

$("unlock").addEventListener("click", async () => {
  $("unlock").disabled = true;
  await perform("unlock");
  $("unlock").disabled = false;
});
$("lock").addEventListener("click", async () => {
  // Hide memory-backed UI immediately, including while a store write settles.
  lockView();
  await perform("lock");
});
$("filters").addEventListener("submit", event => event.preventDefault());
$("filters").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if ($("filters").checkValidity()) {
      $("viewport").scrollTop = 0;
      reload();
    }
  }, 180);
});
$("filters").addEventListener("reset", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!locked) {
      reload();
    }
  }, 0);
});
$("viewport").addEventListener("scroll", scheduleRender, { passive: true });
const resizeObserver = new ResizeObserver(() => {
  if (!locked) {
    layout();
  }
});
resizeObserver.observe($("viewport"));
$("select-all").addEventListener("click", () => {
  selected = new Set(shots.map(shot => shot.shotId));
  updateSelection();
});
$("select-none").addEventListener("click", () => {
  selected.clear();
  updateSelection();
});
$("apply-tags").addEventListener("click", () =>
  perform("update", {
    ids: [...selected],
    patch: {
      tags: $("bulk-tags")
        .value.split(",")
        .map(tag => tag.trim())
        .filter(Boolean),
    },
  })
);
$("move-folder").addEventListener("click", () =>
  perform("update", {
    ids: [...selected],
    patch: { folderId: $("bulk-folder").value || null },
  })
);
$("delete").addEventListener("click", () =>
  perform("remove", { ids: [...selected] })
);
$("export").addEventListener("click", async () => {
  const count = await perform("export", { ids: [...selected] });
  if (!locked && count) {
    report(`Exported ${count} unencrypted screenshots and metadata files.`);
  }
});
for (const button of document.querySelectorAll("[data-capture]")) {
  button.addEventListener("click", () =>
    perform("capture", { mode: button.dataset.capture })
  );
}
$("settings-toggle").addEventListener("click", () => {
  $("settings").hidden = !$("settings").hidden;
  $("settings-toggle").setAttribute(
    "aria-expanded",
    String(!$("settings").hidden)
  );
});
$("save-settings").addEventListener("click", () => {
  if ($("idle-minutes").checkValidity() && $("idle-minutes").value !== "") {
    perform("setSettings", {
      autoTags: $("auto-tags").checked,
      idleMinutes: Number($("idle-minutes").value),
    });
  }
});
$("choose-folder").addEventListener("click", async () => {
  await perform("chooseWatchFolder");
  if (!locked) {
    loadSettings(generation).catch(() =>
      report("Settings could not be loaded.")
    );
  }
});
$("watch-enabled").addEventListener("change", async () => {
  await perform(
    $("watch-enabled").checked ? "chooseWatchFolder" : "disableWatchFolder"
  );
  if (!locked) {
    loadSettings(generation).catch(() =>
      report("Settings could not be loaded.")
    );
  }
});
$("create-folder").addEventListener("click", async () => {
  const folderName = $("folder-name").value.trim();
  if (folderName && (await perform("createFolder", { name: folderName }))) {
    $("folder-name").value = "";
  }
});
$("close-viewer").addEventListener("click", closeViewer);
$("viewer").addEventListener("cancel", closeViewer);
$("previous").addEventListener("click", () => adjacentViewer(-1));
$("next").addEventListener("click", () => adjacentViewer(1));
$("open-source").addEventListener("click", () =>
  perform("open", { id: viewerId })
);
$("copy-image").addEventListener("click", () =>
  perform("copyImage", { id: viewerId })
);
$("copy-link").addEventListener("click", () =>
  perform("copyLink", { id: viewerId })
);
$("share-team").addEventListener("click", async () => {
  const sent = await perform("shareTeam", { id: viewerId });
  if (!locked && sent) {
    report(`Shared the screenshot with ${sent} team member${sent === 1 ? "" : "s"}.`);
  }
});
$("save-note").addEventListener("click", () =>
  perform("update", { ids: [viewerId], patch: { note: $("note").value } })
);
const stopObserving = GalleryCommands.observe(window, state => {
  if (state === "locked") {
    lockView();
  } else if (state === "unlocked") {
    locked = false;
    $("locked-screen").hidden = true;
    $("gallery").hidden = false;
    $("lock").hidden = false;
    reload();
  } else if (state === "changed" && !locked) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(reload, 50);
  }
});
window.addEventListener(
  "pagehide",
  () => {
    stopObserving();
    resizeObserver.disconnect();
    cancelAnimationFrame(frame);
    lockView();
  },
  { once: true }
);
const state = await command("state");
if (state.locked) {
  lockView();
} else {
  locked = false;
  $("locked-screen").hidden = true;
  $("gallery").hidden = false;
  $("lock").hidden = false;
  reload();
}
