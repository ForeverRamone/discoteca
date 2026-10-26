import { api } from './api.js';
import { h, icon, toast, showError, debounce } from './dom.js';
import {
  state, prefs, changed, appleLink, linkTarget, normalize, sortAlbums,
  folderById, collectionById, childFolders, childCollections, folderPath,
} from './store.js';
import { enableReorder } from './reorder.js';
import { backupSection } from './backup.js';
import {
  albumGrid, coverImg, pickCollections, createFolder, createCollection,
  folderActions, collectionActions, collectionTile, folderTile,
} from './components.js';

// ---------- Piezas comunes ----------

function crumbs(folderId, extra = []) {
  const items = [{ label: 'Inicio', href: '#/' }, ...folderPath(folderId).map((f) => ({ label: f.name, href: `#/f/${f.id}` })), ...extra];
  return h('nav', { class: 'crumbs', 'aria-label': 'Ruta' },
    items.map((it, i) => [i > 0 && h('span', { class: 'crumb-sep' }, '›'), h('a', { href: it.href }, it.label)]));
}

function select(options, value, onChange, label) {
  return h('select', { 'aria-label': label, onchange: (e) => onChange(e.target.value) },
    options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
}

function viewToggle(mode, onChange) {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': 'Vista' },
    h('button', { type: 'button', class: mode === 'grid' ? 'on' : '', 'aria-label': 'Cuadrícula', onclick: () => onChange('grid') }, icon('grid')),
    h('button', { type: 'button', class: mode === 'list' ? 'on' : '', 'aria-label': 'Lista', onclick: () => onChange('list') }, icon('list')));
}

function sizeSlider(onInput) {
  return h('input', {
    type: 'range', min: 90, max: 320, step: 10, value: prefs.get('gridSize', 160),
    class: 'size-slider', 'aria-label': 'Tamaño de las portadas',
    oninput: (e) => {
      prefs.set('gridSize', Number(e.target.value));
      onInput(Number(e.target.value));
    },
  });
}

// Barra de herramientas + cuadrícula que se repinta al cambiar orden o vista.
function albumBrowser({ albums, sortMode, sortOptions, onSort, onReorder, viewKey, ctx, emptyNode, filterable = false }) {
  const body = h('div');
  const count = h('span', { class: 'muted small' });
  let mode = prefs.get(`view:${viewKey}`, 'grid');
  let sort = sortMode;
  let filterText = '';
  let grid;

  const filterInput = filterable && h('input', {
    type: 'search', class: 'filter', placeholder: 'Filtrar por título, artista, género o año', 'aria-label': 'Filtrar álbumes',
    oninput: debounce((e) => { filterText = normalize(e.target.value.trim()); draw(); }, 150),
  });
  const extraFilter = filterable === 'library'
    ? [
      select([['all', 'Todos los orígenes'], ['apple', 'Apple Music'], ['bandcamp', 'Bandcamp']], 'all',
        (v) => { provider = v; draw(); }, 'Origen'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { onlyLoose = e.target.checked; draw(); } }), 'Solo sin colección'),
    ]
    : null;
  let onlyLoose = false;
  let provider = 'all';

  const slider = sizeSlider((size) => grid?.style.setProperty('--cover', `${size}px`));

  function draw() {
    let list = albums;
    if (filterText) list = list.filter((a) => normalize(`${a.title} ${a.artist} ${a.genre ?? ''} ${a.year ?? ''}`).includes(filterText));
    if (onlyLoose) list = list.filter((a) => !a.collectionCount);
    if (provider !== 'all') list = list.filter((a) => (a.provider || 'apple') === provider);
    list = sortAlbums(list, sort);
    count.textContent = `${list.length} álbum${list.length === 1 ? '' : 'es'}${list.length !== albums.length ? ` de ${albums.length}` : ''}`;
    slider.hidden = mode !== 'grid';
    toggleWrap.replaceChildren(viewToggle(mode, (m) => { mode = m; prefs.set(`view:${viewKey}`, m); draw(); }));
    if (!albums.length) return body.replaceChildren(emptyNode);
    if (!list.length) return body.replaceChildren(h('p', { class: 'empty' }, 'Ningún álbum coincide con el filtro.'));
    grid = albumGrid(list, {
      mode,
      size: prefs.get('gridSize', 160),
      ctx: { ...ctx, editing, numbered: !editing && (sort === 'position' || sort === 'original') },
    });
    body.replaceChildren(grid);
  }

  // ---------- Reordenar arrastrando ----------
  let editing = false;
  let sortable = null;

  async function startEdit() {
    editing = true;
    toolbarRow.hidden = true;
    editBar.hidden = false;
    draw(); // parte del orden que estás viendo
    try {
      sortable = await enableReorder(grid);
    } catch (err) {
      showError(err);
      cancelEdit();
    }
  }
  function stopEdit() {
    editing = false;
    sortable?.destroy();
    sortable = null;
    editBar.hidden = true;
    toolbarRow.hidden = false;
  }
  function cancelEdit() {
    stopEdit();
    draw();
  }
  async function saveEdit() {
    const ids = [...grid.children].map((el) => Number(el.dataset.id));
    saveBtn.disabled = true;
    try {
      await onReorder(ids);
      ids.forEach((id, i) => {
        const a = albums.find((x) => x.id === id);
        if (a) a.position = i;
      });
      sort = 'position';
      sortSelect.value = 'position';
      stopEdit();
      draw();
      toast('Orden guardado');
    } catch (err) {
      showError(err);
    }
    saveBtn.disabled = false;
  }

  const saveBtn = h('button', { class: 'btn small primary', type: 'button', onclick: saveEdit }, icon('check'), 'Guardar orden');
  const editBar = h('div', { class: 'edit-bar', hidden: true },
    h('span', { class: 'small' }, 'Arrastra los discos para ordenarlos (en el móvil, mantén pulsado y arrastra).'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn small', type: 'button', onclick: cancelEdit }, 'Cancelar'),
    saveBtn);

  const toggleWrap = h('span');
  const sortSelect = select(sortOptions, sort, (v) => { sort = v; onSort?.(v); draw(); }, 'Ordenar por');
  const toolbarRow = h('div', { class: 'toolbar-row' },
    sortSelect,
    toggleWrap,
    slider,
    extraFilter,
    onReorder && albums.length > 1 && h('button', { class: 'btn small', type: 'button', onclick: startEdit }, icon('move'), 'Reordenar'),
    h('span', { class: 'spacer' }),
    count);
  const toolbar = h('div', { class: 'toolbar' }, filterInput, toolbarRow, editBar);
  draw();
  return h('div', null, toolbar, body);
}

// ---------- Inicio y carpetas ----------

export function folderView(folderId) {
  const folder = folderId ? folderById(folderId) : null;
  if (folderId && !folder) return { title: 'No encontrada', node: h('p', { class: 'empty' }, 'Esta carpeta no existe.') };
  const folders = childFolders(folderId);
  const collections = childCollections(folderId);

  const header = h('div', { class: 'view-head' },
    folder && crumbs(folder.parentId),
    h('div', { class: 'title-row' },
      h('h1', null, folder ? folder.name : 'Inicio'),
      folder && h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Opciones de la carpeta', onclick: () => folderActions(folder) }, icon('more'))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => createCollection(folderId) }, icon('plus'), 'Colección'),
      h('button', { class: 'btn', type: 'button', onclick: () => createFolder(folderId) }, icon('folder'), 'Carpeta'),
      !folder && h('a', { class: 'btn', href: '#/buscar' }, icon('search'), 'Buscar álbumes')));

  let content;
  if (!folders.length && !collections.length) {
    content = h('div', { class: 'empty' },
      h('p', null, folder ? 'Esta carpeta está vacía.' : 'Aún no tienes colecciones.'),
      h('p', { class: 'muted' }, 'Crea una colección (por ejemplo «Modal») y, si quieres, agrúpala en carpetas como «Jazz». Después busca álbumes y añádelos.'));
  } else {
    content = h('div', { class: 'tiles' }, folders.map(folderTile), collections.map(collectionTile));
  }
  return { title: folder ? folder.name : 'Discoteca', node: h('div', null, header, content) };
}

// ---------- Colección ----------

const COLLECTION_SORTS = [
  ['position', 'Orden manual'],
  ['original', 'Posición original'],
  ['artist', 'Artista'],
  ['year', 'Año'],
  ['title', 'Título'],
  ['added', 'Añadidos recientemente'],
];

export async function collectionView(id) {
  const { collection, albums } = await api(`/collections/${id}`);
  const treeItem = collectionById(id) || collection;
  const header = h('div', { class: 'view-head' },
    crumbs(collection.folderId),
    h('div', { class: 'title-row' },
      h('h1', null, collection.name),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Opciones de la colección', onclick: () => collectionActions(treeItem) }, icon('more'))),
    collection.description && h('p', { class: 'muted description' }, collection.description),
    (collection.sourceUrl || collection.importJobId) && h('p', { class: 'muted small source-line' },
      collection.sourceUrl && h('a', { href: collection.sourceUrl, target: '_blank', rel: 'noopener' }, icon('external'), 'Lista original en Record Club'),
      collection.importJobId && h('a', { href: `#/importar/${collection.importJobId}` }, icon('download'),
        collection.reviewCount ? `${collection.reviewCount} por revisar` : 'Ver importación'),
      collection.lastSyncedAt && h('span', null, `Actualizada el ${new Date(collection.lastSyncedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}`)),
    h('div', { class: 'actions' },
      h('a', { class: 'btn primary', href: `#/buscar?to=${id}` }, icon('plus'), 'Añadir álbumes'),
      collection.sourceType === 'recordclub' && collection.sourceUrl && h('button', {
        class: 'btn', type: 'button',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const res = await api('/imports/sync', { method: 'POST', body: { collectionId: id } });
            location.hash = `#/importar/${res.id}`;
          } catch (err) {
            showError(err);
            e.currentTarget.disabled = false;
          }
        },
      }, icon('refresh'), 'Actualizar desde Record Club')));

  const empty = h('div', { class: 'empty' },
    h('p', null, 'Esta colección está vacía.'),
    h('p', { class: 'muted' }, 'Busca un álbum o pega un enlace de Apple Music para añadirlo.'),
    h('a', { class: 'btn primary', href: `#/buscar?to=${id}` }, icon('plus'), 'Añadir álbumes'));

  const browser = albumBrowser({
    albums,
    sortMode: collection.sortMode,
    sortOptions: COLLECTION_SORTS,
    onSort: (sortMode) => api(`/collections/${id}`, { method: 'PATCH', body: { sortMode } }).catch(showError),
    onReorder: async (albumIds) => {
      await api(`/collections/${id}/order`, { method: 'PUT', body: { albumIds } });
      await api(`/collections/${id}`, { method: 'PATCH', body: { sortMode: 'position' } });
    },
    viewKey: `c${id}`,
    ctx: { collectionId: id },
    emptyNode: empty,
  });
  return { title: collection.name, node: h('div', null, header, browser) };
}

// ---------- Biblioteca ----------

export async function libraryView() {
  const { albums } = await api('/albums');
  const header = h('div', { class: 'view-head' },
    h('div', { class: 'title-row' }, h('h1', null, 'Biblioteca')),
    h('p', { class: 'muted' }, 'Todos los álbumes guardados, estén en una o en varias colecciones.'));
  const empty = h('div', { class: 'empty' },
    h('p', null, 'Tu biblioteca está vacía.'),
    h('a', { class: 'btn primary', href: '#/buscar' }, icon('search'), 'Buscar álbumes'));
  const browser = albumBrowser({
    albums,
    sortMode: prefs.get('librarySort', 'added'),
    sortOptions: [['added', 'Añadidos recientemente'], ['artist', 'Artista'], ['year', 'Año'], ['title', 'Título']],
    onSort: (v) => prefs.set('librarySort', v),
    viewKey: 'library',
    ctx: {},
    emptyNode: empty,
    filterable: 'library',
  });
  return { title: 'Biblioteca', node: h('div', null, header, browser) };
}

// ---------- Búsqueda en Apple Music ----------

const isSingleOrEp = (a) => /\s-\s(Single|EP)$/i.test(a.title);

export async function searchView(params) {
  const q = params.get('q') || '';
  const artistId = params.get('artist');
  const artistName = params.get('name') || '';
  const toId = params.get('to') ? Number(params.get('to')) : null;
  const target = toId ? collectionById(toId) : null;

  const buildHash = (p) => {
    const sp = new URLSearchParams(p);
    if (toId) sp.set('to', toId);
    return `#/buscar?${sp}`;
  };

  const input = h('input', {
    type: 'search', value: q, placeholder: 'Artista, álbum o enlace de Apple Music o Bandcamp', 'aria-label': 'Buscar',
    autocomplete: 'off', enterkeyhint: 'search',
  });
  const form = h('form', {
    class: 'search-form',
    onsubmit: (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v.length >= 2) location.hash = buildHash({ q: v });
    },
  }, input, h('button', { class: 'btn primary', type: 'submit' }, icon('search'), 'Buscar'));

  let includeSingles = prefs.get('includeSingles', false);
  const results = h('div', { class: 'results' });
  const status = h('p', { class: 'muted small' });

  const header = h('div', { class: 'view-head' },
    target && crumbs(target.folderId, [{ label: target.name, href: `#/c/${target.id}` }]),
    h('div', { class: 'title-row' }, h('h1', null, target ? `Añadir a «${target.name}»` : 'Buscar en Apple Music')),
    form,
    h('div', { class: 'toolbar-row' },
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: includeSingles, onchange: (e) => { includeSingles = e.target.checked; prefs.set('includeSingles', includeSingles); draw(); } }),
        'Incluir singles y EP'),
      h('span', { class: 'spacer' }),
      status));

  let items = [];
  let kind = 'search';

  function draw() {
    const visible = kind === 'link' || includeSingles ? items : items.filter((a) => !isSingleOrEp(a));
    const hidden = items.length - visible.length;
    status.textContent = items.length ? `${visible.length} resultado${visible.length === 1 ? '' : 's'}${hidden ? ` · ${hidden} singles/EP ocultos` : ''}` : '';
    results.replaceChildren(...visible.map(resultRow));
    if (!visible.length && (q || artistId)) {
      results.append(h('div', { class: 'empty' },
        h('p', null, items.length ? 'Solo hay singles o EP. Marca «Incluir singles y EP» para verlos.' : 'Sin resultados.'),
        h('p', { class: 'muted' }, 'Consejo: la búsqueda de Apple no siempre encuentra todos los discos. Busca solo el artista y pulsa su nombre para ver su discografía completa.')));
    }
  }

  function resultRow(album) {
    const inTarget = () => target && album.collectionIds.includes(target.id);
    const badge = h('span', { class: 'badge' });
    const updateBadge = () => {
      const n = album.collectionIds.length;
      badge.textContent = album.saved ? (n ? `En ${n} colección${n === 1 ? '' : 'es'}` : 'En biblioteca') : '';
      badge.hidden = !album.saved;
    };
    updateBadge();

    const addBtn = target && h('button', { class: 'btn primary small', type: 'button' });
    const updateAddBtn = () => {
      if (!addBtn) return;
      addBtn.replaceChildren(icon(inTarget() ? 'check' : 'plus'), inTarget() ? 'Añadido' : 'Añadir');
      addBtn.disabled = inTarget();
    };
    updateAddBtn();
    addBtn?.addEventListener('click', async () => {
      addBtn.disabled = true;
      try {
        const res = await api('/albums', { method: 'POST', body: { id: album.id, addTo: [target.id] } });
        Object.assign(album, { saved: true, collectionIds: res.collectionIds });
        toast(`Añadido a «${target.name}»`);
        await changed();
      } catch (err) {
        showError(err);
      }
      updateAddBtn();
      updateBadge();
    });

    const pickBtn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
      const ids = await pickCollections({ title: `Guardar «${album.title}» en…`, selected: album.collectionIds });
      if (!ids) return;
      try {
        const res = await api('/albums', { method: 'POST', body: { id: album.id, collectionIds: ids } });
        Object.assign(album, { saved: true, collectionIds: res.collectionIds });
        toast(ids.length ? 'Guardado' : 'Guardado en la biblioteca');
        await changed();
      } catch (err) {
        showError(err);
      }
      updateAddBtn();
      updateBadge();
    } }, icon('stack'), target ? 'Otras…' : 'Añadir…');

    const meta = [album.year, album.trackCount && `${album.trackCount} pistas`, album.genre].filter(Boolean).join(' · ');
    return h('div', { class: 'result' },
      h('a', { class: 'result-cover', href: appleLink(album), ...linkTarget(album), title: `Abrir en ${album.provider === 'bandcamp' ? 'Bandcamp' : 'Apple Music'}` }, coverImg(album, 88)),
      h('div', { class: 'result-text' },
        h('span', { class: 'row-title' }, album.title),
        album.artistId && !artistId
          ? h('a', { class: 'artist-link', href: buildHash({ artist: album.artistId, name: album.artist }), title: 'Ver discografía completa' }, album.artist)
          : h('span', { class: 'row-sub' }, album.artist),
        h('span', { class: 'muted small' }, meta),
        badge),
      h('div', { class: 'result-actions' }, addBtn, pickBtn));
  }

  const node = h('div', null, header, results);

  if (artistId) {
    header.querySelector('h1').after(h('p', { class: 'muted' }, `Discografía de ${artistName}`));
    status.textContent = 'Cargando…';
    try {
      ({ results: items } = await api(`/artists/${artistId}/albums`));
      kind = 'artist';
    } catch (err) {
      showError(err);
    }
    draw();
  } else if (q) {
    status.textContent = 'Buscando…';
    try {
      const res = await api(`/search?q=${encodeURIComponent(q)}`);
      items = res.results;
      kind = res.kind;
      if (res.error) toast(res.error, { error: true });
    } catch (err) {
      showError(err);
    }
    draw();
  } else {
    results.append(h('div', { class: 'empty' },
      h('p', { class: 'muted' }, 'Escribe un artista o un álbum, o pega un enlace de Apple Music (en la app Música: Compartir › Copiar enlace).'),
      h('p', { class: 'muted small' }, 'Si un disco no está en Apple Music, pega el enlace de su página de Bandcamp (https://artista.bandcamp.com/album/…).')));
    setTimeout(() => input.focus(), 50);
  }
  return { title: 'Buscar', node };
}

// ---------- Ajustes ----------

export function settingsView({ onLogout }) {
  const radio = (name, value, current, label, hint, onChange) =>
    h('label', { class: 'radio' },
      h('input', { type: 'radio', name, value, checked: value === current, onchange: () => onChange(value) }),
      h('span', null, h('strong', null, label), hint && h('span', { class: 'muted small block' }, hint)));

  const setLink = (v) => { prefs.set('linkMode', v); toast('Guardado en este dispositivo'); };
  const setTap = (v) => { prefs.set('coverTap', v); toast('Guardado en este dispositivo'); };
  const linkMode = prefs.get('linkMode', 'app');
  const tapMode = prefs.get('coverTap', 'open');

  const sample = { id: 268443092, title: 'Kind of Blue', appleUrl: `https://music.apple.com/${state.country}/album/kind-of-blue/268443092` };

  const node = h('div', { class: 'settings' },
    h('div', { class: 'view-head' }, h('div', { class: 'title-row' }, h('h1', null, 'Ajustes'))),
    h('p', { class: 'muted' }, 'Estos ajustes se guardan en cada dispositivo, porque el iPhone y el Mac pueden necesitar opciones distintas.'),

    h('section', { class: 'card-section' },
      h('h2', null, 'Cómo abrir los álbumes'),
      radio('linkMode', 'app', linkMode, 'App Música (music://)', 'Abre directamente la app Música en iPhone y Mac.', setLink),
      radio('linkMode', 'web', linkMode, 'Enlace web (https://music.apple.com)', 'El sistema decide: puede abrir la app o la web de Apple Music.', setLink),
      h('p', { class: 'muted small' }, 'Prueba ambos con «Kind of Blue» y quédate con el que funcione mejor en este dispositivo:'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: sample.appleUrl.replace(/^https:\/\//, 'music://') }, icon('play'), 'Probar music://'),
        h('a', { class: 'btn', href: sample.appleUrl, target: '_blank', rel: 'noopener' }, icon('external'), 'Probar https://'))),

    h('section', { class: 'card-section' },
      h('h2', null, 'Al tocar una portada'),
      radio('coverTap', 'open', tapMode, 'Abrir en Apple Music', 'La ficha del álbum sigue disponible con el botón ⋯ o tocando el título.', setTap),
      radio('coverTap', 'details', tapMode, 'Mostrar la ficha del álbum', null, setTap)),

    backupSection(),

    state.authRequired && h('section', { class: 'card-section' },
      h('h2', null, 'Sesión'),
      h('button', { class: 'btn', type: 'button', onclick: onLogout }, icon('logout'), 'Cerrar sesión')),

    h('p', { class: 'muted small' }, `Tienda de Apple Music: ${state.country.toUpperCase()} · Discoteca 0.1`));
  return { title: 'Ajustes', node };
}
