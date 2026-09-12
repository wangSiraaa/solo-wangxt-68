// IndexedDB 持久化：所有数据只存在浏览器本地，图片永不离开机器。
//  projects store：项目状态（不含 pack 的大图 dataURL 时可减小体积，
//    但 pack 结果可随时从源图重新生成，因此不持久化 pack）
//  blobs   store：原始上传/生成图片的 Blob，key = source.blobKey
import { openDB, type IDBPDatabase } from 'idb';
import type { FrameSource, ProjectState } from './types';

const DB_NAME = 'sprite-atlas-studio';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_BLOBS = 'blobs';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE_PROJECTS)) {
          database.createObjectStore(STORE_PROJECTS, { keyPath: 'meta.id' });
        }
        if (!database.objectStoreNames.contains(STORE_BLOBS)) {
          database.createObjectStore(STORE_BLOBS);
        }
      },
    });
  }
  return dbPromise;
}

/** 列出已保存项目的摘要 */
export async function listProjects(): Promise<
  { id: string; name: string; updatedAt: number }[]
> {
  const d = await db();
  const all = await d.getAllKeys(STORE_PROJECTS);
  const out: { id: string; name: string; updatedAt: number }[] = [];
  for (const key of all) {
    const p = (await d.get(STORE_PROJECTS, key)) as PersistedProject | undefined;
    if (p) out.push({ id: p.meta.id, name: p.meta.name, updatedAt: p.meta.updatedAt });
  }
  return out.sort((x, y) => y.updatedAt - x.updatedAt);
}

interface PersistedProject extends Omit<ProjectState, 'pack'> {
  pack: null;
}

export async function saveProject(state: ProjectState): Promise<void> {
  const d = await db();
  // pack 结果不持久化（可随时从源图重新生成），避免大图反复写入
  const persisted: PersistedProject = {
    meta: state.meta,
    settings: state.settings,
    frames: state.frames,
    sources: state.sources,
    pack: null,
  };
  await d.put(STORE_PROJECTS, persisted);
}

export async function setBlob(key: string, blob: Blob): Promise<void> {
  const d = await db();
  await d.put(STORE_BLOBS, blob, key);
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  const d = await db();
  return d.get(STORE_BLOBS, key) as Promise<Blob | undefined>;
}

export async function deleteBlob(key: string): Promise<void> {
  const d = await db();
  await d.delete(STORE_BLOBS, key);
}

export async function loadProject(id: string): Promise<ProjectState | null> {
  const d = await db();
  const p = (await d.get(STORE_PROJECTS, id)) as PersistedProject | undefined;
  if (!p) return null;
  return { ...p, pack: null };
}

export async function deleteProject(id: string): Promise<void> {
  const d = await db();
  const p = (await d.get(STORE_PROJECTS, id)) as PersistedProject | undefined;
  const tx = d.transaction([STORE_PROJECTS, STORE_BLOBS], 'readwrite');
  await tx.objectStore(STORE_PROJECTS).delete(id);
  if (p) {
    for (const s of Object.values(p.sources as Record<string, FrameSource>)) {
      await tx.objectStore(STORE_BLOBS).delete(s.blobKey);
    }
  }
  await tx.done;
}

/** 收集项目中不再被任何 source 引用的 blob 并清除 */
export async function gcBlobs(sources: FrameSource[]): Promise<void> {
  const d = await db();
  const keep = new Set(sources.map((s) => s.blobKey));
  const tx = d.transaction(STORE_BLOBS, 'readwrite');
  const keys = await tx.objectStore(STORE_BLOBS).getAllKeys();
  for (const k of keys) {
    if (!keep.has(k as string)) await tx.objectStore(STORE_BLOBS).delete(k);
  }
  await tx.done;
}
