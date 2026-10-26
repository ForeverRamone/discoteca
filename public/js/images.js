// Carga de portadas pensada para colecciones grandes en el móvil.
//
// Problema que resuelve: en el iPhone (sobre todo con la app en la pantalla de inicio) el
// navegador tiene un límite de memoria para imágenes. Con cientos de portadas a 600 px que nunca
// se liberan se supera ese límite y deja de dibujarlas (salen «?» o huecos en blanco).
//
//   1. Cada portada se pide al tamaño justo: el que ocupa en pantalla × la densidad (máx. 2×).
//   2. Solo se cargan las que están en pantalla o cerca.
//   3. Las que quedan muy lejos se descargan de la memoria (se vuelven a pedir al volver,
//      normalmente desde la caché del navegador).
//   4. Si una falla, se reintenta; si sigue fallando, se muestra un icono en vez del «?».
import { artwork } from './store.js';

const SIZES = [100, 200, 300, 400, 600, 1000];
const LOAD_MARGIN = '800px 0px';
const UNLOAD_MARGIN = '3000px 0px';

const pickSize = (cssPx) => {
  const need = cssPx * Math.min(window.devicePixelRatio || 1, 2);
  return SIZES.find((s) => s >= need) ?? SIZES[SIZES.length - 1];
};

const tracked = new Set();
let loadObserver = null;
let unloadObserver = null;

function observers() {
  if (loadObserver) return;
  loadObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) load(e.target, e.boundingClientRect.width);
  }, { rootMargin: LOAD_MARGIN });
  unloadObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (!e.isIntersecting) unload(e.target);
  }, { rootMargin: UNLOAD_MARGIN });
  // Deja de vigilar las portadas que ya no están en la página (al cambiar de pantalla).
  setInterval(() => {
    for (const img of tracked) {
      if (!img.isConnected) {
        loadObserver.unobserve(img);
        unloadObserver.unobserve(img);
        tracked.delete(img);
      }
    }
  }, 20000);
}

function load(img, width) {
  if (img.dataset.state === 'loading' || img.dataset.state === 'ready') return;
  const w = width || img.getBoundingClientRect().width || img.parentElement?.clientWidth || 160;
  img.dataset.state = 'loading';
  img.dataset.src = artwork(img.dataset.art, pickSize(w));
  img.src = img.dataset.src;
}

function unload(img) {
  if (!img.dataset.state) return;
  img.removeAttribute('src');
  img.classList.remove('ready', 'failed');
  img.closest('.cover-wrap')?.classList.remove('noart');
  delete img.dataset.state;
}

function onLoad(e) {
  const img = e.currentTarget;
  if (!img.getAttribute('src')) return;
  img.dataset.state = 'ready';
  img.classList.add('ready');
}

function onError(e) {
  const img = e.currentTarget;
  if (!img.getAttribute('src')) return;
  const tries = Number(img.dataset.tries || 0) + 1;
  img.dataset.tries = String(tries);
  if (tries <= 2) {
    setTimeout(() => {
      if (img.isConnected && img.dataset.src) img.src = `${img.dataset.src}${img.dataset.src.includes('?') ? '&' : '?'}r=${tries}`;
    }, 1200 * tries);
    return;
  }
  img.dataset.state = 'failed';
  img.classList.add('failed');
  img.closest('.cover-wrap')?.classList.add('noart');
}

// Crea una portada con carga diferida y tamaño adaptado.
export function lazyCover(url) {
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  img.dataset.art = url;
  img.addEventListener('load', onLoad);
  img.addEventListener('error', onError);
  if (!('IntersectionObserver' in window)) {
    img.src = artwork(url, 300);
    return img;
  }
  observers();
  tracked.add(img);
  // Se puede observar aunque aún no esté en la página: el aviso llega en cuanto se muestre.
  loadObserver.observe(img);
  unloadObserver.observe(img);
  return img;
}
