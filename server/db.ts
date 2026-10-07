import fs from 'fs';
import path from 'path';
import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  limit,
  writeBatch,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';

function readFirebaseConfig() {
  try {
    const p = path.join(process.cwd(), 'firebase-applet-config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const fb = readFirebaseConfig();
const app = getApps()[0] ?? initializeApp(fb);
export const rawDb = getFirestore(app, fb.firestoreDatabaseId || '(default)');

export const now = () => new Date().toISOString();

export function cleanUndefined(obj: any): any {
  if (obj === undefined) return undefined;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanUndefined).filter((v) => v !== undefined);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      const cleaned = cleanUndefined(v);
      if (cleaned !== undefined) {
        out[k] = cleaned;
      }
    }
  }
  return out;
}

export class DocWrapper {
  public rawRef: any;
  public id: string;
  public collectionName: string;
  constructor(collectionName: string, id?: string) {
    this.collectionName = collectionName;
    if (id) {
      this.rawRef = doc(rawDb, collectionName, id);
      this.id = id;
    } else {
      this.rawRef = doc(collection(rawDb, collectionName));
      this.id = this.rawRef.id;
    }
  }

  async get() {
    const snap = await getDoc(this.rawRef);
    return {
      id: snap.id,
      exists: snap.exists(),
      data: () => (snap.exists() ? (snap.data() as any) : undefined),
    };
  }

  async set(data: any, options?: { merge?: boolean; mergeFields?: string[] }) {
    const cleaned = cleanUndefined(data) ?? {};
    if (options?.mergeFields) {
      const filtered: Record<string, any> = {};
      for (const k of options.mergeFields) {
        if (k in cleaned) filtered[k] = cleaned[k];
      }
      await setDoc(this.rawRef, filtered, { merge: true });
    } else if (options?.merge) {
      await setDoc(this.rawRef, cleaned, { merge: true });
    } else {
      await setDoc(this.rawRef, cleaned);
    }
  }

  async create(data: any) {
    const snap = await getDoc(this.rawRef);
    if (snap.exists()) {
      const err: any = new Error('Document already exists');
      err.code = 6;
      throw err;
    }
    await setDoc(this.rawRef, cleanUndefined(data) ?? {});
  }

  async update(data: any) {
    await updateDoc(this.rawRef, cleanUndefined(data) ?? {});
  }

  async delete() {
    await deleteDoc(this.rawRef);
  }
}

export class QueryWrapper {
  private constraints: any[] = [];
  public collectionName: string;
  constructor(collectionName: string, constraints: any[] = []) {
    this.collectionName = collectionName;
    this.constraints = [...constraints];
  }

  where(field: string, op: any, value: any) {
    return new QueryWrapper(this.collectionName, [...this.constraints, where(field, op, value)]);
  }

  limit(count: number) {
    return new QueryWrapper(this.collectionName, [...this.constraints, limit(count)]);
  }

  async get() {
    const cRef = collection(rawDb, this.collectionName);
    const q = this.constraints.length ? query(cRef, ...this.constraints) : cRef;
    const snap = await getDocs(q);
    return {
      size: snap.size,
      empty: snap.empty,
      docs: snap.docs.map((d) => ({
        id: d.id,
        exists: true,
        data: () => d.data() as any,
      })),
    };
  }
}

export class CollectionWrapper {
  public collectionName: string;
  constructor(collectionName: string) {
    this.collectionName = collectionName;
  }

  doc(id?: string) {
    return new DocWrapper(this.collectionName, id);
  }

  where(field: string, op: any, value: any) {
    return new QueryWrapper(this.collectionName).where(field, op, value);
  }

  limit(count: number) {
    return new QueryWrapper(this.collectionName).limit(count);
  }

  async add(data: any) {
    const docRef = new DocWrapper(this.collectionName);
    await docRef.set(data);
    return docRef;
  }

  async get() {
    return new QueryWrapper(this.collectionName).get();
  }
}

export const db = {
  collection(name: string) {
    return new CollectionWrapper(name);
  },
  async getAll(...docRefs: any[]) {
    return Promise.all(docRefs.map((r) => r.get()));
  },
  batch() {
    const b = writeBatch(rawDb);
    return {
      set(docRef: any, data: any) {
        b.set(docRef.rawRef, cleanUndefined(data) ?? {});
        return this;
      },
      update(docRef: any, data: any) {
        b.update(docRef.rawRef, cleanUndefined(data) ?? {});
        return this;
      },
      delete(docRef: any) {
        b.delete(docRef.rawRef);
        return this;
      },
      async commit() {
        await b.commit();
      },
    };
  },
};

export const FieldValue = {
  arrayUnion: (...elements: any[]) => arrayUnion(...elements),
  arrayRemove: (...elements: any[]) => arrayRemove(...elements),
  serverTimestamp: () => new Date().toISOString(),
};

export const col = {
  users: () => db.collection('users'),
  media: () => db.collection('media'),
  logs: () => db.collection('activity_logs'),
  collections: () => db.collection('collections'),
  updates: () => db.collection('processed_updates'),
};

export const fsCode = (e: unknown) => {
  if (!e || typeof e !== 'object') return undefined;
  if ('code' in e && typeof (e as any).code === 'number') return (e as any).code;
  const str = String((e as any).code || (e as any).message || '');
  if (str.includes('already-exists') || str.includes('ALREADY_EXISTS') || (e as any).code === 6) return 6;
  if (str.includes('permission-denied') || str.includes('PERMISSION_DENIED')) return 7;
  if (str.includes('deadline-exceeded')) return 4;
  if (str.includes('resource-exhausted')) return 8;
  if (str.includes('unavailable')) return 14;
  return undefined;
};

// 6 ALREADY_EXISTS, 4 DEADLINE_EXCEEDED, 7 PERMISSION_DENIED, 8 RESOURCE_EXHAUSTED, 14 UNAVAILABLE
export const isDbOutage = (e: unknown) => [4, 7, 8, 14, 16].includes(fsCode(e) ?? -1);
