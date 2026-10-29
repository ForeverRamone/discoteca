import { api } from './api.js';
import { h, icon, toast, showError, confirmDialog } from './dom.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Sección de Ajustes: descargar una copia en JSON y restaurarla.
export function backupSection() {
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const restoreBtn = h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, icon('refresh'), 'Restaurar desde archivo…');

  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    let backup;
    try {
      backup = JSON.parse(await f.text());
    } catch {
      return showError(new Error('El archivo no es un JSON válido.'));
    }
    if (backup?.app !== 'discoteca') return showError(new Error('Este archivo no es una copia de seguridad de Discoteca.'));
    const c = backup.counts || {};
    const when = backup.exportedAt ? new Date(backup.exportedAt).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' }) : 'fecha desconocida';
    const ok = await confirmDialog({
      title: 'Restaurar copia de seguridad',
      message: `Copia del ${when}: ${plural(c.albums ?? 0, 'álbum', 'álbumes')}, ${plural(c.collections ?? 0, 'colección', 'colecciones')} y ${plural(c.folders ?? 0, 'carpeta', 'carpetas')}. `
        + 'Sustituirá TODO lo que hay ahora en la app (el historial de importaciones se borra). Antes se guarda automáticamente una copia de la base de datos actual en el servidor.',
      okText: 'Restaurar',
      danger: true,
    });
    if (!ok) return;
    restoreBtn.disabled = true;
    try {
      const res = await api('/backup/restore', { method: 'POST', body: backup });
      toast(`Restaurado: ${plural(res.counts.albums ?? 0, 'álbum', 'álbumes')}`);
      // Recarga de verdad: desde #/ajustes, location.assign('/#/') solo cambiaría el hash y se verían datos viejos.
      setTimeout(() => {
        location.hash = '#/';
        location.reload();
      }, 900);
    } catch (err) {
      showError(err);
      restoreBtn.disabled = false;
    }
  });

  return h('section', { class: 'card-section' },
    h('h2', null, 'Copia de seguridad'),
    h('p', { class: 'muted small' }, 'Descarga en un archivo JSON todos tus álbumes, carpetas, colecciones (con su orden) y los emparejamientos que has confirmado. Guárdalo donde quieras; con él puedes restaurarlo todo aquí o en otra instalación.'),
    h('div', { class: 'actions' },
      h('a', { class: 'btn primary', href: '/api/backup', download: '' }, icon('download'), 'Descargar copia (JSON)'),
      restoreBtn,
      file),
    h('p', { class: 'muted small' }, 'Restaurar sustituye todo el contenido actual. Por seguridad, el servidor guarda antes una copia de la base de datos en la carpeta «backups» del volumen de datos (se conservan las 10 últimas).'));
}
