// Utilidades para descargar CSV y otros archivos generados.

// Celda CSV entre comillas. Un texto que empieza por = + - @ (o tabulador/retorno) se trataría como
// fórmula en Excel: se le antepone un apóstrofo (parsers.js lo quita al reimportar).
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// Filas -> CSV con BOM (para que Excel lo abra en UTF-8) y saltos de línea CRLF.
export const csvDocument = (rows) => `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

// Cabecera Content-Disposition con un nombre ASCII seguro y el original en UTF-8 (RFC 6266).
// Se corta por puntos de código (no a mitad de un emoji) y se quitan los sustitutos sueltos, con los
// que encodeURIComponent fallaría.
export function attachment(name, ext, fallback = 'discoteca') {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\p{Cs}/gu, '').replace(/\s+/g, ' ').trim();
  const base = Array.from(clean).slice(0, 80).join('').trim() || fallback;
  const ascii = base.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|-+$/g, '') || fallback;
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
