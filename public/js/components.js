import { api } from './api.js';
import { h, icon, openDialog, dialogHeader, promptText, confirmDialog, actionSheet, toast, showError } from './dom.js';
import { savedAlbumPlayer, pickBandcamp } from './bandcamp.js';
import { lazyCover } from './images.js';
import {
  state, prefs, collator, changed, appleLink, appleWebUrl, linkTarget, artwork, normalize, isBandcamp, serviceName, sortAlbums,
  folderById, collectionById, childFolders, folderPath, descendantFolderIds, folderStats,
} from './store.js';

// ---------- Portadas y álbumes ----------

// Etiqueta sobre la portada para los discos que no son de Apple Music.
export const providerBadge = (album) => isBandcamp(album) && h('span', { class: 'provider-badge', title: 'Disco de Bandcamp' }, 'Bandcamp');

export function coverImg(album, size = 160) {
  if (!album.artworkUrl) return h('div', { class: 'cover-ph' }, icon('disc'), providerBadge(album));
  return h('span', { class: 'cover-wrap' }, coverImgOnly(album, size), providerBadge(album));
}

// Tamaño justo según lo que ocupa en pantalla, carga diferida y liberación de memoria (images.js).
function coverImgOnly(album) {
  return lazyCover(album.artworkUrl);
}

const subtitle = (a) => [a.artist, a.year].filter(Boolean).join(' · ');

// Toque en la portada: abre Apple Music directamente o muestra la ficha, según los ajustes.
function coverTap(album, ctx, child, cls = 'cover') {
  if (ctx.editing) return h('div', { class: cls }, child); // en modo reordenar no se abre nada
  if (prefs.get('coverTap', 'open') === 'open') {
    return h('a', { class: cls, href: appleLink(album), ...linkTarget(album), title: `Abrir «${album.title}» en ${serviceName(album)}` }, child);
  }
  return h('button', { class: cls, type: 'button', title: album.title, onclick: () => albumDetails(album, ctx) }, child);
}

function albumCard(album, ctx, size) {
  return h('div', { class: 'card', dataset: { id: album.id } },
    coverTap(album, ctx, coverImg(album, size)),
    h('div', { class: 'card-meta' },
      h('button', { class: 'card-text', type: 'button', onclick: () => albumDetails(album, ctx) },
        h('span', { class: 'card-title' }, album.title),
        h('span', { class: 'card-sub' }, subtitle(album))),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Más opciones', onclick: () => albumDetails(album, ctx) }, icon('more'))));
}

function albumRow(album, ctx, index) {
  return h('div', { class: 'row', dataset: { id: album.id } },
    ctx.numbered && h('span', { class: 'row-num' }, index + 1),
    coverTap(album, ctx, coverImg(album, 64), 'row-cover'),
    h('button', { class: 'row-text', type: 'button', onclick: () => albumDetails(album, ctx) },
      h('span', { class: 'row-title' }, album.title),
      h('span', { class: 'row-sub' }, album.artist)),
    h('span', { class: 'row-year' }, album.year ?? ''),
    h('a', { class: 'icon-btn small', href: appleLink(album), ...linkTarget(album), 'aria-label': `Abrir en ${serviceName(album)}` }, icon(isBandcamp(album) ? 'external' : 'play')),
    h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Más opciones', onclick: () => albumDetails(album, ctx) }, icon('more')));
}

// Pinta en tandas para que listas de cientos de discos no bloqueen la pantalla.
export function albumGrid(albums, { mode = 'grid', size = 160, ctx = {} } = {}) {
  const wrap = h('div', { class: `${mode === 'grid' ? 'album-grid' : 'album-list'}${ctx.editing ? ' editing' : ''}`, vars: { '--cover': `${size}px` } });
  let i = 0;
  const batch = () => {
    // Al reordenar se pinta todo de una vez para poder arrastrar a cualquier posición.
    const end = ctx.editing ? albums.length : Math.min(i + 120, albums.length);
    for (; i < end; i++) wrap.append(mode === 'grid' ? albumCard(albums[i], ctx, size) : albumRow(albums[i], ctx, i));
    if (i < albums.length) requestAnimationFrame(batch);
  };
  batch();
  return wrap;
}

// Copia de Bandcamp en la ficha: escucharla aquí, abrirla, cambiarla o buscarla.
function bandcampBlock(album, close) {
  if (!album.bandcampUrl) {
    if (isBandcamp(album)) return null;
    return h('div', { class: 'bc-block' },
      h('button', { class: 'btn small', type: 'button', onclick: () => close('bandcamp-link') }, icon('search'), 'Buscar su copia en Bandcamp'));
  }
  const { button, panel } = savedAlbumPlayer(album.id);
  return h('div', { class: 'bc-block' },
    !isBandcamp(album) && h('p', { class: 'small bc-title' }, 'También en Bandcamp'),
    h('div', { class: 'actions' },
      button,
      !isBandcamp(album) && h('a', { class: 'btn small', href: album.bandcampUrl, target: '_blank', rel: 'noopener' }, icon('external'), 'Abrir en Bandcamp'),
      !isBandcamp(album) && h('button', { class: 'btn small', type: 'button', onclick: () => close('bandcamp-link') }, 'Cambiar'),
      !isBandcamp(album) && h('button', { class: 'btn small danger-text', type: 'button', onclick: () => close('bandcamp-unlink') }, 'Quitar')),
    panel);
}

export async function albumDetails(album, ctx = {}) {
  let collectionIds = [];
  try {
    const detail = await api(`/albums/${album.id}`);
    collectionIds = detail.collectionIds;
    album = { ...album, ...detail.album };
  } catch (err) {
    return showError(err);
  }
  const current = ctx.collectionId ? collectionById(ctx.collectionId) : null;
  // Con artistId, el artista lleva a su discografía completa en Buscar.
  const artistHref = album.artistId && `#/buscar?${new URLSearchParams({ artist: album.artistId, name: album.artist })}`;
  const action = await openDialog((close) =>
    h('div', { class: 'album-detail' },
      dialogHeader('Álbum', close),
      h('div', { class: 'dlg-body' },
        h('a', { class: 'detail-cover', href: appleLink(album), ...linkTarget(album) }, coverImg(album, 600)),
        h('div', { class: 'detail-info' },
          h('h3', { class: 'detail-title' }, album.title),
          artistHref
            ? h('a', { class: 'detail-artist', href: artistHref, title: 'Ver discografía completa', onclick: () => close() }, album.artist)
            : h('p', { class: 'detail-artist' }, album.artist),
          h('p', { class: 'muted small' },
            [album.year, album.genre, album.trackCount && `${album.trackCount} pistas`].filter(Boolean).join(' · ')),
          h('a', { class: 'btn primary block', href: appleLink(album), ...linkTarget(album) }, icon(isBandcamp(album) ? 'external' : 'play'), `Abrir en ${serviceName(album)}`),
          isBandcamp(album) && h('p', { class: 'muted small center' }, 'Este disco no está en Apple Music: se abre su página de Bandcamp.'),
          bandcampBlock(album, close),
          h('div', { class: 'chips' },
            collectionIds.length
              ? collectionIds.map((id) => collectionById(id)).filter(Boolean).map((c) =>
                h('a', { class: 'chip', href: `#/c/${c.id}`, onclick: () => close() }, icon('stack'), c.name))
              : h('span', { class: 'muted small' }, 'No está en ninguna colección.')),
          h('div', { class: 'detail-actions' },
            h('button', { class: 'btn', type: 'button', onclick: () => close('collections') }, icon('stack'), 'Colecciones…'),
            current && h('button', { class: 'btn', type: 'button', onclick: () => close('remove') }, icon('close'), `Quitar de «${current.name}»`),
            h('button', { class: 'btn', type: 'button', onclick: () => close('refresh') }, icon('refresh'), 'Actualizar datos'),
            h('button', { class: 'btn danger-text', type: 'button', onclick: () => close('delete') }, icon('trash'), 'Eliminar de la biblioteca'))))),
    { className: 'album-dlg' },
  );

  try {
    if (action === 'collections') {
      await editAlbumCollections(album, collectionIds);
    } else if (action === 'remove') {
      // Se guarda el orden actual para poder deshacer dejándolo todo como estaba.
      const { albums: before } = await api(`/collections/${current.id}`);
      const order = sortAlbums(before, 'position').map((a) => a.id);
      await api(`/collections/${current.id}/albums/${album.id}`, { method: 'DELETE' });
      toast(`Quitado de «${current.name}»`, {
        action: {
          label: 'Deshacer',
          run: async () => {
            try {
              await api('/albums', { method: 'POST', body: { id: album.id, addTo: [current.id] } });
              await api(`/collections/${current.id}/order`, { method: 'PUT', body: { albumIds: order } });
              toast(`Vuelve a estar en «${current.name}»`);
              await changed();
            } catch (err) {
              showError(err);
            }
          },
        },
      });
      await changed();
    } else if (action === 'refresh') {
      await api(`/albums/${album.id}/refresh`, { method: 'POST' });
      toast('Datos actualizados');
      await changed();
    } else if (action === 'bandcamp-link') {
      const hit = await pickBandcamp({ title: `«${album.title}» en Bandcamp`, query: `${album.artist} ${album.title}` });
      if (!hit) return albumDetails(album, ctx);
      const res = await api(`/albums/${album.id}/bandcamp`, { method: 'PUT', body: { bandcampId: hit.bandcampId } });
      toast('Copia de Bandcamp asociada');
      await changed();
      return albumDetails(res.album, ctx);
    } else if (action === 'bandcamp-unlink') {
      const res = await api(`/albums/${album.id}/bandcamp`, { method: 'DELETE' });
      toast('Copia de Bandcamp quitada');
      await changed();
      return albumDetails(res.album, ctx);
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: 'Eliminar de la biblioteca',
        message: `«${album.title}» desaparecerá de todas tus colecciones. No afecta a Apple Music.`,
        okText: 'Eliminar',
        danger: true,
      });
      if (!ok) return;
      await api(`/albums/${album.id}`, { method: 'DELETE' });
      toast('Álbum eliminado');
      await changed();
    }
  } catch (err) {
    showError(err);
  }
}

export async function editAlbumCollections(album, selected) {
  const ids = await pickCollections({ title: `Colecciones de «${album.title}»`, selected });
  if (!ids) return;
  await api(`/albums/${album.id}/collections`, { method: 'PUT', body: { collectionIds: ids } });
  toast('Colecciones actualizadas');
  await changed();
}

// ---------- Selectores ----------

const collectionLabel = (c) => folderPath(c.folderId).map((f) => f.name).join(' › ');

// Devuelve la lista de IDs de colección marcados, o undefined si se cancela.
export function pickCollections({ title, selected = [], okText = 'Guardar' }) {
  const checked = new Set(selected);
  return openDialog((close) => {
    const list = h('div', { class: 'pick-list' });
    const filter = h('input', { type: 'search', placeholder: 'Filtrar colecciones', 'aria-label': 'Filtrar colecciones' });

    const draw = () => {
      const f = normalize(filter.value);
      const items = [...state.tree.collections]
        .map((c) => ({ c, path: collectionLabel(c) }))
        .filter(({ c, path }) => !f || normalize(`${path} ${c.name}`).includes(f))
        .sort((a, b) => collator.compare(`${a.path} ${a.c.name}`, `${b.path} ${b.c.name}`));
      list.replaceChildren(
        ...items.map(({ c, path }) =>
          h('label', { class: 'pick-item' },
            h('input', {
              type: 'checkbox',
              checked: checked.has(c.id),
              onchange: (e) => (e.target.checked ? checked.add(c.id) : checked.delete(c.id)),
            }),
            h('span', { class: 'pick-text' },
              h('span', null, c.name),
              path && h('span', { class: 'muted small' }, path)))),
      );
      if (!items.length) list.append(h('p', { class: 'muted small pad' }, state.tree.collections.length ? 'Ninguna coincide.' : 'Aún no tienes colecciones. Crea una abajo.'));
    };
    filter.addEventListener('input', draw);

    const newName = h('input', { type: 'text', placeholder: 'Nueva colección', maxlength: 200, 'aria-label': 'Nombre de la nueva colección' });
    const createNew = async () => {
      const name = newName.value.trim();
      if (!name) return newName.focus();
      try {
        const { id } = await api('/collections', { method: 'POST', body: { name } });
        await changed();
        checked.add(id);
        newName.value = '';
        filter.value = '';
        draw();
      } catch (err) {
        showError(err);
      }
    };
    newName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createNew();
      }
    });

    draw();
    return h('div', { class: 'picker' },
      dialogHeader(title, close),
      h('div', { class: 'dlg-body' },
        state.tree.collections.length > 6 && filter,
        list,
        h('div', { class: 'new-row' }, newName, h('button', { class: 'btn', type: 'button', onclick: createNew }, icon('plus'), 'Crear')),
        h('div', { class: 'dlg-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancelar'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => close([...checked]) }, okText))));
  });
}

// Devuelve el ID de carpeta elegido, null para la raíz o undefined si se cancela.
export function pickFolder({ title, exclude = new Set(), current = null }) {
  return openDialog((close) => {
    const items = [];
    const walk = (parentId, depth) => {
      for (const f of childFolders(parentId)) {
        if (exclude.has(f.id)) continue;
        items.push({ f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
    const option = (id, label, depth) =>
      h('button', {
        class: `pick-folder ${id === current ? 'current' : ''}`,
        type: 'button',
        vars: { '--depth': depth },
        onclick: () => close({ id }),
      }, icon(id == null ? 'home' : 'folder'), label, id === current && h('span', { class: 'muted small' }, ' (actual)'));
    return h('div', null,
      dialogHeader(title, close),
      h('div', { class: 'dlg-body pick-list' },
        option(null, 'Inicio (sin carpeta)', 0),
        items.map(({ f, depth }) => option(f.id, f.name, depth))));
  }).then((r) => (r === undefined ? undefined : r.id));
}

// ---------- Carpetas y colecciones ----------

export async function createFolder(parentId = null) {
  const name = await promptText({ title: 'Nueva carpeta', placeholder: 'p. ej. Jazz', okText: 'Crear' });
  if (!name) return;
  try {
    const { id } = await api('/folders', { method: 'POST', body: { name, parentId } });
    await changed();
    location.hash = `#/f/${id}`;
  } catch (err) {
    showError(err);
  }
}

export async function createCollection(folderId = null) {
  const name = await promptText({ title: 'Nueva colección', placeholder: 'p. ej. Modal', okText: 'Crear' });
  if (!name) return;
  try {
    const { id } = await api('/collections', { method: 'POST', body: { name, folderId } });
    await changed();
    location.hash = `#/c/${id}`;
  } catch (err) {
    showError(err);
  }
}

export function folderActions(folder) {
  return actionSheet({
    title: folder.name,
    actions: [
      { label: 'Nueva subcarpeta', icon: 'folder', run: () => createFolder(folder.id) },
      { label: 'Nueva colección aquí', icon: 'stack', run: () => createCollection(folder.id) },
      { label: 'Renombrar', icon: 'edit', run: () => renameFolder(folder) },
      { label: 'Mover a…', icon: 'move', run: () => moveFolder(folder) },
      { label: 'Eliminar', icon: 'trash', danger: true, run: () => deleteFolder(folder) },
    ],
  });
}

export function collectionActions(collection) {
  return actionSheet({
    title: collection.name,
    actions: [
      { label: 'Renombrar', icon: 'edit', run: () => renameCollection(collection) },
      { label: 'Mover a…', icon: 'move', run: () => moveCollection(collection) },
      { label: 'Eliminar', icon: 'trash', danger: true, run: () => deleteCollection(collection) },
    ],
  });
}

// Devuelve true si la operación ha salido bien.
async function mutate(fn, message) {
  try {
    await fn();
  } catch (err) {
    showError(err);
    return false;
  }
  if (message) toast(message);
  await changed().catch(showError);
  return true;
}

async function renameFolder(folder) {
  const name = await promptText({ title: 'Renombrar carpeta', value: folder.name });
  if (name && name !== folder.name) await mutate(() => api(`/folders/${folder.id}`, { method: 'PATCH', body: { name } }));
}

async function moveFolder(folder) {
  const parentId = await pickFolder({ title: `Mover «${folder.name}» a…`, exclude: descendantFolderIds(folder.id), current: folder.parentId ?? null });
  if (parentId === undefined || parentId === (folder.parentId ?? null)) return;
  await mutate(() => api(`/folders/${folder.id}`, { method: 'PATCH', body: { parentId } }), 'Carpeta movida');
}

async function deleteFolder(folder) {
  const s = folderStats(folder.id);
  const parts = [];
  if (s.folders) parts.push(`${s.folders} subcarpeta${s.folders === 1 ? '' : 's'}`);
  if (s.collections) parts.push(`${s.collections} colección${s.collections === 1 ? '' : 'es'}`);
  const ok = await confirmDialog({
    title: `Eliminar «${folder.name}»`,
    message: (parts.length ? `También se eliminarán ${parts.join(' y ')}. ` : '') + 'Los álbumes seguirán en tu biblioteca.',
    okText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  // Antes de borrar (después ya no estarán en el árbol): ¿la pantalla actual está dentro de esta carpeta?
  const ids = descendantFolderIds(folder.id);
  const [, kind, viewId] = location.hash.match(/^#\/([fc])\/(\d+)/) || [];
  const inside = kind === 'f' ? ids.has(Number(viewId)) : kind === 'c' && ids.has(collectionById(Number(viewId))?.folderId);
  if (!await mutate(() => api(`/folders/${folder.id}`, { method: 'DELETE' }), 'Carpeta eliminada')) return;
  if (inside) location.hash = folder.parentId ? `#/f/${folder.parentId}` : '#/';
}

async function renameCollection(collection) {
  const name = await promptText({ title: 'Renombrar colección', value: collection.name });
  if (name && name !== collection.name) await mutate(() => api(`/collections/${collection.id}`, { method: 'PATCH', body: { name } }));
}

async function moveCollection(collection) {
  const folderId = await pickFolder({ title: `Mover «${collection.name}» a…`, current: collection.folderId ?? null });
  if (folderId === undefined || folderId === (collection.folderId ?? null)) return;
  await mutate(() => api(`/collections/${collection.id}`, { method: 'PATCH', body: { folderId } }), 'Colección movida');
}

async function deleteCollection(collection) {
  const ok = await confirmDialog({
    title: `Eliminar «${collection.name}»`,
    message: 'Los álbumes seguirán en tu biblioteca y en tus otras colecciones.',
    okText: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  if (!await mutate(() => api(`/collections/${collection.id}`, { method: 'DELETE' }), 'Colección eliminada')) return;
  if (location.hash === `#/c/${collection.id}`) location.hash = collection.folderId ? `#/f/${collection.folderId}` : '#/';
}

// ---------- Teselas para la vista de carpeta ----------

export function collectionTile(c) {
  const covers = c.covers.slice(0, 4);
  return h('a', { class: 'tile', href: `#/c/${c.id}` },
    h('div', { class: `mosaic n${covers.length}` },
      covers.length
        ? covers.map((url) => h('img', { src: artwork(url, covers.length === 1 ? 400 : 200), alt: '', loading: 'lazy' }))
        : icon('stack')),
    h('span', { class: 'tile-name' }, c.name),
    h('span', { class: 'tile-sub' }, `${c.albumCount} álbum${c.albumCount === 1 ? '' : 'es'}`));
}

export function folderTile(f) {
  const s = folderStats(f.id);
  const bits = [];
  if (s.folders) bits.push(`${s.folders} carpeta${s.folders === 1 ? '' : 's'}`);
  bits.push(`${s.collections} colección${s.collections === 1 ? '' : 'es'}`);
  return h('a', { class: 'tile', href: `#/f/${f.id}` },
    h('div', { class: 'mosaic folder' }, icon('folder')),
    h('span', { class: 'tile-name' }, f.name),
    h('span', { class: 'tile-sub' }, bits.join(' · ')));
}

export { appleWebUrl, folderById };
