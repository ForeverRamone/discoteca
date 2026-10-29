// Lector mínimo de .xlsx (solo la primera hoja, solo valores) sin dependencias externas.
// Un .xlsx es un ZIP con XML dentro; aquí se lee el ZIP con zlib y el XML con un recorrido sencillo.
import zlib from 'node:zlib';

const MAX_XML = 10 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_CELLS = 1_000_000; // celdas (incluidos huecos) en toda la hoja
const MAX_COLS = 16384; // XFD, la última columna de Excel

function openZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('El archivo no parece un Excel (.xlsx) válido.');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('El archivo Excel está dañado.');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    entries.set(buf.toString('utf8', off + 46, off + 46 + nameLen), { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.localOff + 30 + buf.readUInt16LE(e.localOff + 26) + buf.readUInt16LE(e.localOff + 28);
    const data = buf.subarray(start, start + e.compSize);
    // Tope de 10 MB por archivo interno, por si el .xlsx está manipulado para ocupar muchísimo al descomprimirse.
    return (e.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: MAX_XML })).toString('utf8');
  };
}

// Código numérico de una entidad -> carácter (los no válidos se descartan).
const fromCode = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => fromCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

// Recorre las etiquetas <name …>contenido</name> (o <name …/>) con indexOf, en tiempo lineal:
// las expresiones regulares perezosas se vuelven cuadráticas si faltan los cierres.
// Si una etiqueta no se cierra, se deja de leer.
function* tags(xml, name, { content = true } = {}) {
  const open = `<${name}`;
  const close = `</${name}>`;
  let i = 0;
  for (;;) {
    i = xml.indexOf(open, i);
    if (i < 0) return;
    const next = xml[i + open.length];
    if (next !== '>' && next !== '/' && next !== ' ' && next !== '\t' && next !== '\n' && next !== '\r') {
      i += open.length;
      continue;
    }
    const end = xml.indexOf('>', i);
    if (end < 0) return;
    const selfClosing = xml[end - 1] === '/';
    const attrs = xml.slice(i + open.length, selfClosing ? end - 1 : end);
    if (selfClosing || !content) {
      yield { attrs, inner: '' };
      i = end + 1;
      continue;
    }
    const stop = xml.indexOf(close, end + 1);
    if (stop < 0) return;
    yield { attrs, inner: xml.slice(end + 1, stop) };
    i = stop + close.length;
  }
}

// Valor de un atributo name="…" (sin expresiones regulares, por el mismo motivo).
function attr(attrs, name) {
  let i = 0;
  for (;;) {
    i = attrs.indexOf(`${name}="`, i);
    if (i < 0) return null;
    if (i === 0 || /\s/.test(attrs[i - 1])) {
      const start = i + name.length + 2;
      const end = attrs.indexOf('"', start);
      return end < 0 ? null : attrs.slice(start, end);
    }
    i += name.length;
  }
}

const textOf = (xml) => Array.from(tags(xml, 't'), (t) => decode(t.inner)).join('');

// «AB12» -> 27. Rechaza referencias imposibles (más de 3 letras o más allá de XFD).
function colIndex(ref) {
  const letters = ref.match(/^[A-Z]{1,3}(?=\d)/)?.[0];
  if (!letters) throw new Error('El Excel tiene una referencia de celda no válida.');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  if (n > MAX_COLS) throw new Error('El Excel tiene una referencia de celda no válida.');
  return n - 1;
}

export function readXlsxRows(buf) {
  try {
    return readRows(buf);
  } catch (err) {
    // Lecturas fuera del búfer (ZIP truncado o manipulado), descompresión excesiva, etc.
    if (err instanceof RangeError || err.code?.startsWith?.('ERR_')) throw new Error('El archivo Excel está dañado o es demasiado grande.');
    throw err;
  }
}

function readRows(buf) {
  const read = openZip(buf);
  const shared = Array.from(tags(read('xl/sharedStrings.xml') || '', 'si'), (t) => textOf(t.inner));

  // Primera hoja según el libro; si no, sheet1.xml.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const first = tags(read('xl/workbook.xml') || '', 'sheet', { content: false }).next().value;
  const rid = first && attr(first.attrs, 'r:id');
  let target = null;
  if (rid) {
    for (const rel of tags(read('xl/_rels/workbook.xml.rels') || '', 'Relationship', { content: false })) {
      if (attr(rel.attrs, 'Id') === rid) {
        target = attr(rel.attrs, 'Target');
        break;
      }
    }
  }
  if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const sheet = read(sheetPath);
  if (!sheet) throw new Error('No encuentro la hoja de cálculo dentro del archivo.');

  const rows = [];
  let cells = 0;
  for (const rowTag of tags(sheet, 'row')) {
    const row = [];
    for (const c of tags(rowTag.inner, 'c')) {
      const ref = attr(c.attrs, 'r');
      const type = attr(c.attrs, 't');
      const v = tags(c.inner, 'v').next().value?.inner;
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(c.inner);
      else if (v != null) value = decode(v);
      const col = ref && /^[A-Z]+\d+$/.test(ref) ? colIndex(ref) : row.length;
      if (col >= MAX_COLS) throw new Error('El Excel tiene demasiadas columnas.');
      row[col] = value;
    }
    if (!row.length) continue;
    cells += row.length;
    if (rows.length >= MAX_ROWS) throw new Error(`El Excel tiene demasiadas filas (máximo ${MAX_ROWS.toLocaleString('es-ES')}).`);
    if (cells > MAX_CELLS) throw new Error('El Excel tiene demasiadas celdas.');
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}
