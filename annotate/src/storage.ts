import type { Annotation, AnnotationStorage, PageIdentity, PageSummary } from "./types";
import { SCHEMA_VERSION } from "./types";

/**
 * Logical database document shared by the JSON-document adapters
 * (localStorage, Tampermonkey). IndexedDB uses real object stores.
 */
export interface AnnotationDB {
  schemaVersion: number;
  pages: Record<
    string,
    {
      identity: PageIdentity;
      annotations: Annotation[];
    }
  >;
  settings?: Record<string, unknown>;
}

export function emptyDB(): AnnotationDB {
  return { schemaVersion: SCHEMA_VERSION, pages: {} };
}

/** Migration hook: bring any older on-disk document up to the current schema. */
export function migrateDB(raw: unknown): AnnotationDB {
  if (!raw || typeof raw !== "object") return emptyDB();
  const db = raw as Partial<AnnotationDB>;
  if (!db.pages || typeof db.pages !== "object") return emptyDB();
  // schemaVersion 1 is the first release; future versions add migration steps here.
  return { schemaVersion: SCHEMA_VERSION, pages: db.pages as AnnotationDB["pages"], settings: db.settings };
}

function dbSummaries(db: AnnotationDB): PageSummary[] {
  return Object.values(db.pages)
    .filter((p) => p.annotations.length > 0)
    .map((p) => ({ page: p.identity, count: p.annotations.length }));
}

function dbAll(db: AnnotationDB): Annotation[] {
  return Object.values(db.pages).flatMap((p) => p.annotations);
}

/** Adapter over any get/set persisted JSON document (localStorage, GM storage, ...). */
export class DocumentStorage implements AnnotationStorage {
  constructor(
    private read: () => AnnotationDB | Promise<AnnotationDB>,
    private write: (db: AnnotationDB) => void | Promise<void>
  ) {}

  async getPage(page: PageIdentity): Promise<Annotation[]> {
    const db = await this.read();
    return db.pages[page.id]?.annotations.slice() ?? [];
  }

  async get(id: string): Promise<Annotation | null> {
    const db = await this.read();
    for (const p of Object.values(db.pages)) {
      const found = p.annotations.find((a) => a.id === id);
      if (found) return found;
    }
    return null;
  }

  async save(annotation: Annotation, page?: PageIdentity): Promise<void> {
    const db = await this.read();
    let entry = db.pages[annotation.pageId];
    if (!entry) {
      entry = {
        identity: page ?? { id: annotation.pageId, url: annotation.anchor.url, normalizedUrl: annotation.anchor.url },
        annotations: [],
      };
      db.pages[annotation.pageId] = entry;
    } else if (page) {
      entry.identity = page;
    }
    const idx = entry.annotations.findIndex((a) => a.id === annotation.id);
    if (idx >= 0) entry.annotations[idx] = annotation;
    else entry.annotations.push(annotation);
    await this.write(db);
  }

  async delete(id: string): Promise<void> {
    const db = await this.read();
    let changed = false;
    for (const [pageId, p] of Object.entries(db.pages)) {
      const before = p.annotations.length;
      p.annotations = p.annotations.filter((a) => a.id !== id);
      if (p.annotations.length !== before) changed = true;
      if (p.annotations.length === 0) delete db.pages[pageId];
    }
    if (changed) await this.write(db);
  }

  async listPages(): Promise<PageSummary[]> {
    return dbSummaries(await this.read());
  }

  async listAll(): Promise<Annotation[]> {
    return dbAll(await this.read());
  }

  /** Full document access for export/import. */
  async exportDB(): Promise<AnnotationDB> {
    return await this.read();
  }

  async importDB(db: AnnotationDB): Promise<void> {
    await this.write(db);
  }
}

// ---------------------------------------------------------------------------

export function createMemoryStorage(): DocumentStorage {
  let db = emptyDB();
  const clone = (value: AnnotationDB): AnnotationDB =>
    typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  // Clone on both sides so callers can never mutate the store through returned references.
  return new DocumentStorage(
    () => clone(db),
    (next) => {
      db = clone(next);
    }
  );
}

const LS_KEY = "wm-annotate:db";

export function createLocalStorageStorage(key = LS_KEY): DocumentStorage {
  return new DocumentStorage(
    () => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? migrateDB(JSON.parse(raw)) : emptyDB();
      } catch {
        return emptyDB();
      }
    },
    (db) => {
      localStorage.setItem(key, JSON.stringify(db));
    }
  );
}

// ---------------------------------------------------------------------------
// Tampermonkey / GM storage: userscript-wide, so annotations from every origin
// the script matches live in one logical collection.
// ---------------------------------------------------------------------------

interface GMApi {
  getValue(key: string, def?: unknown): unknown | Promise<unknown>;
  setValue(key: string, value: unknown): void | Promise<void>;
}

function detectGM(): GMApi | null {
  const g = globalThis as Record<string, any>;
  if (typeof g.GM_getValue === "function" && typeof g.GM_setValue === "function") {
    return { getValue: g.GM_getValue, setValue: g.GM_setValue };
  }
  if (g.GM && typeof g.GM.getValue === "function" && typeof g.GM.setValue === "function") {
    return { getValue: g.GM.getValue.bind(g.GM), setValue: g.GM.setValue.bind(g.GM) };
  }
  return null;
}

const GM_KEY = "wm-annotate:db";

export function createTampermonkeyStorage(key = GM_KEY): DocumentStorage {
  const gm = detectGM();
  if (!gm) {
    console.warn("[webmods-annotate] GM storage not available (missing @grant GM_getValue/GM_setValue); falling back to localStorage");
    return createLocalStorageStorage(key);
  }
  return new DocumentStorage(
    async () => {
      try {
        const raw = await gm.getValue(key, null);
        if (!raw) return emptyDB();
        return migrateDB(typeof raw === "string" ? JSON.parse(raw) : raw);
      } catch {
        return emptyDB();
      }
    },
    async (db) => {
      await gm.setValue(key, JSON.stringify(db));
    }
  );
}

// ---------------------------------------------------------------------------
// IndexedDB: real object stores for larger local datasets.
// ---------------------------------------------------------------------------

const IDB_NAME = "wm-annotate";
const IDB_VERSION = 1;

function openIDB(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("annotations")) {
        const store = db.createObjectStore("annotations", { keyPath: "id" });
        store.createIndex("pageId", "pageId", { unique: false });
      }
      if (!db.objectStoreNames.contains("pages")) {
        db.createObjectStore("pages", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function createIndexedDBStorage(name = IDB_NAME): AnnotationStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ??= openIDB(name));

  return {
    async getPage(page) {
      const store = (await db()).transaction("annotations").objectStore("annotations");
      return idbRequest(store.index("pageId").getAll(page.id));
    },
    async get(id) {
      const store = (await db()).transaction("annotations").objectStore("annotations");
      return (await idbRequest(store.get(id))) ?? null;
    },
    async save(annotation, page) {
      const tx = (await db()).transaction(["annotations", "pages", "meta"], "readwrite");
      tx.objectStore("annotations").put(annotation);
      if (page) tx.objectStore("pages").put(page);
      tx.objectStore("meta").put(SCHEMA_VERSION, "schemaVersion");
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    async delete(id) {
      const tx = (await db()).transaction("annotations", "readwrite");
      tx.objectStore("annotations").delete(id);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    async listPages() {
      const d = await db();
      const pages: PageIdentity[] = await idbRequest(d.transaction("pages").objectStore("pages").getAll());
      const all: Annotation[] = await idbRequest(d.transaction("annotations").objectStore("annotations").getAll());
      const counts = new Map<string, number>();
      for (const a of all) counts.set(a.pageId, (counts.get(a.pageId) || 0) + 1);
      return pages
        .filter((p) => counts.has(p.id))
        .map((p) => ({ page: p, count: counts.get(p.id)! }));
    },
    async listAll() {
      const store = (await db()).transaction("annotations").objectStore("annotations");
      return idbRequest(store.getAll());
    },
  };
}
