// Convierte texto pegado, CSV o Excel en una lista de discos { position, artist, title, year }.
import { readXlsxRows } from './xlsx.js';

const SEPARATORS = [' – ', ' — ', '\t', ' - ', ' -- ', ' / '];

function extractYear(text) {
  const m = text.match(/\s*[([]\s*((?:19|20)\d{2})\s*[)\]]\s*$/) || text.match(/\s*,\s*((?:19|20)\d{2})\s*$/);
  return m ? { text: text.slice(0, m.index).trim(), year: Number(m[1]) } : { text: text.trim(), year: null };
}

// «1. Miles Davis – Kind of Blue (1959)»  ->  { artist, title, year }
export function parseLine(line, order = 'artist-title') {
  let s = String(line ?? '').trim();
  if (!s || s.startsWith('#') && !/^#\d/.test(s)) return null;
  s = s.replace(/^#?\d{1,4}\s*[.)º:]\s+/, ''); // numeración: «1. », «12) », «#3: »
  for (const sep of SEPARATORS) {
    const i = s.indexOf(sep);
    if (i <= 0) continue;
    let left = s.slice(0, i).trim();
    let right = s.slice(i + sep.length).trim();
    if (!left || !right) continue;
    const { text, year } = extractYear(order === 'artist-title' ? right : left);
    if (order === 'artist-title') right = text;
    else left = text;
    return order === 'artist-title' ? { artist: left, title: right, year } : { artist: right, title: left, year };
  }
  return null;
}

export function parseText(text, order) {
  const items = [];
  let skipped = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseLine(line, order);
    if (parsed) items.push({ position: items.length, ...parsed });
    else skipped++;
  }
  return { items, skipped };
}

// CSV con comillas; detecta el separador (coma, punto y coma o tabulador).
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delimiter = [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

const HEADER = {
  artist: /^(artist[ae]?s?|int[eé]rpretes?|grupo|banda|autor)$/i,
  title: /^(album|álbum|disco|t[ií]tulo|title|release|nombre)$/i,
  year: /^(a[ñn]o|year|fecha|date)$/i,
  position: /^(#|pos(ici[oó]n)?|n[º°o.]*|rank|orden|puesto|position)$/i,
};

// Filas (de CSV o Excel) -> discos. Usa la cabecera si existe; si no, columnas artista, álbum, año.
export function rowsToItems(rows, order = 'artist-title') {
  if (!rows.length) return { items: [], skipped: 0 };
  const head = rows[0].map((c) => String(c ?? '').trim());
  const col = {};
  for (const [key, re] of Object.entries(HEADER)) {
    const i = head.findIndex((h) => re.test(h));
    if (i >= 0) col[key] = i;
  }
  const hasHeader = col.artist !== undefined && col.title !== undefined;
  const body = hasHeader ? rows.slice(1) : rows;
  const items = [];
  let skipped = 0;
  for (const r of body) {
    // Quita el apóstrofo que se antepone a las celdas tipo «=…» al exportar a CSV (ver csv.js).
    const cells = r.map((c) => String(c ?? '').trim().replace(/^'(?=[=+\-@])/, ''));
    let entry;
    if (hasHeader) {
      entry = { artist: cells[col.artist], title: cells[col.title], year: Number(cells[col.year]) || null };
      if (col.position !== undefined) entry.sourcePos = Number(cells[col.position]);
    } else if (cells.filter(Boolean).length >= 2) {
      const [a, b, y] = cells;
      entry = order === 'artist-title' ? { artist: a, title: b } : { artist: b, title: a };
      entry.year = /^(19|20)\d{2}$/.test(y || '') ? Number(y) : null;
    } else {
      entry = parseLine(cells.find(Boolean), order);
    }
    if (entry?.artist && entry?.title) items.push(entry);
    else skipped++;
  }
  if (items.every((i) => Number.isFinite(i.sourcePos))) items.sort((a, b) => a.sourcePos - b.sourcePos);
  return { items: items.map(({ sourcePos, ...i }, position) => ({ position, ...i })), skipped };
}

// filename decide el formato: .xlsx, .csv/.tsv o texto.
export function parseUpload({ filename = '', data, text, order }) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'xlsx') {
    if (!data) throw new Error('Falta el contenido del archivo.');
    return rowsToItems(readXlsxRows(Buffer.from(data, 'base64')), order);
  }
  if (ext === 'xls') throw new Error('El formato .xls antiguo no está soportado. Guárdalo como .xlsx o .csv.');
  const content = text ?? (data ? Buffer.from(data, 'base64').toString('utf8') : '');
  if (ext === 'csv' || ext === 'tsv') return rowsToItems(parseCsv(content), order);
  return parseText(content, order);
}
