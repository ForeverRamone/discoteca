import { api } from './api.js';

export const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

export const state = {
  tree: { folders: [], collections: [] },
  country: 'es',
  authRequired: false,
};

// Aviso global de cambios: la app vuelve a pintar la barra lateral y la vista actual.
export const bus = new EventTarget();

export async function loadTree() {
  state.tree = await api('/tree');
  return state.tree;
}

export async function changed() {
  await loadTree();
  bus.dispatchEvent(new Event('change'));
}

// ---------- Árbol ----------
export const folderById = (id) => state.tree.folders.find((f) => f.id === id) || null;
export const collectionById = (id) => state.tree.collections.find((c) => c.id === id) || null;

export const childFolders = (parentId) =>
  state.tree.folders
    .filter((f) => (f.parentId ?? null) === (parentId ?? null))
    .sort((a, b) => collator.compare(a.name, b.name));

export const childCollections = (folderId) =>
  state.tree.collections
    .filter((c) => (c.folderId ?? null) === (folderId ?? null))
    .sort((a, b) => collator.compare(a.name, b.name));

export function folderPath(folderId) {
  const path = [];
  for (let f = folderById(folderId); f; f = folderById(f.parentId)) path.unshift(f);
  return path;
}

export function descendantFolderIds(folderId) {
  const out = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of state.tree.folders) {
      if (out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

export function folderStats(folderId) {
  const ids = descendantFolderIds(folderId);
  return {
    folders: ids.size - 1,
    collections: state.tree.collections.filter((c) => ids.has(c.folderId)).length,
  };
}

// ---------- Preferencias de este dispositivo ----------
// Se guardan en el navegador porque pueden variar entre iPhone y Mac.
const PREFIX = 'discoteca:';
export const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* almacenamiento no disponible */
    }
  },
};

// ---------- Apple Music ----------
export function appleWebUrl(album) {
  const url = album.appleUrl;
  return url && /^https:\/\/(music|itunes)\.apple\.com\//.test(url) ? url : `https://music.apple.com/${state.country}/album/${Number(album.id)}`;
}

// "app": music://… abre directamente la app Música (iPhone y Mac).
// "web": https://music.apple.com/… (enlace universal; el sistema decide si abre la app o la web).
export function appleLink(album) {
  const url = appleWebUrl(album);
  return prefs.get('linkMode', 'app') === 'app' ? url.replace(/^https:\/\//, 'music://') : url;
}

export function linkTarget() {
  return prefs.get('linkMode', 'app') === 'web' ? { target: '_blank', rel: 'noopener' } : {};
}

// Las portadas de Apple admiten cualquier tamaño cambiando el sufijo "100x100bb.jpg".
export function artwork(url, size) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+[a-z]*\.(jpg|jpeg|png|webp)$/i, `/${size}x${size}bb.jpg`);
}

export const normalize = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function sortAlbums(albums, mode) {
  const list = [...albums];
  const byArtist = (a, b) => collator.compare(a.artist, b.artist) || (a.year ?? 0) - (b.year ?? 0) || collator.compare(a.title, b.title);
  const cmp = {
    position: (a, b) => (a.position ?? 0) - (b.position ?? 0),
    original: (a, b) => (a.originalPosition ?? a.position ?? 0) - (b.originalPosition ?? b.position ?? 0),
    artist: byArtist,
    year: (a, b) => (a.year ?? 9999) - (b.year ?? 9999) || byArtist(a, b),
    title: (a, b) => collator.compare(a.title, b.title),
    added: (a, b) => String(b.addedAt ?? b.savedAt).localeCompare(String(a.addedAt ?? a.savedAt)) || (a.position ?? 0) - (b.position ?? 0),
  }[mode];
  return cmp ? list.sort(cmp) : list;
}
