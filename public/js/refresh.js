// «Tirar hacia abajo para actualizar» y puesta al día automática.
//
// Instalada en la pantalla de inicio del iPhone, la app no tiene el gesto de Safari para recargar,
// así que se implementa aquí: con la página arriba del todo, tira hacia abajo y suelta.
import { h, icon } from './dom.js';

const THRESHOLD = 70; // px que hay que tirar para actualizar
const MAX = 120;

export function setupPullToRefresh(onRefresh) {
  const indicator = h('div', { class: 'ptr', 'aria-hidden': 'true' }, icon('refresh'));
  document.body.append(indicator);
  let startY = null;
  let pull = 0;
  let busy = false;

  // No se activa con diálogos abiertos, el menú lateral desplegado o mientras reordenas.
  const blocked = () =>
    busy || document.querySelector('dialog[open]') || document.body.classList.contains('drawer-open') || document.querySelector('.editing');

  const set = (px) => {
    pull = px;
    indicator.style.setProperty('--pull', `${px}px`);
    indicator.classList.toggle('visible', px > 4);
    indicator.classList.toggle('ready', px >= THRESHOLD);
  };

  window.addEventListener('touchstart', (e) => {
    startY = !blocked() && window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) {
      startY = null;
      set(0);
      return;
    }
    set(Math.min(MAX, dy * 0.5)); // resistencia: hay que tirar el doble de lo que baja
  }, { passive: true });

  const end = async () => {
    if (startY == null) return;
    startY = null;
    if (pull < THRESHOLD) return set(0);
    busy = true;
    set(THRESHOLD);
    indicator.classList.add('loading');
    try {
      await onRefresh();
    } finally {
      busy = false;
      indicator.classList.remove('loading');
      set(0);
    }
  };
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', end);
}

// Al volver a la app tras un rato en segundo plano, se pone al día sola.
export function setupResumeRefresh(onRefresh, { afterMs = 60e3 } = {}) {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt >= afterMs) onRefresh({ quiet: true });
  });
}
