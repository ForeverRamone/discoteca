// «Tirar hacia abajo para actualizar» y puesta al día automática.
//
// Instalada en la pantalla de inicio del iPhone, la app no tiene el gesto de Safari para recargar,
// así que se implementa aquí, imitando el de iOS: el contenido baja con el dedo (con resistencia),
// un anillo se va llenando y, al soltar pasado el umbral, gira mientras se actualiza.

const THRESHOLD = 64; // px de desplazamiento para actualizar
const MAX = 120; // desplazamiento máximo
const REST = 54; // donde se queda el contenido mientras actualiza
const RING = 2 * Math.PI * 9; // perímetro del anillo (r = 9)
const EASE = 'cubic-bezier(0.22, 0.9, 0.3, 1)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resistencia elástica: cuanto más tiras, menos baja (se acerca a MAX sin llegar).
const rubber = (dy) => MAX * (1 - Math.exp(-dy / (MAX * 1.6)));

function indicatorElement() {
  const el = document.createElement('div');
  el.className = 'ptr';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2">
      <circle class="ptr-track" cx="12" cy="12" r="9"/>
      <circle class="ptr-arc" cx="12" cy="12" r="9" stroke-dasharray="${RING}" stroke-dashoffset="${RING}" transform="rotate(-90 12 12)"/>
      <path class="ptr-arrow" d="M12 8v7m-3-3 3 3 3-3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  document.body.append(el);
  return el;
}

export function setupPullToRefresh(onRefresh, { content = () => document.getElementById('view') } = {}) {
  const indicator = indicatorElement();
  const arc = indicator.querySelector('.ptr-arc');
  const arrow = indicator.querySelector('.ptr-arrow');
  let startY = null;
  let pull = 0;
  let busy = false;
  let frame = 0;

  // No se activa con diálogos abiertos, el menú lateral desplegado o mientras reordenas.
  const blocked = () =>
    busy || document.querySelector('dialog[open]') || document.body.classList.contains('drawer-open') || document.querySelector('.editing');

  function render(px, { animate = false } = {}) {
    const view = content();
    const transition = animate ? `transform 0.35s ${EASE}, opacity 0.25s ease` : 'none';
    if (view) {
      view.style.transition = transition;
      view.style.transform = px > 0 ? `translate3d(0, ${px}px, 0)` : '';
    }
    indicator.style.transition = transition;
    indicator.style.transform = `translate3d(-50%, ${px - 46}px, 0)`;
    indicator.style.opacity = String(Math.min(1, px / 34));
    if (!indicator.classList.contains('spinning')) {
      const progress = Math.min(1, px / THRESHOLD);
      arc.setAttribute('stroke-dashoffset', String(RING * (1 - progress)));
      arrow.style.transform = `rotate(${px >= THRESHOLD ? 180 : 0}deg)`;
      indicator.classList.toggle('ready', px >= THRESHOLD);
    }
  }

  const schedule = (px) => {
    pull = px;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => render(pull));
  };

  window.addEventListener('touchstart', (e) => {
    startY = !blocked() && window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) {
      if (pull) schedule(0);
      if (dy < -10) startY = null; // está desplazándose hacia abajo con normalidad
      return;
    }
    schedule(rubber(dy));
  }, { passive: true });

  async function finish() {
    if (startY == null) return;
    startY = null;
    cancelAnimationFrame(frame);
    if (pull < THRESHOLD) {
      pull = 0;
      render(0, { animate: true });
      return;
    }
    busy = true;
    indicator.classList.add('spinning');
    render(REST, { animate: true });
    try {
      // Un mínimo de tiempo para que el giro se vea y no sea un parpadeo.
      await Promise.all([onRefresh(), sleep(600)]);
    } finally {
      render(0, { animate: true });
      await sleep(380);
      indicator.classList.remove('spinning', 'ready');
      const view = content();
      if (view) view.style.transition = '';
      pull = 0;
      busy = false;
    }
  }
  window.addEventListener('touchend', finish);
  window.addEventListener('touchcancel', finish);
}

// Al volver a la app tras un rato en segundo plano, se pone al día sola.
export function setupResumeRefresh(onRefresh, { afterMs = 60e3 } = {}) {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt >= afterMs) onRefresh({ quiet: true });
  });
}
