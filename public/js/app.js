import { api, setUnauthorizedHandler } from './api.js';
import { h, icon, showError, toast } from './dom.js';
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
  }
});

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

// ---------- Navegación ----------

$('menuBtn').append(icon('menu'));
$('searchBtn').append(icon('search'));
$('menuBtn').addEventListener('click', () => document.body.classList.toggle('drawer-open'));
$('scrim').addEventListener('click', () => document.body.classList.remove('drawer-open'));

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, query] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query || '') };
}

let routeSeq = 0;
async function route({ keepScroll = false } = {}) {
  const seq = ++routeSeq;
  const scrollY = window.scrollY;
  document.body.classList.remove('drawer-open');
  highlightSidebar(sidebar, location.hash || '#/');

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
}

window.addEventListener('hashchange', () => route());

// Tras crear, mover o borrar algo: repinta la barra lateral y la vista, sin perder la posición.
bus.addEventListener('change', () => {
  renderSidebar(sidebar);
  // Las pantallas de búsqueda e importación se actualizan solas; no se repintan enteras.
  if (!/^#\/(buscar|importar)/.test(location.hash)) route({ keepScroll: true });
  else highlightSidebar(sidebar, location.hash);
});

// ---------- Arranque ----------

async function startApp() {
  $('login').hidden = true;
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
async function refreshAll({ quiet = false } = {}) {
  if ($('shell').hidden) return;
  const version = await serverVersion();
  if (version && appVersion && version !== appVersion) {
    location.reload();
    return;
  }
  try {
    await loadTree();
    renderSidebar(sidebar);
    await route({ keepScroll: true });
    if (!quiet) toast('Actualizado');
  } catch (err) {
    if (!quiet) showError(err);
  }
}

setupPullToRefresh(() => refreshAll());
setupResumeRefresh(refreshAll);

async function boot() {
  setUnauthorizedHandler(showLogin);
  serverVersion().then((v) => { appVersion = v; });
  try {
    const status = await api('/auth/status');
    state.country = status.country;
    state.authRequired = status.authRequired;
    if (status.authRequired && !status.authenticated) return showLogin();
    await startApp();
  } catch (err) {
    showError(err);
  }
}

boot();

// Service worker: permite instalar la app y abrirla aunque el servidor no responda.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
