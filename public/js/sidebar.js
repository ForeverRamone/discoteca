import { h, icon } from './dom.js';
import { prefs, childFolders, childCollections, folderById, collectionById, folderPath } from './store.js';
import { createFolder, createCollection, folderActions, collectionActions } from './components.js';

const expanded = new Set(prefs.get('expandedFolders', []));
const saveExpanded = () => prefs.set('expandedFolders', [...expanded]);

function navLink(href, iconName, label, title) {
  return h('a', { class: 'nav-link', href, title, dataset: { href } }, icon(iconName), h('span', null, label));
}

function folderNode(folder, depth) {
  const open = expanded.has(folder.id);
  const children = h('div', { class: 'tree-children', hidden: !open });
  const label = (isOpen) => `${isOpen ? 'Contraer' : 'Expandir'} ${folder.name}`;
  const toggle = h('button', {
    class: `tree-toggle ${open ? 'open' : ''}`, type: 'button', 'aria-label': label(open), 'aria-expanded': String(open),
    onclick: () => {
      const nowOpen = !expanded.has(folder.id);
      nowOpen ? expanded.add(folder.id) : expanded.delete(folder.id);
      saveExpanded();
      toggle.classList.toggle('open', nowOpen);
      toggle.setAttribute('aria-expanded', String(nowOpen));
      toggle.setAttribute('aria-label', label(nowOpen));
      children.hidden = !nowOpen;
    },
  }, icon('chevron'));
  if (open) children.append(...treeLevel(folder.id, depth + 1));
  else toggle.addEventListener('click', () => { if (!children.childElementCount) children.append(...treeLevel(folder.id, depth + 1)); }, { once: true });

  return h('div', { class: 'tree-folder' },
    h('div', { class: 'tree-item', vars: { '--depth': depth } },
      toggle,
      h('a', { class: 'tree-link', href: `#/f/${folder.id}`, dataset: { href: `#/f/${folder.id}` } }, icon('folder'), h('span', null, folder.name)),
      h('button', { class: 'icon-btn small tree-more', type: 'button', 'aria-label': `Opciones de ${folder.name}`, onclick: () => folderActions(folder) }, icon('more'))),
    children);
}

function collectionNode(c, depth) {
  return h('div', { class: 'tree-item', vars: { '--depth': depth } },
    h('span', { class: 'tree-toggle-space' }),
    h('a', { class: 'tree-link', href: `#/c/${c.id}`, dataset: { href: `#/c/${c.id}` } },
      icon('stack'), h('span', null, c.name), h('span', { class: 'tree-count' }, c.albumCount)),
    h('button', { class: 'icon-btn small tree-more', type: 'button', 'aria-label': `Opciones de ${c.name}`, onclick: () => collectionActions(c) }, icon('more')));
}

function treeLevel(parentId, depth) {
  return [
    ...childFolders(parentId).map((f) => folderNode(f, depth)),
    ...childCollections(parentId).map((c) => collectionNode(c, depth)),
  ];
}

export function renderSidebar(el) {
  const tree = treeLevel(null, 0);
  el.replaceChildren(
    h('div', { class: 'brand' }, icon('disc'), 'Discoteca'),
    h('nav', { class: 'nav' },
      navLink('#/', 'home', 'Inicio'),
      navLink('#/biblioteca', 'disc', 'Biblioteca'),
      navLink('#/buscar', 'search', 'Buscar', 'Buscar (atajo: /)'),
      navLink('#/importar', 'download', 'Importar'),
      navLink('#/ajustes', 'settings', 'Ajustes')),
    h('div', { class: 'tree-head' },
      h('span', null, 'Colecciones'),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Nueva carpeta', title: 'Nueva carpeta', onclick: () => createFolder(null) }, icon('folder')),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Nueva colección', title: 'Nueva colección', onclick: () => createCollection(null) }, icon('plus'))),
    h('div', { class: 'tree' }, tree.length ? tree : h('p', { class: 'muted small pad' }, 'Aún no hay colecciones.')));
}

// Marca el enlace activo y despliega las carpetas que lo contienen.
export function highlightSidebar(el, hash) {
  // Carpetas que contienen la carpeta o colección abierta: se despliegan para que se vea.
  const [, kind, id] = hash.match(/^#\/([fc])\/(\d+)/) || [];
  const parentId = kind === 'f' ? folderById(Number(id))?.parentId : kind === 'c' ? collectionById(Number(id))?.folderId : null;
  const closed = folderPath(parentId).filter((f) => !expanded.has(f.id));
  if (closed.length) {
    closed.forEach((f) => expanded.add(f.id));
    saveExpanded();
    renderSidebar(el);
  }

  let current = null;
  for (const a of el.querySelectorAll('[data-href]')) {
    const href = a.dataset.href;
    const active = href === '#/' ? hash === '#/' || hash === '' : hash === href || hash.startsWith(`${href}?`) || hash.startsWith(`${href}/`);
    a.classList.toggle('active', active);
    if (active) {
      a.setAttribute('aria-current', 'page');
      current = a;
    } else a.removeAttribute('aria-current');
  }
  // Solo si la barra se ve (en el móvil, al abrir el menú se hace desde app.js).
  if (current && matchMedia('(min-width: 900px)').matches) current.scrollIntoView({ block: 'nearest' });
}
