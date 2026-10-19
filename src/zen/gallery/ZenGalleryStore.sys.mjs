/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Sqlite } from "resource://gre/modules/Sqlite.sys.mjs";
import { OSKeyStore } from "resource://gre/modules/OSKeyStore.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const FORMAT = 1;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_RECORDS = 20000;
const ID = /^[a-f0-9]{32}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const defaults = () => ({ autoTags: false, watchFolder: "", idleMinutes: 0 });
const randomId = () =>
  Services.uuid.generateUUID().toString().replace(/[{}-]/g, "");
const fail = () => {
  throw new Error("Gallery data is invalid");
};
const text = (value, max = 2048) => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    fail();
  }
  return value;
};
const finite = (value, max = 1e8) => {
  if (!Number.isFinite(value) || Math.abs(value) > max) {
    fail();
  }
  return value;
};
export function galleryURL(value) {
  if (!value) {
    return "";
  }
  const url = new URL(text(value, 8192));
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    fail();
  }
  return url.href;
}
function tags(value = []) {
  if (!Array.isArray(value) || value.length > 64) {
    fail();
  }
  return [
    ...new Set(value.map(item => text(item, 128).trim()).filter(Boolean)),
  ];
}
function ids(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_RECORDS ||
    value.some(id => !ID.test(id))
  ) {
    fail();
  }
  return [...new Set(value)];
}
function pngSize(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 33 ||
    bytes.length > MAX_BYTES
  ) {
    fail();
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    signature.some((v, i) => bytes[i] !== v) ||
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  ) {
    fail();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) {
    fail();
  }
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (
    !width ||
    !height ||
    width > 32767 ||
    height > 32767 ||
    width * height > MAX_PIXELS
  ) {
    fail();
  }
  return { width, height };
}
function metadata(input, id, size, bytes, sha256, colors) {
  if (
    !input ||
    typeof input !== "object" ||
    !["area", "visible", "full", "element", "system", "drop"].includes(
      input.source
    )
  ) {
    fail();
  }
  const url = galleryURL(input.url);
  const pair = (value, a, b, max) => ({
    [a]: finite(value?.[a] ?? 0, max),
    [b]: finite(value?.[b] ?? 0, max),
  });
  const viewport = pair(input.viewport, "w", "h", 1e6);
  viewport.dpr = finite(input.viewport?.dpr ?? 1, 100);
  const pageMeta = {};
  for (const name of ["ogTitle", "description", "author", "publishedAt"]) {
    pageMeta[name] = text(input.pageMeta?.[name]);
  }
  pageMeta.ogImage = galleryURL(input.pageMeta?.ogImage);
  const createdAt = input.createdAt ?? Date.now();
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    createdAt > Date.now() + 60000
  ) {
    fail();
  }
  if (input.folderId && !ID.test(input.folderId)) {
    fail();
  }
  return {
    shotId: id,
    createdAt,
    source: input.source,
    url,
    origin: url ? new URL(url).origin : "",
    title: text(input.title),
    favicon: galleryURL(input.favicon),
    viewport,
    scroll: pair(input.scroll, "x", "y", 1e8),
    selector: text(input.selector),
    selectionText: text(input.selectionText, 8192),
    pageMeta,
    colors,
    tags: tags(input.tags),
    folderId: input.folderId || "",
    note: text(input.note, 8192),
    ...size,
    bytes,
    sha256,
  };
}
async function raster(bytes) {
  const dimensions = pngSize(bytes);
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
  const bitmap = await window.createImageBitmap(
    new Blob([bytes], { type: "image/png" })
  );
  try {
    if (
      bitmap.width !== dimensions.width ||
      bitmap.height !== dimensions.height
    ) {
      fail();
    }
    // Re-encode: neither imported ancillary PNG chunks nor animation are retained.
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const image = new Uint8Array(
      await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()
    );
    if (image.length > MAX_BYTES) {
      fail();
    }
    const scale = Math.min(1, 320 / bitmap.width, 320 / bitmap.height);
    const thumbCanvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale))
    );
    const ctx = thumbCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const pixels = ctx.getImageData(
      0,
      0,
      thumbCanvas.width,
      thumbCanvas.height
    ).data;
    const buckets = new Map();
    for (let i = 0; i < pixels.length; i += 16) {
      if (pixels[i + 3] < 128) {
        continue;
      }
      const key =
        ((pixels[i] >> 4) << 8) |
        ((pixels[i + 1] >> 4) << 4) |
        (pixels[i + 2] >> 4);
      const bucket = buckets.get(key) || [0, 0, 0, 0];
      bucket[0]++;
      bucket[1] += pixels[i];
      bucket[2] += pixels[i + 1];
      bucket[3] += pixels[i + 2];
      buckets.set(key, bucket);
    }
    const colors = [...buckets.values()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, 5)
      .map(
        b =>
          "#" +
          b
            .slice(1)
            .map(v =>
              Math.round(v / b[0])
                .toString(16)
                .padStart(2, "0")
            )
            .join("")
      );
    while (colors.length < 5) {
      colors.push(colors.at(-1) || "#000000");
    }
    const thumb = new Uint8Array(
      await (
        await thumbCanvas.convertToBlob({ type: "image/png" })
      ).arrayBuffer()
    );
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", image));
    return {
      image,
      thumb,
      colors,
      dimensions,
      hash: Array.from(hash, b => b.toString(16).padStart(2, "0")).join(""),
    };
  } finally {
    bitmap.close();
  }
}
function searchText(shot) {
  return [
    shot.title,
    shot.url,
    shot.origin,
    shot.note,
    shot.selectionText,
    ...shot.tags,
  ]
    .join("\n")
    .normalize("NFKC")
    .toLocaleLowerCase();
}

// SQLite stores random identifiers and authenticated envelopes only. Schema,
// counts, ciphertext lengths and filesystem timing remain observable; this is
// deliberately not SQLCipher/full-file encryption.
export class GalleryStore {
  #root;
  #db = null;
  #key = null;
  #epoch = 0;
  #queue = Promise.resolve();
  #records = new Map();
  #search = new Map();
  #configId = null;
  #config = null;
  #timer = null;
  #unlockPromise = null;
  constructor(root = PathUtils.join(PathUtils.profileDir, "zen-gallery")) {
    this.#root = root;
  }
  get locked() {
    return !this.#key;
  }
  activity() {
    this.#assert();
    this.#touch();
  }
  #notify(state) {
    Services.obs.notifyObservers(null, "zen-gallery-state", state);
  }
  #assert(epoch = this.#epoch) {
    if (!this.#key || epoch !== this.#epoch) {
      throw new Error("Gallery is locked");
    }
  }
  #touch() {
    clearTimeout(this.#timer);
    if (this.#config?.settings.idleMinutes) {
      this.#timer = setTimeout(
        () => this.lock(),
        this.#config.settings.idleMinutes * 60000
      );
    }
  }
  #run(fn) {
    const epoch = this.#epoch;
    const result = this.#queue.then(() => {
      this.#assert(epoch);
      this.#touch();
      return fn(epoch);
    });
    this.#queue = result.catch(() => {});
    return result;
  }
  lock() {
    ++this.#epoch;
    this.#key = null;
    this.#records.clear();
    this.#search.clear();
    this.#config = null;
    this.#configId = null;
    clearTimeout(this.#timer);
    this.#notify("locked");
  }
  async close() {
    this.lock();
    await this.#queue;
    if (this.#db) {
      await this.#db.close();
      this.#db = null;
    }
  }
  async #seal(id, kind, data, key = this.#key) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: encoder.encode(`zen-gallery:${FORMAT}:${id}:${kind}`),
          tagLength: 128,
        },
        key,
        data
      )
    );
    const envelope = new Uint8Array(1 + 12 + ciphertext.length);
    envelope[0] = FORMAT;
    envelope.set(nonce, 1);
    envelope.set(ciphertext, 13);
    return envelope;
  }
  async #open(id, kind, envelope, key = this.#key) {
    envelope = new Uint8Array(envelope);
    if (
      envelope.length < 29 ||
      envelope[0] !== FORMAT ||
      envelope.length > MAX_BYTES + 29
    ) {
      fail();
    }
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: envelope.subarray(1, 13),
          additionalData: encoder.encode(`zen-gallery:${FORMAT}:${id}:${kind}`),
          tagLength: 128,
        },
        key,
        envelope.subarray(13)
      )
    );
  }
  unlock() {
    if (!this.locked) {
      this.#touch();
      return Promise.resolve();
    }
    if (this.#unlockPromise) {
      return this.#unlockPromise;
    }
    this.#unlockPromise = this.#queue
      .then(() => this.#unlock())
      .finally(() => {
        this.#unlockPromise = null;
      });
    this.#queue = this.#unlockPromise.catch(() => {});
    return this.#unlockPromise;
  }
  // eslint-disable-next-line complexity
  async #unlock() {
    const epoch = this.#epoch;
    const native = Cc["@mozilla.org/security/oskeystore;1"].getService(
      Ci.nsIOSKeyStore
    );
    // Undefined on a non-upgraded runtime also fails closed. Linux NSS fallback
    // is not a system key store, even though the upstream wrapper accepts it.
    if (native.usesOSBackend !== true) {
      throw new Error("A secure system key store is unavailable");
    }
    const keyPath = PathUtils.join(this.#root, "key");
    const existing = await IOUtils.exists(keyPath);
    let raw;
    try {
      if (existing) {
        if (!(await native.asyncSecretAvailable(OSKeyStore.STORE_LABEL))) {
          throw new Error("Gallery system key is missing");
        }
        if ((await IOUtils.stat(keyPath)).size > 16384) {
          fail();
        }
        const wrapped = await IOUtils.readUTF8(keyPath);
        if (wrapped.length > 16384) {
          fail();
        }
        const encoded = await OSKeyStore.decrypt(
          wrapped,
          "gallery",
          OSKeyStore.canReauth() ? "Unlock encrypted screenshot gallery" : false
        );
        if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
          fail();
        }
        raw = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      } else {
        // Never overwrite a missing key for a populated/corrupt gallery.
        if (
          (await IOUtils.exists(this.#root)) &&
          (await IOUtils.getChildren(this.#root)).length
        ) {
          throw new Error("Gallery key is missing");
        }
        const auth = await OSKeyStore.ensureLoggedIn(
          OSKeyStore.canReauth() ? "Create encrypted screenshot gallery" : false
        );
        if (!auth.authenticated) {
          throw new Error("Gallery unlock was cancelled");
        }
        raw = crypto.getRandomValues(new Uint8Array(32));
        const wrapped = await OSKeyStore.encrypt(
          btoa(String.fromCharCode(...raw))
        );
        if (epoch !== this.#epoch) {
          throw new Error("Gallery is locked");
        }
        await IOUtils.makeDirectory(this.#root, { permissions: 0o700 });
        await IOUtils.writeUTF8(keyPath, wrapped, {
          tmpPath: keyPath + ".tmp",
          flush: true,
        });
      }
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
      raw.fill(0);
      raw = null;
      if (!this.#db) {
        this.#db = await Sqlite.openConnection({
          path: PathUtils.join(this.#root, "index.sqlite"),
        });
        await this.#db.execute("PRAGMA temp_store=MEMORY");
        await this.#db.execute("PRAGMA journal_mode=WAL");
        await this.#db.execute(
          "CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL, thumb BLOB)"
        );
      }
      await IOUtils.makeDirectory(PathUtils.join(this.#root, "objects"), {
        permissions: 0o700,
      });
      const count = await this.#db.execute(
        "SELECT count(*) AS total, max(length(payload)) AS largest, sum(length(payload)) AS bytes FROM records"
      );
      if (
        count[0].getResultByName("total") > MAX_RECORDS + 1001 ||
        count[0].getResultByName("largest") > 2 * 1024 * 1024 ||
        count[0].getResultByName("bytes") > 256 * 1024 * 1024
      ) {
        fail();
      }
      const rows = await this.#db.execute("SELECT id, payload FROM records");
      const records = new Map(),
        search = new Map();
      let config = null,
        configId = null;
      for (let offset = 0; offset < rows.length; offset += 16) {
        const batch = await Promise.all(
          rows.slice(offset, offset + 16).map(async row => {
            const id = row.getResultByName("id");
            if (!ID.test(id)) {
              fail();
            }
            const payload = row.getResultByName("payload");
            if (payload.length > 2 * 1024 * 1024) {
              fail();
            }
            const record = JSON.parse(
              decoder.decode(await this.#open(id, "metadata", payload, key))
            );
            if (!["shot", "folder", "config"].includes(record.type)) {
              fail();
            }
            return [id, record];
          })
        );
        for (const [id, record] of batch) {
          if (record.type === "config") {
            if (config) {
              fail();
            }
            config = record;
            configId = id;
          } else {
            records.set(id, record);
            if (record.type === "shot") {
              if (record.value.shotId !== id) {
                fail();
              }
              search.set(id, searchText(record.value));
            }
          }
        }
        if (epoch !== this.#epoch) {
          throw new Error("Gallery is locked");
        }
      }
      if (!config) {
        configId = randomId();
        config = { type: "config", settings: defaults(), watchState: null };
        const payload = await this.#seal(
          configId,
          "metadata",
          encoder.encode(JSON.stringify(config)),
          key
        );
        if (epoch !== this.#epoch) {
          throw new Error("Gallery is locked");
        }
        await this.#db.execute(
          "INSERT INTO records (id,payload) VALUES (:id,:payload)",
          { id: configId, payload }
        );
      }
      if (epoch !== this.#epoch) {
        throw new Error("Gallery is locked");
      }
      // Crash cleanup touches ciphertext only, and never follows untrusted names.
      for (const path of await IOUtils.getChildren(
        PathUtils.join(this.#root, "objects")
      )) {
        const name = PathUtils.filename(path);
        if (
          (ID.test(name) && records.get(name)?.type !== "shot") ||
          /^[a-f0-9]{32}\.tmp$/.test(name)
        ) {
          await IOUtils.remove(path);
        }
      }
      if (epoch !== this.#epoch) {
        throw new Error("Gallery is locked");
      }
      this.#key = key;
      this.#records = records;
      this.#search = search;
      this.#config = config;
      this.#configId = configId;
      this.#touch();
      this.#notify("unlocked");
    } catch (error) {
      raw?.fill(0);
      this.lock();
      // No plaintext record/path/crypto exception is written to logs or UI.
      throw new Error(
        "Gallery cannot unlock. Check the system key store and gallery integrity."
      );
    }
  }
  async add(bytes, input) {
    this.#assert();
    return this.#run(async epoch => {
      if (this.#search.size >= MAX_RECORDS) {
        throw new Error("Gallery capacity reached");
      }
      const data = await raster(bytes);
      this.#assert(epoch);
      const id = randomId();
      const shot = metadata(
        input,
        id,
        data.dimensions,
        data.image.length,
        data.hash,
        data.colors
      );
      if (
        shot.folderId &&
        this.#records.get(shot.folderId)?.type !== "folder"
      ) {
        fail();
      }
      if (this.#config.settings.autoTags && shot.url) {
        const domain = new URL(shot.url).hostname;
        const pageType =
          shot.pageMeta.publishedAt || shot.pageMeta.author
            ? "article"
            : "page";
        shot.tags = tags([...shot.tags.slice(0, 62), domain, pageType]);
      }
      const record = { type: "shot", value: shot };
      const [image, payload, thumb] = await Promise.all([
        this.#seal(id, "image", data.image),
        this.#seal(id, "metadata", encoder.encode(JSON.stringify(record))),
        this.#seal(id, "thumb", data.thumb),
      ]);
      this.#assert(epoch);
      const path = PathUtils.join(this.#root, "objects", id);
      await IOUtils.write(path, image, { tmpPath: path + ".tmp", flush: true });
      try {
        await this.#db.executeTransaction(async () => {
          this.#assert(epoch);
          await this.#db.execute(
            "INSERT INTO records (id,payload,thumb) VALUES (:id,:payload,:thumb)",
            { id, payload, thumb }
          );
          this.#assert(epoch);
        });
      } catch (error) {
        await IOUtils.remove(path, { ignoreAbsent: true });
        throw error;
      }
      this.#assert(epoch);
      this.#records.set(id, record);
      this.#search.set(id, searchText(shot));
      this.#notify("changed");
      return id;
    });
  }
  query(filter = {}) {
    this.#assert();
    this.#touch();
    const needle = text(filter.text, 512).normalize("NFKC").toLocaleLowerCase();
    const tag = text(filter.tag, 128),
      site = text(filter.site, 8192).toLocaleLowerCase();
    const folder = text(filter.folderId, 32),
      color = text(filter.color, 7).toLowerCase();
    if (
      (folder && !ID.test(folder)) ||
      (color && !/^#[a-f0-9]{6}$/.test(color))
    ) {
      fail();
    }
    const offset = filter.offset ?? 0,
      limit = filter.limit ?? 200;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > 500
    ) {
      fail();
    }
    const from = filter.from ? new Date(filter.from).getTime() : 0;
    const to = filter.to ? new Date(filter.to).getTime() : Infinity;
    if (!Number.isFinite(from) || Number.isNaN(to)) {
      fail();
    }
    const result = [];
    for (const [id, haystack] of this.#search) {
      const shot = this.#records.get(id).value;
      if (
        (needle && !haystack.includes(needle)) ||
        (tag && !shot.tags.includes(tag)) ||
        (folder && shot.folderId !== folder) ||
        (site && !shot.origin.toLocaleLowerCase().includes(site)) ||
        shot.createdAt < from ||
        shot.createdAt > to
      ) {
        continue;
      }
      if (
        color &&
        !shot.colors.some(c => {
          const channels = [1, 3, 5];
          return (
            channels.reduce(
              (sum, p) =>
                sum +
                (parseInt(c.slice(p, p + 2), 16) -
                  parseInt(color.slice(p, p + 2), 16)) **
                  2,
              0
            ) <= 6400
          );
        })
      ) {
        continue;
      }
      result.push(shot);
    }
    result.sort(
      (a, b) => b.createdAt - a.createdAt || a.shotId.localeCompare(b.shotId)
    );
    return {
      total: result.length,
      items: structuredClone(result.slice(offset, offset + limit)),
    };
  }
  bytes(id, kind = "image") {
    if (!ID.test(id) || !["image", "thumb"].includes(kind)) {
      fail();
    }
    return this.#run(async epoch => {
      if (this.#records.get(id)?.type !== "shot") {
        fail();
      }
      let encrypted;
      if (kind === "image") {
        const path = PathUtils.join(this.#root, "objects", id);
        if ((await IOUtils.stat(path)).size > MAX_BYTES + 29) {
          fail();
        }
        encrypted = await IOUtils.read(path);
      } else {
        const rows = await this.#db.execute(
          "SELECT thumb FROM records WHERE id=:id",
          { id }
        );
        encrypted = rows[0]?.getResultByName("thumb");
        if (!encrypted || encrypted.length > 1024 * 1024) {
          fail();
        }
      }
      const bytes = await this.#open(id, kind, encrypted);
      this.#assert(epoch);
      return bytes;
    });
  }
  update(selected, patch) {
    selected = ids(selected);
    if (
      !patch ||
      Object.keys(patch).some(
        key => !["tags", "folderId", "note"].includes(key)
      )
    ) {
      fail();
    }
    const clean = {};
    if ("tags" in patch) {
      clean.tags = tags(patch.tags);
    }
    if ("folderId" in patch) {
      clean.folderId = text(patch.folderId, 32);
      if (clean.folderId && !ID.test(clean.folderId)) {
        fail();
      }
    }
    if ("note" in patch) {
      clean.note = text(patch.note, 8192);
    }
    return this.#run(async epoch => {
      if (
        clean.folderId &&
        this.#records.get(clean.folderId)?.type !== "folder"
      ) {
        fail();
      }
      const replacements = [];
      for (const id of selected) {
        const old = this.#records.get(id);
        if (old?.type !== "shot") {
          fail();
        }
        const record = { type: "shot", value: { ...old.value, ...clean } };
        replacements.push({
          id,
          record,
          payload: await this.#seal(
            id,
            "metadata",
            encoder.encode(JSON.stringify(record))
          ),
        });
      }
      await this.#db.executeTransaction(async () => {
        this.#assert(epoch);
        for (const { id, payload } of replacements) {
          await this.#db.execute(
            "UPDATE records SET payload=:payload WHERE id=:id",
            { id, payload }
          );
        }
        this.#assert(epoch);
      });
      this.#assert(epoch);
      for (const { id, record } of replacements) {
        this.#records.set(id, record);
        this.#search.set(id, searchText(record.value));
      }
      this.#notify("changed");
    });
  }
  remove(selected) {
    selected = ids(selected);
    return this.#run(async epoch => {
      if (selected.some(id => this.#records.get(id)?.type !== "shot")) {
        fail();
      }
      await this.#db.executeTransaction(async () => {
        this.#assert(epoch);
        for (const id of selected) {
          await this.#db.execute("DELETE FROM records WHERE id=:id", { id });
        }
        this.#assert(epoch);
      });
      this.#assert(epoch);
      for (const id of selected) {
        this.#records.delete(id);
        this.#search.delete(id);
      }
      this.#notify("changed");
      // A failed unlink leaves only orphan ciphertext, collected on next unlock.
      for (const id of selected) {
        await IOUtils.remove(PathUtils.join(this.#root, "objects", id), {
          ignoreAbsent: true,
        });
      }
    });
  }
  async folders() {
    this.#assert();
    return [...this.#records]
      .filter(([, record]) => record.type === "folder")
      .map(([id, record]) => ({ id, name: record.name }));
  }
  createFolder(name) {
    name = text(name, 128).trim();
    if (!name) {
      fail();
    }
    return this.#run(async epoch => {
      if (
        [...this.#records.values()].filter(r => r.type === "folder").length >=
        1000
      ) {
        fail();
      }
      const id = randomId(),
        record = { type: "folder", name };
      const payload = await this.#seal(
        id,
        "metadata",
        encoder.encode(JSON.stringify(record))
      );
      await this.#db.executeTransaction(async () => {
        this.#assert(epoch);
        await this.#db.execute(
          "INSERT INTO records (id,payload) VALUES (:id,:payload)",
          { id, payload }
        );
        this.#assert(epoch);
      });
      this.#assert(epoch);
      this.#records.set(id, record);
      this.#notify("changed");
      return id;
    });
  }
  async settings() {
    this.#assert();
    return structuredClone(this.#config.settings);
  }
  async getWatchState() {
    this.#assert();
    return structuredClone(this.#config.watchState);
  }
  setSettings(patch) {
    if (
      !patch ||
      Object.keys(patch).some(
        key => !["autoTags", "watchFolder", "idleMinutes"].includes(key)
      )
    ) {
      fail();
    }
    if ("autoTags" in patch && typeof patch.autoTags !== "boolean") {
      fail();
    }
    if (
      "idleMinutes" in patch &&
      (!Number.isInteger(patch.idleMinutes) ||
        patch.idleMinutes < 0 ||
        patch.idleMinutes > 1440)
    ) {
      fail();
    }
    if ("watchFolder" in patch) {
      text(patch.watchFolder, 4096);
      if (patch.watchFolder && !PathUtils.isAbsolute(patch.watchFolder)) {
        fail();
      }
    }
    const clean = structuredClone(patch);
    return this.#run(epoch =>
      this.#saveConfig(
        { ...this.#config, settings: { ...this.#config.settings, ...clean } },
        epoch
      )
    );
  }
  setWatchState(state) {
    if (state !== null) {
      if (
        !state ||
        typeof state.initialized !== "boolean" ||
        !Array.isArray(state.files) ||
        state.files.length > 5000
      ) {
        fail();
      }
      text(state.folder, 4096);
      state = {
        folder: state.folder,
        initialized: state.initialized,
        files: state.files.map(file => ({
          name: text(file.name, 255),
          size: finite(file.size, MAX_BYTES),
          mtime: finite(file.mtime, 1e15),
        })),
      };
    }
    return this.#run(epoch =>
      this.#saveConfig({ ...this.#config, watchState: state }, epoch)
    );
  }
  async #saveConfig(config, epoch) {
    const bytes = encoder.encode(JSON.stringify(config));
    if (bytes.length > 2 * 1024 * 1024 - 29) {
      fail();
    }
    const payload = await this.#seal(this.#configId, "metadata", bytes);
    await this.#db.executeTransaction(async () => {
      this.#assert(epoch);
      await this.#db.execute(
        "UPDATE records SET payload=:payload WHERE id=:id",
        { id: this.#configId, payload }
      );
      this.#assert(epoch);
    });
    this.#assert(epoch);
    this.#config = config;
    this.#touch();
    this.#notify("changed");
  }
}
export const ZenGalleryStore = new GalleryStore();
