import { api, setUnauthorizedHandler } from './api.js';
import { h, icon, showError, toast, hideErrorToast } from './dom.js';
import { state, bus, loadTree } from './store.js';
import { renderSidebar, highlightSidebar } from './sidebar.js';
import { folderView, collectionView, libraryView, searchView, settingsView } from './views.js';
import { importView, importJobView } from './imports.js';
import { setupPullToRefresh, setupResumeRefresh } from './refresh.js';

const $ = (id) => document.getElementById(id);
const main = $('view');
const sidebar = $('sidebar');

// ---------- Inicio de sesión ----------

function showLogin() {
  $('shell').hidden = true;
  $('bootError').hidden = true;
  $('login').hidden = false;
  setTimeout(() => $('loginPassword').focus(), 50);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.hidden = true;
  try {
    await api('/auth/login', { method: 'POST', body: { password: $('loginPassword').value } });
    $('loginPassword').value = '';
    await startApp();
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
    $('loginPassword').select(); // para escribirla de nuevo sin borrar a mano
  }
});

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

// ---------- Navegación ----------

$('menuBtn').append(icon('menu'));
$('searchBtn').append(icon('search'));

// Menú lateral (en el móvil): abre y cierra, y mantiene aria-expanded al día.
function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  $('menuBtn').setAttribute('aria-expanded', String(open));
  if (open) sidebar.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}
$('menuBtn').addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
$('scrim').addEventListener('click', () => setDrawer(false));

// Indicador de carga si una pantalla tarda en llegar (barra fina arriba y aria-busy).
const progress = h('div', { class: 'route-progress', 'aria-hidden': 'true' });
document.body.append(progress);
let loadingTimer = 0;
function setLoading(on) {
  clearTimeout(loadingTimer);
  if (on) {
    loadingTimer = setTimeout(() => {
      main.setAttribute('aria-busy', 'true');
      document.body.classList.add('route-loading');
    }, 150);
  } else {
    main.removeAttribute('aria-busy');
    document.body.classList.remove('route-loading');
  }
}

// Modo reordenar activo: repintar la vista perdería el orden sin guardar. El repintado se aplaza
// hasta que se sale de ese modo (guardando o cancelando).
const editing = () => Boolean(main.querySelector('.editing'));
let repaintPending = false;
bus.addEventListener('editend', () => {
  if (!repaintPending) return;
  repaintPending = false;
  route({ keepScroll: true });
});

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, query] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query || '') };
}

let routeSeq = 0;
async function route({ keepScroll = false } = {}) {
  const seq = ++routeSeq;
  repaintPending = false;
  const scrollY = window.scrollY;
  setDrawer(false);
  highlightSidebar(sidebar, location.hash || '#/');
  setLoading(true);
  try {
    await paint(seq, { keepScroll, scrollY });
  } finally {
    if (seq === routeSeq) setLoading(false);
  }
}

async function paint(seq, { keepScroll, scrollY }) {
  const { parts, params } = parseHash();
  let view;
  try {
    switch (parts[0]) {
      case undefined: view = folderView(null); break;
      case 'f': view = folderView(Number(parts[1])); break;
      case 'c': view = await collectionView(Number(parts[1])); break;
      case 'biblioteca': view = await libraryView(); break;
      case 'buscar': view = await searchView(params); break;
      case 'importar': view = parts[1] ? await importJobView(Number(parts[1])) : await importView(); break;
      case 'ajustes': view = settingsView({ onLogout: logout }); break;
      default: view = { title: 'No encontrado', node: h('p', { class: 'empty' }, 'Esta página no existe.') };
    }
  } catch (err) {
    if (err.status === 401) return;
    view = { title: 'Error', node: h('div', { class: 'empty' }, h('p', null, err.message), h('a', { class: 'btn', href: '#/' }, 'Volver al inicio')) };
  }
  if (seq !== routeSeq) return; // el usuario ya ha navegado a otra parte
  main.replaceChildren(view.node);
  $('topTitle').textContent = view.title;
  document.title = view.title === 'Discoteca' ? 'Discoteca' : `${view.title} · Discoteca`;
  window.scrollTo(0, keepScroll ? scrollY : 0);
  // Pantalla nueva (no un repintado): el foco va a su título, para lectores de pantalla y teclado.
  const h1 = !keepScroll && main.querySelector('h1');
  if (h1) {
    h1.tabIndex = -1;
    h1.focus({ preventScroll: true });
  }
}

window.addEventListener('hashchange', () => {
  // Atrás/adelante con un diálogo abierto: se cierra como si se cancelara (su promesa se resuelve).
  for (const dlg of document.querySelectorAll('dialog[open]')) dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
  hideErrorToast();
  route();
});

// Tras crear, mover o borrar algo: repinta la barra lateral y la vista, sin perder la posición.
bus.addEventListener('change', () => {
  renderSidebar(sidebar);
  // Las pantallas de búsqueda e importación se actualizan solas, y mientras reordenas no se toca la vista.
  if (/^#\/(buscar|importar)/.test(location.hash)) highlightSidebar(sidebar, location.hash || '#/');
  else if (editing()) {
    repaintPending = true;
    highlightSidebar(sidebar, location.hash || '#/');
  } else route({ keepScroll: true });
});

// ---------- Arranque ----------

async function startApp() {
  $('login').hidden = true;
  $('bootError').hidden = true;
  $('shell').hidden = false;
  await loadTree();
  renderSidebar(sidebar);
  await route();
}

// ---------- Actualizar ----------

let appVersion = null;
async function serverVersion() {
  try {
    return (await (await fetch('/api/health', { cache: 'no-store' })).json()).version ?? null;
  } catch {
    return null;
  }
}

// Vuelve a pedir colecciones y la pantalla actual. Si hay una versión nueva de la app, recarga entera.
async function refreshAll({ quiet = false, silentSuccess = false } = {}) {
  if ($('shell').hidden) return;
  const version = await serverVersion();
  if (version && appVersion && version !== appVersion) {
    location.reload();
    return;
  }
  try {
    await loadTree();
    renderSidebar(sidebar);
    if (editing()) {
      repaintPending = true;
      highlightSidebar(sidebar, location.hash || '#/');
    } else await route({ keepScroll: true });
    if (!quiet && !silentSuccess) toast('Actualizado');
  } catch (err) {
    if (!quiet) showError(err);
  }
}

setupPullToRefresh(() => refreshAll({ silentSuccess: true })); // la animación ya indica que se ha actualizado
setupResumeRefresh(refreshAll);

// Si el arranque falla (sin conexión), se muestra un aviso con «Reintentar» en vez de una pantalla en blanco.
let booting = false;
async function boot() {
  if (booting) return;
  booting = true;
  setUnauthorizedHandler(showLogin);
  serverVersion().then((v) => { appVersion ??= v; });
  try {
    const status = await api('/auth/status');
    state.country = status.country;
    state.authRequired = status.authRequired;
    if (status.authRequired && !status.authenticated) showLogin();
    else await startApp();
  } catch (err) {
    $('shell').hidden = true;
    $('login').hidden = true;
    $('bootErrorMsg').textContent = err.status === 0
      ? 'No se ha podido conectar con el servidor. Comprueba la conexión y vuelve a intentarlo.'
      : err.message;
    $('bootError').hidden = false;
  } finally {
    booting = false;
  }
}

const retryBoot = () => { if (!$('bootError').hidden) boot(); };
$('bootRetry').addEventListener('click', retryBoot);
window.addEventListener('online', retryBoot);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryBoot(); });

// ---------- Atajos de teclado ----------
// «/» lleva a Buscar; «Escape» sale de reordenar (o cierra el menú lateral).
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || $('shell').hidden) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select, [contenteditable]')) return;
  if (e.key === '/') {
    e.preventDefault();
    if (parseHash().parts[0] !== 'buscar') location.hash = '#/buscar';
    else {
      const input = main.querySelector('.search-form input');
      input?.focus();
      input?.select();
    }
  } else if (e.key === 'Escape') {
    const cancel = main.querySelector('.edit-bar:not([hidden]) [data-cancel-edit]');
    if (cancel) cancel.click();
    else if (document.body.classList.contains('drawer-open')) setDrawer(false);
  }
});

boot();

// Service worker: permite instalar la app y abrirla aunque el servidor no responda.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
