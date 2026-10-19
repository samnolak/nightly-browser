/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

const { GalleryStore } = ChromeUtils.importESModule(
  "resource:///modules/ZenGalleryStore.sys.mjs"
);
const { Sqlite } = ChromeUtils.importESModule(
  "resource://gre/modules/Sqlite.sys.mjs"
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs"
);
const { OSKeyStore } = ChromeUtils.importESModule(
  "resource://gre/modules/OSKeyStore.sys.mjs"
);

add_task(async function authenticated_storage_and_lock_boundaries() {
  const native = Cc["@mozilla.org/security/oskeystore;1"].getService(
    Ci.nsIOSKeyStore
  );
  is(
    typeof native.usesOSBackend,
    "boolean",
    "Native backend capability is available"
  );
  const root = PathUtils.join(
    PathUtils.profileDir,
    "gallery-security-" + Services.uuid.generateUUID().toString()
  );
  let store = new GalleryStore(root);
  if (!native.usesOSBackend) {
    await Assert.rejects(
      store.unlock(),
      /secure system key store/,
      "NSS/unknown backend is not accepted as an OS key store"
    );
    ok(
      !(await IOUtils.exists(root)),
      "Unsupported backend does not stage or initialize data"
    );
    return;
  }
  // OSKeyStore only honors its test-only reauth pref on the "default" update
  // channel. Packaged dev builds report "release", so emulate a local build by
  // overriding the default-branch channel for this test only; production code
  // and prefs are untouched and the real macOS keychain still wraps the key.
  const defaults = Services.prefs.getDefaultBranch(null);
  const wasLocked = Services.prefs.prefIsLocked("app.update.channel");
  const originalChannel = defaults.getCharPref("app.update.channel", "");
  Services.prefs.unlockPref("app.update.channel");
  defaults.setCharPref("app.update.channel", "default");
  registerCleanupFunction(() => {
    defaults.setCharPref("app.update.channel", originalChannel);
    if (wasLocked) {
      Services.prefs.lockPref("app.update.channel");
    }
  });
  if (!OSKeyStoreTestUtils.canTestOSKeyStoreLogin()) {
    ok(
      false,
      "Test-only OSKeyStore login must be available; refusing to open a real OS dialog"
    );
    return;
  }
  OSKeyStoreTestUtils.setup();
  await SpecialPowers.pushPrefEnv({
    set: [[OSKeyStoreTestUtils.TEST_ONLY_REAUTH, "pass"]],
  });
  try {
    const sentinel = "gallery-private-sentinel-6c91b4";
    const canvas = new OffscreenCanvas(24, 16);
    canvas.getContext("2d").fillRect(0, 0, 24, 16);
    // Production callers live in the shared system-module global; clone so the
    // store's same-realm Uint8Array check sees a native buffer, not a wrapper.
    const png = Cu.cloneInto(
      new Uint8Array(
        await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()
      ),
      Cu.getGlobalForObject(GalleryStore)
    );
    const metadata = {
      source: "area",
      title: sentinel,
      url: `https://${sentinel}.example/path`,
      tags: [sentinel],
      note: sentinel,
      selectionText: sentinel,
    };
    await Assert.rejects(
      store.add(png, metadata),
      /locked/,
      "Captures cannot silently initialize a locked gallery"
    );
    await store.unlock();
    const folderId = await store.createFolder(sentinel);
    const first = await store.add(png, { ...metadata, folderId });
    const second = await store.add(png, { ...metadata, title: "second" });
    is(
      store.query({ text: sentinel }).total,
      2,
      "RAM search indexes encrypted metadata"
    );
    is(store.query({ tag: sentinel }).total, 2, "Tag search works");
    is(
      store.query({ site: `${sentinel}.example` }).total,
      2,
      "Domain search works"
    );
    const shot = store.query({ folderId }).items[0];
    is(shot.colors.length, 5, "Stored palette contains five colors");
    is(shot.width, 24, "Raster dimensions are computed, not trusted metadata");
    await store.setSettings({ watchFolder: root, autoTags: true });
    await store.setWatchState({
      folder: root,
      initialized: true,
      files: [{ name: sentinel + ".png", size: png.length, mtime: Date.now() }],
    });
    await Assert.rejects(
      store.update([first, "0".repeat(32)], { note: "not committed" }),
      /invalid/,
      "Invalid bulk mutation fails atomically"
    );
    is(
      store.query({ folderId }).items[0].note,
      sentinel,
      "Failed bulk operation keeps old RAM index"
    );
    const objects = await IOUtils.getChildren(PathUtils.join(root, "objects"));
    ok(
      objects.every(path => /^[a-f0-9]{32}$/.test(PathUtils.filename(path))),
      "Image filenames contain no metadata"
    );
    const imagePath = PathUtils.join(root, "objects", first);
    const ciphertext = await IOUtils.read(imagePath);
    Assert.notStrictEqual(ciphertext[0], 137, "Encrypted image is not a PNG");
    const corrupt = ciphertext.slice();
    corrupt[corrupt.length - 1] ^= 1;
    await IOUtils.write(imagePath, corrupt);
    await Assert.rejects(
      store.bytes(first),
      /./,
      "GCM rejects a changed authentication tag"
    );
    await IOUtils.write(imagePath, ciphertext);
    await IOUtils.write(
      imagePath,
      await IOUtils.read(PathUtils.join(root, "objects", second))
    );
    await Assert.rejects(
      store.bytes(first),
      /./,
      "Record-bound AAD rejects swapping image ciphertext"
    );
    await IOUtils.write(imagePath, ciphertext);
    // Lock synchronously invalidates already queued reads and mutations.
    const reading = store.bytes(first);
    store.lock();
    await Assert.rejects(
      reading,
      /locked/,
      "Queued decryption cannot return after lock"
    );
    Assert.throws(
      () => store.query({}),
      /locked/,
      "Locked RAM index is inaccessible"
    );
    await Assert.rejects(
      store.folders(),
      /locked/,
      "Folder names are inaccessible after lock"
    );
    await store.close();
    const db = await Sqlite.openConnection({
      path: PathUtils.join(root, "index.sqlite"),
    });
    try {
      const rows = await db.execute("SELECT id,payload,thumb FROM records");
      ok(
        rows.every(row => /^[a-f0-9]{32}$/.test(row.getResultByName("id"))),
        "All SQLite identifiers, including config/folders, are random"
      );
      const thumb = new Uint8Array(
        rows
          .find(row => row.getResultByName("id") === second)
          .getResultByName("thumb")
      );
      await db.execute("UPDATE records SET thumb=:thumb WHERE id=:id", {
        id: first,
        thumb,
      });
    } finally {
      await db.close();
    }
    store = new GalleryStore(root);
    await store.unlock();
    await Assert.rejects(
      store.bytes(first, "thumb"),
      /./,
      "Record-bound AAD also authenticates thumbnails"
    );
    await store.close();
    for (const path of await IOUtils.getChildren(root)) {
      if ((await IOUtils.stat(path)).type !== "regular") {
        continue;
      }
      const raw = await IOUtils.read(path);
      ok(
        !new TextDecoder().decode(raw).includes(sentinel),
        "No metadata sentinel in SQLite/key/WAL/journal files"
      );
    }
    const tamperDB = await Sqlite.openConnection({
      path: PathUtils.join(root, "index.sqlite"),
    });
    let originalPayload;
    try {
      const rows = await tamperDB.execute(
        "SELECT id,payload FROM records WHERE id=:first OR id=:second",
        { first, second }
      );
      originalPayload = new Uint8Array(
        rows
          .find(row => row.getResultByName("id") === first)
          .getResultByName("payload")
      );
      const swappedPayload = new Uint8Array(
        rows
          .find(row => row.getResultByName("id") === second)
          .getResultByName("payload")
      );
      await tamperDB.execute(
        "UPDATE records SET payload=:payload WHERE id=:id",
        { payload: swappedPayload, id: first }
      );
    } finally {
      await tamperDB.close();
    }
    store = new GalleryStore(root);
    await Assert.rejects(
      store.unlock(),
      /cannot unlock/,
      "Record-bound metadata authentication rejects a swapped SQLite payload"
    );
    ok(
      store.locked,
      "Metadata authentication failure never publishes a partial RAM index"
    );
    await store.close();
    const restoreDB = await Sqlite.openConnection({
      path: PathUtils.join(root, "index.sqlite"),
    });
    try {
      await restoreDB.execute(
        "UPDATE records SET payload=:payload WHERE id=:id",
        { payload: originalPayload, id: first }
      );
    } finally {
      await restoreDB.close();
    }
    const keyPath = PathUtils.join(root, "key");
    const wrapped = await IOUtils.read(keyPath);
    await IOUtils.remove(keyPath);
    store = new GalleryStore(root);
    await Assert.rejects(
      store.unlock(),
      /cannot unlock/,
      "Missing wrapped key never regenerates over existing gallery"
    );
    ok(
      !(await IOUtils.exists(keyPath)),
      "Failed unlock did not replace the missing key"
    );
    await IOUtils.write(keyPath, wrapped);
    if (OSKeyStore.canReauth()) {
      await SpecialPowers.pushPrefEnv({
        set: [[OSKeyStoreTestUtils.TEST_ONLY_REAUTH, "cancel"]],
      });
      try {
        await Assert.rejects(
          store.unlock(),
          /cannot unlock/,
          "OS authentication cancellation fails closed"
        );
        ok(store.locked, "Cancellation leaves no unlocked state");
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }
    await store.unlock();
    await store.remove([first, second]);
    is(
      store.query({}).total,
      0,
      "Bulk deletion removes RAM index only after encrypted transaction"
    );
    ok(!(await IOUtils.exists(imagePath)), "Deletion removes encrypted image");
    await store.close();
    await native.asyncDeleteSecret(OSKeyStore.STORE_LABEL);
    await Assert.rejects(
      store.unlock(),
      /cannot unlock/,
      "Missing native OS secret fails closed"
    );
    ok(
      !(await native.asyncSecretAvailable(OSKeyStore.STORE_LABEL)),
      "Unlock never creates a replacement native secret for existing data"
    );
  } finally {
    await store.close();
    await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
    await OSKeyStoreTestUtils.cleanup();
    await SpecialPowers.popPrefEnv();
  }
});
