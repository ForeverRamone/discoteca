// Bandcamp en la interfaz: buscador interno, elegir un disco y su reproductor oficial.
import { api } from './api.js';
import { h, icon, fill, openDialog, dialogHeader } from './dom.js';
import { coverImg } from './components.js';

const PLAYER_HEIGHT = 470;

// Reproductor oficial de Bandcamp. «artwork=small» deja ver la lista de pistas y «t=1» hace que
// empiece siempre por la primera (si no, arranca por la pista destacada por el artista).
export function embedUrl(bandcampId) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return `https://bandcamp.com/EmbeddedPlayer/album=${Number(bandcampId)}/size=large/bgcol=${dark ? '333333' : 'ffffff'}/linkcol=ff4d6a/artwork=small/tracklist=true/transparent=true/t=1/`;
}

// Botón «Escuchar aquí» y su panel. El reproductor (que carga scripts y cookies de Bandcamp)
// no se crea hasta que lo pulsas. getId devuelve el ID del álbum de Bandcamp o null.
export function listenToggle(getId, { label = 'Escuchar aquí' } = {}) {
  const panel = h('div', { class: 'bc-player', hidden: true });
  let loaded = false;
  const button = h('button', { class: 'btn small', type: 'button', 'aria-expanded': 'false' }, icon('play'), label);
  button.addEventListener('click', async () => {
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.replaceChildren(icon(open ? 'close' : 'play'), open ? 'Ocultar reproductor' : label);
    if (!open || loaded) return;
    loaded = true;
    fill(panel, h('div', { class: 'bc-loading' }, 'Cargando el reproductor de Bandcamp…'));
    try {
      const id = await getId();
      if (!id) throw new Error();
      fill(panel, h('iframe', {
        src: embedUrl(id),
        title: 'Reproductor de Bandcamp',
        allow: 'autoplay',
        vars: { '--h': `${PLAYER_HEIGHT}px` },
      }));
    } catch {
      loaded = false;
      fill(panel, h('p', { class: 'muted small pad' }, 'No se ha podido cargar el reproductor. Puedes escucharlo en Bandcamp.'));
    }
  });
  return { button, panel };
}

// Reproductor de un disco guardado (pide el ID al servidor, que lo saca de la página si hace falta).
export const savedAlbumPlayer = (albumId) =>
  listenToggle(() => api(`/albums/${albumId}/bandcamp-player`).then((r) => r.player?.albumId ?? null));

// Reproductor de un resultado del buscador (ya trae su ID).
export const hitPlayer = (hit) => listenToggle(async () => hit.bandcampId);

// Fila de resultado de Bandcamp: portada, datos, «Escuchar» y la acción que se pase.
export function bandcampRow(hit, action) {
  const { button, panel } = hitPlayer(hit);
  const meta = ['Bandcamp', hit.year, hit.trackCount && `${hit.trackCount} pistas`, hit.score != null && `${Math.round(hit.score * 100)} %`]
    .filter(Boolean).join(' · ');
  return h('div', { class: 'bc-row' },
    h('div', { class: 'choose-row' },
      h('a', { class: 'result-cover small', href: hit.externalUrl, target: '_blank', rel: 'noopener', title: 'Abrir en Bandcamp' }, coverImg(hit, 64)),
      h('span', { class: 'result-text' },
        h('span', { class: 'row-title' }, hit.title),
        h('span', { class: 'row-sub' }, hit.artist),
        h('span', { class: 'muted small' }, meta)),
      h('div', { class: 'row-actions' }, hit.bandcampId && button, action)),
    panel);
}

// Diálogo para buscar en Bandcamp y elegir un disco. Devuelve el resultado elegido o undefined.
export function pickBandcamp({ title = 'Buscar en Bandcamp', query = '' } = {}) {
  return openDialog((close) => {
    const input = h('input', { type: 'search', value: query, 'aria-label': 'Buscar en Bandcamp', placeholder: 'Artista y álbum, o enlace de Bandcamp', enterkeyhint: 'search' });
    const list = h('div', { class: 'choose-list' });
    const status = h('p', { class: 'muted small' });
    const run = async () => {
      const q = input.value.trim();
      if (q.length < 2) return;
      status.textContent = 'Buscando en Bandcamp…';
      list.replaceChildren();
      try {
        const { results } = await api(`/bandcamp/search?q=${encodeURIComponent(q)}`);
        status.textContent = results.length ? `${results.length} resultado${results.length === 1 ? '' : 's'} en Bandcamp` : 'Este disco no parece estar en Bandcamp.';
        fill(list, ...results.map((hit) =>
          bandcampRow(hit, h('button', { class: 'btn small primary', type: 'button', onclick: () => close(hit) }, 'Elegir'))));
      } catch (err) {
        status.textContent = err.message;
      }
    };
    if (query) setTimeout(run, 0);
    return h('div', { class: 'picker' },
      dialogHeader(title, close),
      h('div', { class: 'dlg-body' },
        h('form', { class: 'search-form', onsubmit: (e) => { e.preventDefault(); run(); } },
          input, h('button', { class: 'btn', type: 'submit', 'aria-label': 'Buscar' }, icon('search'))),
        status,
        list,
        h('p', { class: 'muted small' }, 'Bandcamp es sobre todo autoedición: con discos clásicos puede devolver ediciones no oficiales. Escúchalo antes de elegir si tienes dudas.')));
  }, { className: 'wide' });
}
