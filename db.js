// IndexedDB storage for ApplyPilot. Loaded in THREE contexts, all sharing the
// same extension-origin database:
//   - popup        — via <script src="db.js"> (globals on window)
//   - service worker — via importScripts('db.js') in background.js (globals on the SW)
//   - Node tests   — via require('./db.js') after fake-indexeddb/auto (module.exports)
//
// Why IndexedDB and not chrome.storage: a real resume's base64 (a PDF up to the
// tenant's 5MB cap → ~6.7MB string) blows past chrome.storage quotas, and binary
// document bytes don't belong there. IndexedDB-held base64 is the substrate the
// fixed-resume path (now) and the future AI-tailored per-application variant path
// (Phase 2+) share. The injection boundary can't carry a File/Blob, so bytes are
// stored as base64 and read out HERE (popup/SW), then passed as a plain string
// into the injected function, which rebuilds the File in the page context.

const DB_NAME = "ApplyPilot";
const DB_VERSION = 1;
const RESUME_STORE = "resume";
// Single fixed key — exactly one resume this round. Per-application keying /
// tailored-variant slots are Phase 2+ and must NOT be pre-built; they would just
// add more keys to this same store.
const RESUME_KEY = "resume:default";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RESUME_STORE)) {
        db.createObjectStore(RESUME_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Store a resume record: { key, filename, mime, size, base64, savedAt }. put()
// overwrites any existing record under the same key (single fixed resume).
async function saveResume(record) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RESUME_STORE, "readwrite");
      tx.objectStore(RESUME_STORE).put({ ...record, key: record.key || RESUME_KEY });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// Read a resume record; resolves the record, or undefined if none is stored.
async function getResume(key = RESUME_KEY) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RESUME_STORE, "readonly");
      const req = tx.objectStore(RESUME_STORE).get(key);
      req.onsuccess = () => resolve(req.result || undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// UMD-lite: export for the Node test runner; in the popup/SW `module` is undefined
// so the functions simply stay as globals (from <script> / importScripts).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { openDB, saveResume, getResume, RESUME_KEY, RESUME_STORE, DB_NAME };
}
