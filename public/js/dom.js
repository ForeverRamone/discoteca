// Utilidades de DOM. Todo el texto se inserta como texto (nunca como HTML) para evitar inyecciones.

const isSafeHref = (v) => /^(https?:\/\/|music:\/\/|#|\/(?!\/))/i.test(String(v));

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'vars') for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['value', 'checked', 'selected', 'disabled', 'hidden', 'open'].includes(key)) el[key] = value;
    else if (key === 'href' && !isSafeHref(value)) continue; // nunca javascript: ni similares
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

// Sustituye el contenido ignorando null/false (replaceChildren los pintaría como texto).
export function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3.2"/>',
  grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  stack: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M6.5 6h11M9 3h6"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  move: '<path d="M4 12h15M14 6l6 6-6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  logout: '<path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 8l-4 4 4 4M6 12h10"/>',
  reorder: '<path d="M8 20V4M4 8l4-4 4 4M16 4v16M12 16l4 4 4-4"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01" stroke-width="2.8"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
  headphones: '<path d="M4 18v-5a8 8 0 0 1 16 0v5"/><rect x="3.5" y="14" width="4" height="6" rx="1.5"/><rect x="16.5" y="14" width="4" height="6" rx="1.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  note: '<path d="M6 4h9l4 4v12H6zM14.5 4v4.5H19M9 12.5h7M9 16h5"/>',
};

export function icon(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}

// ---------- Avisos ----------
// action: { label, run } añade un botón (p. ej. «Deshacer») y deja el aviso más tiempo en pantalla.
let toastTimer;
let toastShownAt = 0;
export function toast(message, { error = false, action = null } = {}) {
  const el = document.getElementById('toast');
  const hide = () => el.classList.remove('show');
  el.textContent = message;
  if (action) {
    el.append(h('button', {
      class: 'toast-action', type: 'button',
      onclick: () => { clearTimeout(toastTimer); hide(); action.run(); },
    }, action.label));
  }
  el.classList.toggle('error', error);
  el.classList.toggle('has-action', Boolean(action));
  el.classList.add('show');
  toastShownAt = Date.now();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, action ? 7000 : error ? 5000 : 2600);
}

// Al cambiar de pantalla, un error de la anterior ya no viene a cuento. Los de hace un instante
// se dejan: suelen ser de la acción que acaba de llevarte a esta pantalla.
export function hideErrorToast() {
  const el = document.getElementById('toast');
  if (el.classList.contains('error') && Date.now() - toastShownAt > 400) {
    clearTimeout(toastTimer);
    el.classList.remove('show');
  }
}

export function showError(err) {
  toast(err?.message || String(err), { error: true });
}

// ---------- Diálogos ----------
// build(close) devuelve el contenido; close(valor) cierra el diálogo y resuelve la promesa.
export function openDialog(build, { className = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: `dlg ${className}` });
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(undefined);
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) close(undefined); // clic en el fondo
    });
    dlg.append(build(close));
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function dialogHeader(title, close) {
  return h('header', { class: 'dlg-head' },
    h('h2', null, title),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Cerrar', onclick: () => close(undefined) }, icon('close')));
}

export function promptText({ title, label = '', value = '', okText = 'Guardar', placeholder = '' }) {
  return openDialog((close) => {
    const input = h('input', { type: 'text', value, placeholder, required: true, maxlength: 200, 'aria-label': label || title });
    const form = h('form', { class: 'dlg-body', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) close(v); } },
      label && h('label', { class: 'field-label' }, label),
      input,
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(undefined) }, 'Cancelar'),
        h('button', { class: 'btn primary', type: 'submit' }, okText)));
    setTimeout(() => { input.focus(); input.select(); }, 30);
    return h('div', null, dialogHeader(title, close), form);
  });
}

export function confirmDialog({ title, message, okText = 'Aceptar', danger = false }) {
  return openDialog((close) =>
    h('div', null,
      dialogHeader(title, close),
      h('div', { class: 'dlg-body' },
        message && h('p', null, message),
        h('div', { class: 'dlg-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancelar'),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => close(true) }, okText)))),
  ).then(Boolean);
}

// Menú de acciones (hoja inferior en móvil).
export function actionSheet({ title, actions }) {
  return openDialog((close) =>
    h('div', null,
      dialogHeader(title, close),
      h('div', { class: 'sheet-actions' },
        actions.filter(Boolean).map((a) =>
          h('button', { class: `sheet-btn ${a.danger ? 'danger' : ''}`, type: 'button', onclick: () => close(a) },
            a.icon && icon(a.icon), a.label)))),
    { className: 'sheet' },
  ).then((a) => a?.run?.());
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
