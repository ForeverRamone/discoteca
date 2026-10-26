import { api } from './api.js';
import { h, icon, fill, toast, showError, openDialog, dialogHeader, confirmDialog, promptText } from './dom.js';
import { prefs, changed, appleLink, linkTarget, folderById, folderPath } from './store.js';
import { coverImg, pickFolder } from './components.js';

const STATUS_TEXT = {
  fetching: 'Leyendo la lista',
  matching: 'Emparejando',
  done: 'Terminada',
  error: 'Error',
};

const METHOD_TEXT = {
  memory: 'recordado',
  link: 'enlace de Record Club',
  search: 'búsqueda',
  artist: 'discografía',
  user: 'elegido por ti',
  bandcamp: 'Bandcamp (no está en Apple Music)',
};

// Abre el buscador de Bandcamp en tu navegador: lo usas tú, no la app.
const bandcampSearchUrl = (it) => `https://bandcamp.com/search?q=${encodeURIComponent(`${it.artist} ${it.title}`)}&item_type=a`;
const bandcampButtons = (it, onPaste) => [
  h('a', { class: 'btn small', href: bandcampSearchUrl(it), target: '_blank', rel: 'noopener' }, icon('external'), 'Buscar en Bandcamp'),
  h('button', { class: 'btn small', type: 'button', onclick: onPaste }, icon('plus'), 'Pegar enlace de Bandcamp…'),
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Un trabajo recién creado está «leyendo» pero sin detalle: aún espera su turno.
const isQueued = (job) => job.status === 'fetching' && !job.detail;
const statusText = (job) => (isQueued(job) ? 'En cola' : STATUS_TEXT[job.status] || job.status);

function folderButton(state) {
  const label = h('span');
  const update = () => {
    label.textContent = state.folderId ? folderPath(state.folderId).map((f) => f.name).join(' › ') : 'Inicio (sin carpeta)';
  };
  update();
  return h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const id = await pickFolder({ title: 'Guardar la colección en…', current: state.folderId });
      if (id === undefined) return;
      state.folderId = id;
      prefs.set('importFolder', id);
      update();
    },
  }, icon('folder'), label);
}

// ---------- Pantalla principal de importación ----------

export async function importView() {
  const state = { folderId: folderById(prefs.get('importFolder', null)) ? prefs.get('importFolder', null) : null };
  let tab = prefs.get('importTab', 'recordclub');
  const panel = h('div');

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const drawTabs = () => {
    fill(tabs, 
      ...[['recordclub', 'Record Club'], ['text', 'Texto, CSV o Excel']].map(([key, label]) =>
        h('button', {
          type: 'button', role: 'tab', class: tab === key ? 'on' : '', 'aria-selected': String(tab === key),
          onclick: () => { tab = key; prefs.set('importTab', key); drawTabs(); drawPanel(); },
        }, label)),
    );
  };

  // Envía una o varias URL; las listas ya importadas se actualizan en lugar de duplicarse.
  async function submitUrls(urls, button) {
    button.disabled = true;
    try {
      const res = await api('/imports', { method: 'POST', body: { source: 'recordclub', urls, folderId: state.folderId } });
      for (const e of res.errors || []) toast(e.error, { error: true });
      if (res.jobs.length === 1) {
        location.hash = `#/importar/${res.jobs[0].id}`;
        return;
      }
      const updates = res.jobs.filter((j) => j.mode === 'sync').length;
      const news = res.jobs.length - updates;
      toast([news && plural(news, 'lista nueva', 'listas nuevas'), updates && plural(updates, 'actualización', 'actualizaciones')].filter(Boolean).join(' y ') + ' en cola');
      await refreshHistory();
    } catch (err) {
      showError(err);
    }
    button.disabled = false;
  }

  function recordClubForm() {
    const urls = h('textarea', {
      rows: 3, 'aria-label': 'URL de las listas', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'https://record.club/usuario/lists/nombre-de-la-lista\n(una URL por línea para importar varias)',
    });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, icon('download'), 'Importar');
    const form = h('form', {
      class: 'card-section',
      onsubmit: (e) => {
        e.preventDefault();
        const list = urls.value.split(/\s+/).map((u) => u.trim()).filter(Boolean);
        if (!list.length) return showError(new Error('Pega al menos una URL.'));
        submitUrls(list, submit);
      },
    },
    h('label', { class: 'field-label' }, 'URL de una o varias listas públicas (una por línea)'),
    urls,
    h('label', { class: 'field-label' }, 'Carpeta de destino'),
    h('div', null, folderButton(state)),
    h('p', { class: 'muted small' }, 'Cada lista se convierte en una colección con su título, descripción y orden. Si una lista ya estaba importada, se actualiza: solo se añaden los discos nuevos.'),
    h('div', { class: 'actions' }, submit));

    return h('div', null, form, myListsSection(), syncAllSection());
  }

  // Tus listas de Record Club: elegir cuáles importar.
  function myListsSection() {
    const user = h('input', { type: 'text', value: prefs.get('rcUser', ''), placeholder: 'Tu usuario de Record Club', 'aria-label': 'Usuario de Record Club', autocomplete: 'off' });
    const body = h('div');
    const load = h('button', { class: 'btn', type: 'submit' }, 'Ver listas');

    async function loadLists() {
      const name = user.value.trim().replace(/^@/, '').replace(/^https?:\/\/record\.club\//i, '').split('/')[0];
      if (!name) return;
      prefs.set('rcUser', name);
      load.disabled = true;
      fill(body, h('p', { class: 'muted small' }, 'Cargando listas…'));
      try {
        const { lists } = await api(`/imports/recordclub/${encodeURIComponent(name)}/lists`);
        drawLists(lists);
      } catch (err) {
        fill(body, h('p', { class: 'error small' }, err.message));
      }
      load.disabled = false;
    }

    function drawLists(lists) {
      const selected = new Set();
      const go = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('download'), 'Importar seleccionadas');
      const updateGo = () => {
        go.disabled = !selected.size;
        go.replaceChildren(icon('download'), selected.size ? `Importar seleccionadas (${selected.size})` : 'Importar seleccionadas');
      };
      const boxes = [];
      const rows = lists.map((l) => {
        const box = h('input', {
          type: 'checkbox',
          onchange: (e) => { e.target.checked ? selected.add(l.url) : selected.delete(l.url); updateGo(); },
        });
        boxes.push([box, l]);
        return h('label', { class: 'pick-item' },
          box,
          h('span', { class: 'pick-text' },
            h('span', null, l.title),
            h('span', { class: 'muted small' },
              plural(l.itemCount, 'disco', 'discos'),
              l.collectionId ? ' · ya importada (se actualizará)' : '')),
          l.collectionId && h('a', { class: 'chip', href: `#/c/${l.collectionId}`, onclick: (e) => e.stopPropagation() }, icon('stack'), 'Ver'));
      });
      const setAll = (pred) => {
        for (const [box, l] of boxes) {
          box.checked = pred(l);
          box.checked ? selected.add(l.url) : selected.delete(l.url);
        }
        updateGo();
      };
      go.addEventListener('click', () => submitUrls([...selected], go));
      const total = lists.reduce((n, l) => n + (l.itemCount || 0), 0);
      fill(body,
        h('div', { class: 'toolbar-row' },
          h('span', { class: 'muted small' }, `${plural(lists.length, 'lista pública', 'listas públicas')} · ${total} discos en total`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', type: 'button', onclick: () => setAll((l) => !l.collectionId) }, 'Marcar las nuevas'),
          h('button', { class: 'btn small', type: 'button', onclick: () => setAll(() => false) }, 'Ninguna')),
        h('div', { class: 'pick-list tall' }, rows),
        h('p', { class: 'muted small' }, 'Las listas se importan de una en una, en segundo plano. Las muy largas (cientos de discos) pueden tardar media hora.'),
        h('div', { class: 'actions' }, go));
    }

    if (user.value) setTimeout(loadLists, 0);
    return h('form', { class: 'card-section', onsubmit: (e) => { e.preventDefault(); loadLists(); } },
      h('h2', null, 'Tus listas de Record Club'),
      h('div', { class: 'new-row' }, user, load),
      body);
  }

  function syncAllSection() {
    const btn = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Actualizar todas');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api('/imports/sync', { method: 'POST', body: { all: true } });
        toast(`${plural(res.jobs.length, 'colección', 'colecciones')} en cola para actualizar`);
        await refreshHistory();
      } catch (err) {
        showError(err);
      }
      btn.disabled = false;
    });
    return h('section', { class: 'card-section' },
      h('h2', null, 'Actualizar desde Record Club'),
      h('p', { class: 'muted small' }, 'Vuelve a leer todas las listas importadas y añade solo los discos nuevos. Tus emparejamientos y el orden se conservan. También puedes actualizar una sola colección desde su página, o activar la actualización automática con AUTO_SYNC_HOURS.'),
      h('div', { class: 'actions' }, btn));
  }

  function textForm() {
    const name = h('input', { type: 'text', placeholder: 'Nombre de la colección', maxlength: 200, 'aria-label': 'Nombre de la colección' });
    const order = h('select', { 'aria-label': 'Formato' },
      h('option', { value: 'artist-title' }, 'Artista – Álbum'),
      h('option', { value: 'title-artist' }, 'Álbum – Artista'));
    const text = h('textarea', { rows: 10, placeholder: 'Miles Davis – Kind of Blue\nJohn Coltrane – A Love Supreme (1965)\n…', 'aria-label': 'Lista de discos' });
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx', 'aria-label': 'Archivo CSV o Excel' });
    const preview = h('div');
    const submit = h('button', { class: 'btn primary', type: 'button' }, icon('download'), 'Importar');
    let upload = null; // { filename, data | text }

    file.addEventListener('change', async () => {
      const f = file.files[0];
      upload = null;
      if (!f) return;
      if (f.size > 10 * 1024 * 1024) return showError(new Error('El archivo es demasiado grande (máximo 10 MB).'));
      if (!name.value.trim()) name.value = f.name.replace(/\.[^.]+$/, '');
      if (/\.xlsx$/i.test(f.name)) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        upload = { filename: f.name, data: btoa(bin) };
      } else {
        upload = { filename: f.name, text: await f.text() };
      }
      text.value = '';
      runPreview();
    });
    text.addEventListener('input', () => { upload = null; file.value = ''; });

    const payload = () => upload ? { ...upload, order: order.value } : { filename: 'lista.txt', text: text.value, order: order.value };

    async function runPreview() {
      try {
        const p = await api('/imports/preview', { method: 'POST', body: payload() });
        fill(preview, 
          h('p', null, h('strong', null, plural(p.count, 'disco reconocido', 'discos reconocidos')),
            p.skipped ? h('span', { class: 'muted' }, ` · ${plural(p.skipped, 'línea ignorada', 'líneas ignoradas')}`) : null),
          p.sample.length
            ? h('ol', { class: 'preview-list' }, p.sample.map((it) => h('li', null, h('strong', null, it.artist), ' – ', it.title, it.year ? ` (${it.year})` : '')))
            : null,
          p.count > p.sample.length ? h('p', { class: 'muted small' }, '…') : null);
        return p;
      } catch (err) {
        showError(err);
        return null;
      }
    }
    order.addEventListener('change', () => (upload || text.value.trim()) && runPreview());

    submit.addEventListener('click', async () => {
      if (!name.value.trim()) return showError(new Error('Ponle un nombre a la colección.'));
      if (!upload && !text.value.trim()) return showError(new Error('Pega una lista o elige un archivo.'));
      submit.disabled = true;
      try {
        const { id } = await api('/imports', {
          method: 'POST',
          body: { source: upload ? 'file' : 'text', name: name.value.trim(), folderId: state.folderId, ...payload() },
        });
        location.hash = `#/importar/${id}`;
      } catch (err) {
        showError(err);
        submit.disabled = false;
      }
    });

    return h('div', { class: 'card-section' },
      h('label', { class: 'field-label' }, 'Nombre de la colección'), name,
      h('label', { class: 'field-label' }, 'Carpeta de destino'), h('div', null, folderButton(state)),
      h('label', { class: 'field-label' }, 'Formato de cada línea'), h('div', null, order),
      h('label', { class: 'field-label' }, 'Pega la lista (un disco por línea)…'), text,
      h('label', { class: 'field-label' }, '…o sube un archivo CSV o Excel (.xlsx)'), file,
      h('p', { class: 'muted small' }, 'En CSV y Excel se reconocen las columnas «Artista», «Álbum», «Año» y «Posición». Sin cabecera, se usan las columnas en ese orden.'),
      preview,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: runPreview }, 'Vista previa'),
        submit));
  }

  const drawPanel = () => fill(panel, tab === 'recordclub' ? recordClubForm() : textForm());
  drawTabs();
  drawPanel();

  // Historial, que se refresca solo mientras haya importaciones en marcha.
  const history = h('section');
  let historyTimer = null;
  async function refreshHistory() {
    clearTimeout(historyTimer);
    if (!root.isConnected && history.childElementCount) return;
    try {
      const { jobs } = await api('/imports');
      fill(history, jobs.length ? [
        h('h2', { class: 'section-title' }, 'Importaciones'),
        h('div', { class: 'job-list' }, jobs.map(jobRow)),
      ] : null);
      if (jobs.some((j) => j.status === 'fetching' || j.status === 'matching')) historyTimer = setTimeout(refreshHistory, 3000);
    } catch (err) {
      if (err.status !== 401) showError(err);
    }
  }

  const root = h('div', { class: 'import-view' },
    h('div', { class: 'view-head' }, h('div', { class: 'title-row' }, h('h1', null, 'Importar listas'))),
    tabs, panel, history);
  await refreshHistory();
  return { title: 'Importar', node: root };
}

function countsLine(c) {
  const parts = [];
  if (c.matched) parts.push(h('span', { class: 'ok' }, icon('check'), c.matched));
  if (c.review) parts.push(h('span', { class: 'warn' }, '?', c.review));
  if (c.notFound) parts.push(h('span', { class: 'bad' }, icon('close'), c.notFound));
  if (c.pending) parts.push(h('span', { class: 'muted' }, `${c.pending} pendientes`));
  return h('span', { class: 'counts' }, parts);
}

function jobRow(job) {
  return h('a', { class: 'job-row', href: `#/importar/${job.id}` },
    h('span', { class: 'job-icon' }, icon(job.sourceType === 'recordclub' ? 'disc' : 'list')),
    h('span', { class: 'job-text' },
      h('span', { class: 'row-title' }, job.title || job.sourceUrl || 'Importación'),
      h('span', { class: 'muted small' },
        [job.mode === 'sync' ? 'Actualización' : 'Importación', statusText(job),
          job.status === 'done' && job.detail, new Date(job.createdAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })]
          .filter(Boolean).join(' · '))),
    countsLine(job.counts));
}

// ---------- Elegir un álbum a mano ----------

function chooseAlbum(item) {
  return openDialog((close) => {
    const input = h('input', { type: 'search', value: `${item.artist} ${item.title}`, 'aria-label': 'Buscar en Apple Music', enterkeyhint: 'search' });
    const list = h('div', { class: 'choose-list' });
    const status = h('p', { class: 'muted small' });

    const option = (album) =>
      h('div', { class: 'choose-row' },
        h('a', { class: 'result-cover small', href: appleLink(album), ...linkTarget(album), title: 'Abrir en Apple Music' }, coverImg(album, 64)),
        h('span', { class: 'result-text' },
          h('span', { class: 'row-title' }, album.title),
          album.artistId
            ? h('button', { class: 'artist-link plain', type: 'button', onclick: () => loadArtist(album.artistId, album.artist) }, album.artist)
            : h('span', { class: 'row-sub' }, album.artist),
          h('span', { class: 'muted small' }, [album.provider === 'bandcamp' && 'Bandcamp', album.year, album.trackCount && `${album.trackCount} pistas`, album.score != null && `${Math.round(album.score * 100)} %`].filter(Boolean).join(' · '))),
        h('button', { class: 'btn small primary', type: 'button', onclick: () => close({ appleId: album.id }) }, 'Elegir'));

    const show = (albums, label) => {
      status.textContent = label;
      fill(list, ...albums.map(option));
      if (!albums.length) list.append(h('p', { class: 'muted pad' }, 'Sin resultados. Prueba solo con el artista y pulsa su nombre para ver la discografía.'));
    };
    const run = async () => {
      status.textContent = 'Buscando…';
      try {
        const { results } = await api(`/search?q=${encodeURIComponent(input.value.trim())}`);
        show(results, `${plural(results.length, 'resultado', 'resultados')} en Apple Music`);
      } catch (err) {
        status.textContent = err.message;
      }
    };
    async function loadArtist(id, name) {
      status.textContent = 'Cargando discografía…';
      try {
        const { results } = await api(`/artists/${id}/albums`);
        show(results, `Discografía de ${name}`);
      } catch (err) {
        status.textContent = err.message;
      }
    }

    if (item.candidates.length) show(item.candidates, 'Mejores opciones encontradas');
    else run();

    return h('div', { class: 'picker' },
      dialogHeader(`${item.artist} – ${item.title}`, close),
      h('div', { class: 'dlg-body' },
        h('form', { class: 'search-form', onsubmit: (e) => { e.preventDefault(); run(); } },
          input, h('button', { class: 'btn', type: 'submit', 'aria-label': 'Buscar' }, icon('search'))),
        status,
        list,
        h('p', { class: 'muted small' }, 'También puedes pegar arriba el enlace de una página de Bandcamp.'),
        h('div', { class: 'dlg-actions wrap' },
          h('a', { class: 'btn', href: bandcampSearchUrl(item), target: '_blank', rel: 'noopener' }, icon('external'), 'Buscar en Bandcamp'),
          h('button', { class: 'btn danger-text', type: 'button', onclick: () => close({ notFound: true }) }, 'No está en ningún sitio'))));
  }, { className: 'wide' });
}

// ---------- Detalle y revisión de una importación ----------

export async function importJobView(id) {
  let { job } = await api(`/imports/${id}`);
  let items = [];
  let tab = null;

  const head = h('div', { class: 'view-head' });
  const summary = h('div', { class: 'summary' });
  const syncBox = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const list = h('div', { class: 'import-items' });
  const root = h('div', { class: 'import-view' }, head, syncBox, summary, tabs, list);

  async function loadItems() {
    ({ items } = await api(`/imports/${id}/items`));
  }

  function drawHead() {
    const c = job.counts;
    const busy = job.status === 'fetching' || job.status === 'matching';
    const processed = c.total - c.pending;
    fill(head, 
      h('nav', { class: 'crumbs' }, h('a', { href: '#/importar' }, 'Importar')),
      h('div', { class: 'title-row' }, h('h1', null, job.title || 'Importación')),
      job.mode === 'sync' && h('p', { class: 'muted small' }, `Actualización del ${new Date(job.createdAt).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' })}`),
      job.sourceUrl && h('a', { class: 'muted small source-link', href: job.sourceUrl, target: '_blank', rel: 'noopener' }, icon('external'), job.sourceUrl),
      busy && h('div', { class: 'progress' },
        h('div', { class: 'progress-bar', vars: { '--p': c.total ? `${(processed / c.total) * 100}%` : '5%' } }),
        h('span', { class: 'muted small' }, isQueued(job) ? 'En cola: empezará cuando terminen las importaciones anteriores.' : job.detail || STATUS_TEXT[job.status])),
      job.status === 'error' && h('div', { class: 'card-section error-box' },
        h('p', null, job.error),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh'), 'Reintentar'),
          h('a', { class: 'btn', href: '#/importar' }, 'Importar como texto o CSV'))),
      h('div', { class: 'actions' },
        job.collectionId && h('a', { class: 'btn primary', href: `#/c/${job.collectionId}` }, icon('stack'), 'Ver colección'),
        c.review > 0 && h('button', { class: 'btn', type: 'button', onclick: acceptAll }, icon('check'), 'Aceptar sugerencias ≥ 80 %'),
        c.notFound > 0 && h('a', { class: 'btn', href: `/api/imports/${id}/no-encontrados.csv`, download: '' }, icon('download'), 'Exportar no encontrados'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Eliminar este registro de importación', title: 'Eliminar registro', onclick: removeJob }, icon('trash'))));

    const info = job.mode === 'sync' ? job.info : null;
    // Una actualización sin discos nuevos no necesita cifras ni pestañas.
    const nothingNew = job.mode === 'sync' && job.status === 'done' && !job.counts.total;
    summary.hidden = tabs.hidden = list.hidden = nothingNew;
    fill(syncBox, info && h('div', { class: 'card-section' },
      h('p', null, h('strong', null, 'Actualización: '),
        [plural(info.newCount, 'disco nuevo', 'discos nuevos'), `${info.keptCount} ya estaban`,
          info.removedCount && `${plural(info.removedCount, 'disco ya no está', 'discos ya no están')} en la lista`].filter(Boolean).join(' · ')),
      info.append && h('p', { class: 'muted small' }, 'Como habías reordenado la colección a mano, los discos nuevos se han añadido al final.'),
      info.removedCount > 0 && h('details', null,
        h('summary', { class: 'muted small' }, 'Discos que ya no están en Record Club (se mantienen en la colección)'),
        h('ul', { class: 'preview-list' }, info.removed.map((r) => h('li', null, h('strong', null, r.artist), ' – ', r.title))))));
    fill(summary, 
      stat(c.auto, 'emparejados automáticamente', 'ok'),
      stat(c.user, 'elegidos por ti', 'ok'),
      stat(c.review, 'por revisar', 'warn'),
      stat(c.notFound, 'no encontrados', 'bad'),
      c.pending ? stat(c.pending, 'pendientes', '') : null);
  }

  const stat = (n, label, cls) => h('div', { class: `stat ${cls}` }, h('strong', null, n), h('span', null, label));

  function drawTabs() {
    const c = job.counts;
    if (!tab) tab = c.review ? 'review' : 'all';
    const defs = [['review', `Por revisar (${c.review})`], ['matched', `Emparejados (${c.matched})`], ['not_found', `No encontrados (${c.notFound})`], ['all', `Todos (${c.total})`]];
    fill(tabs, ...defs.map(([key, label]) =>
      h('button', { type: 'button', role: 'tab', class: tab === key ? 'on' : '', onclick: () => { tab = key; drawTabs(); drawList(); } }, label)));
  }

  function drawList() {
    const shown = tab === 'all' ? items : items.filter((it) => it.status === tab);
    fill(list, ...shown.map(itemRow));
    if (!shown.length) {
      list.append(h('p', { class: 'empty muted' },
        tab === 'review' ? (job.counts.pending ? 'De momento no hay nada que revisar.' : 'No queda nada por revisar.') : 'No hay discos en esta pestaña.'));
    }
  }

  function sourceLine(it) {
    return h('div', { class: 'item-source' },
      h('span', { class: 'item-pos' }, it.position + 1),
      h('span', { class: 'item-src-text' },
        h('strong', null, it.title), h('span', { class: 'muted' }, ` · ${it.artist}${it.year ? ` · ${it.year}` : ''}`)),
      it.sourceUrl && h('a', { class: 'icon-btn small', href: it.sourceUrl, target: '_blank', rel: 'noopener', 'aria-label': 'Ver en Record Club', title: 'Ver en Record Club' }, icon('external')));
  }

  function itemRow(it) {
    const row = h('div', { class: `import-item ${it.status}` }, sourceLine(it));
    if (it.status === 'pending') {
      row.append(h('p', { class: 'muted small item-note' }, 'Pendiente…'));
    } else if (it.status === 'matched' && it.album) {
      row.append(h('div', { class: 'item-match' },
        h('a', { class: 'result-cover small', href: appleLink(it.album), ...linkTarget(it.album) }, coverImg(it.album, 56)),
        h('span', { class: 'result-text' },
          h('span', { class: 'row-title' }, it.album.title),
          h('span', { class: 'row-sub' }, it.album.artist),
          h('span', { class: 'muted small' }, [it.album.year, it.album.trackCount && `${it.album.trackCount} pistas`, METHOD_TEXT[it.method]].filter(Boolean).join(' · '))),
        h('button', { class: 'btn small', type: 'button', onclick: () => change(it) }, 'Cambiar')));
    } else if (it.status === 'not_found') {
      row.append(h('div', { class: 'item-match' },
        h('span', { class: 'muted small spacer' }, it.method === 'memory' ? 'Marcado antes como no disponible.' : 'No está en Apple Music ni en Bandcamp.'),
        h('button', { class: 'btn small', type: 'button', onclick: () => change(it) }, icon('search'), 'Buscar…'),
        ...bandcampButtons(it, () => pasteBandcamp(it))));
    } else {
      row.append(
        it.candidates.length
          ? h('div', { class: 'candidates' }, it.candidates.map((cand) =>
            h('button', { class: 'candidate', type: 'button', title: 'Elegir este álbum', onclick: () => resolve(it, { appleId: cand.id }) },
              coverImg(cand, 72),
              h('span', { class: 'cand-title' }, cand.title),
              h('span', { class: 'cand-sub' }, cand.artist),
              h('span', { class: 'cand-meta' }, [cand.year, cand.trackCount && `${cand.trackCount} p.`, `${Math.round(cand.score * 100)} %`].filter(Boolean).join(' · ')))))
          : h('p', { class: 'muted small item-note' }, 'No he encontrado candidatos.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn small', type: 'button', onclick: () => change(it) }, icon('search'), 'Buscar…'),
          ...bandcampButtons(it, () => pasteBandcamp(it)),
          h('button', { class: 'btn small danger-text', type: 'button', onclick: () => resolve(it, { notFound: true }) }, 'No está en ningún sitio')));
    }
    return row;
  }

  async function resolve(it, body) {
    try {
      const res = await api(`/imports/${id}/items/${it.id}`, { method: 'POST', body });
      items = items.map((x) => (x.id === it.id ? res.item : x));
      job = res.job;
      drawHead();
      drawTabs();
      drawList();
      toast(body.notFound ? 'Marcado como no disponible' : 'Emparejado');
      changed().catch(() => {});
    } catch (err) {
      showError(err);
    }
  }

  async function pasteBandcamp(it) {
    const url = await promptText({
      title: 'Enlace de Bandcamp',
      label: `Página del álbum «${it.title}» en Bandcamp`,
      placeholder: 'https://artista.bandcamp.com/album/…',
      okText: 'Usar este enlace',
    });
    if (url) await resolve(it, { bandcampUrl: url });
  }

  async function change(it) {
    const choice = await chooseAlbum(it);
    if (choice) await resolve(it, choice);
  }

  async function acceptAll() {
    const candidates = items.filter((it) => it.status === 'review' && it.candidates[0]?.score >= 0.8).length;
    if (!candidates) return toast('No hay sugerencias con un 80 % o más.');
    const ok = await confirmDialog({
      title: 'Aceptar sugerencias',
      message: `Se aceptará la primera opción de ${plural(candidates, 'disco', 'discos')} con una coincidencia del 80 % o más.`,
      okText: 'Aceptar',
    });
    if (!ok) return;
    try {
      const res = await api(`/imports/${id}/accept`, { method: 'POST', body: { minScore: 0.8 } });
      job = res.job;
      await loadItems();
      drawHead();
      drawTabs();
      drawList();
      toast(`${plural(res.accepted, 'disco aceptado', 'discos aceptados')}`);
      changed().catch(() => {});
    } catch (err) {
      showError(err);
    }
  }

  async function retry() {
    try {
      await api(`/imports/${id}/retry`, { method: 'POST' });
      ({ job } = await api(`/imports/${id}`));
      drawHead();
      poll();
    } catch (err) {
      showError(err);
    }
  }

  async function removeJob() {
    const ok = await confirmDialog({
      title: 'Eliminar registro de importación',
      message: 'Se borra solo este registro y su pantalla de revisión. La colección y los álbumes se quedan, y los emparejamientos que confirmaste se siguen recordando.',
      okText: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/imports/${id}`, { method: 'DELETE' });
      location.hash = '#/importar';
    } catch (err) {
      showError(err);
    }
  }

  // Mientras la importación avanza, consulta el progreso cada 2 s.
  let lastKey = '';
  async function poll() {
    if (!root.isConnected && lastKey) return; // el usuario se ha ido a otra pantalla
    try {
      ({ job } = await api(`/imports/${id}`));
      const key = JSON.stringify(job.counts) + job.status;
      if (key !== lastKey) {
        lastKey = key;
        await loadItems();
        drawHead();
        drawTabs();
        drawList();
        if (job.status === 'done' || job.collectionId) changed().catch(() => {});
      }
    } catch (err) {
      if (err.status === 404) return;
    }
    if (job.status === 'fetching' || job.status === 'matching') setTimeout(poll, 2000);
  }

  await loadItems();
  lastKey = JSON.stringify(job.counts) + job.status;
  drawHead();
  drawTabs();
  drawList();
  if (job.status === 'fetching' || job.status === 'matching') setTimeout(poll, 2000);
  return { title: job.title || 'Importación', node: root };
}

