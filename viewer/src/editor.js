/**
 * Editing tracks and saving the result back out.
 *
 * Edits are held as a change-set keyed by `content_id` rather than applied to
 * the parsed rows, so the original stays intact, a field can be reverted, and
 * the count of pending changes is always exact.
 *
 * Saving rebuilds the whole database and re-encrypts it. That is heavier than
 * patching bytes in place, but changing a rating from 0 to 5 changes its
 * serial type from "constant zero" to "8-bit integer", so records move anyway.
 */

import { writeDatabase } from './sqlite_write.js';
import { encrypt } from './sqlcipher.js';

/** Fields the viewer lets you change, and how each is presented. */
export const EDITABLE = [
  { field: 'title', label: 'Title', kind: 'text' },
  { field: 'artist', label: 'Artist', kind: 'lookup', table: 'artist', fk: 'artist_id_artist' },
  { field: 'album', label: 'Album', kind: 'lookup', table: 'album', fk: 'album_id' },
  { field: 'genre', label: 'Genre', kind: 'lookup', table: 'genre', fk: 'genre_id' },
  { field: 'djComment', label: 'Comment', kind: 'text' },
  { field: 'rating', label: 'Rating', kind: 'rating' },
  { field: 'color_id', label: 'Colour', kind: 'color' },
];

export class Editor {
  constructor() {
    /** @type {Map<number, Map<string, any>>} content_id -> field -> value */
    this.changes = new Map();
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn(this); }

  get count() {
    let n = 0;
    for (const fields of this.changes.values()) n += fields.size;
    return n;
  }

  get dirty() { return this.count > 0; }

  /** Record an edit, or drop it when the value returns to the original. */
  set(contentId, field, value, original) {
    const norm = (v) => (v === '' || v === undefined ? null : v);
    let fields = this.changes.get(contentId);
    if (norm(value) === norm(original)) {
      fields?.delete(field);
      if (fields && !fields.size) this.changes.delete(contentId);
    } else {
      if (!fields) { fields = new Map(); this.changes.set(contentId, fields); }
      fields.set(field, norm(value));
    }
    this._emit();
    return this;
  }

  get(contentId, field, fallback) {
    const v = this.changes.get(contentId)?.get(field);
    return v === undefined ? fallback : v;
  }

  has(contentId, field) { return this.changes.get(contentId)?.has(field) ?? false; }

  clear() { this.changes.clear(); this._emit(); }
}

/** Next free id in a lookup table. */
function nextId(rows, idCol) {
  return rows.reduce((m, r) => Math.max(m, r[idCol] ?? 0), 0) + 1;
}

/**
 * Apply a change-set to the parsed tables and return a fresh encrypted image.
 *
 * Lookup fields are interned the way rekordbox does it: an existing row is
 * reused when the name already appears, otherwise a new one is appended.
 */
export async function buildEditedDatabase(db, editor, passphrase) {
  const tables = [...db.tables.values()].map((meta) => {
    const alias = /(\w+)\s+integer\s+primary\s+key/i.exec(meta.sql)?.[1] ?? null;
    return {
      name: meta.name,
      sql: meta.sql,
      columns: meta.columns,
      rowidAlias: alias,
      rows: db.select(meta.name).map((r) => ({ ...r, __rowid: alias ? r[alias] : undefined })),
    };
  });
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
  const content = byName.content;

  const intern = (tableName, idCol, name) => {
    if (!name) return null;
    const table = byName[tableName];
    const found = table.rows.find((r) => r.name === name);
    if (found) return found[idCol];
    const id = nextId(table.rows, idCol);
    const row = { __rowid: id };
    for (const c of table.columns) row[c] = null;
    row[idCol] = id;
    row.name = name;
    if ('nameForSearch' in row) row.nameForSearch = name.toUpperCase();
    if ('isComplation' in row) row.isComplation = 0;
    table.rows.push(row);
    return id;
  };

  for (const [contentId, fields] of editor.changes) {
    const row = content.rows.find((r) => r.content_id === contentId);
    if (!row) continue;
    for (const [field, value] of fields) {
      const spec = EDITABLE.find((e) => e.field === field);
      if (spec?.kind === 'lookup') {
        row[spec.fk] = intern(spec.table, `${spec.table}_id`, value);
      } else if (field === 'title') {
        row.title = value;
        row.titleForSearch = value ? String(value).toUpperCase() : null;
      } else {
        row[field] = value;
      }
    }
  }

  const indexes = [...db.tables.values()].length ? collectIndexes(db) : [];
  const image = writeDatabase(tables, indexes);
  return encrypt(image, passphrase);
}

/** Index definitions from sqlite_master, so rebuilt files keep them. */
function collectIndexes(db) {
  const out = [];
  for (const [, row] of db._walk(1)) {
    const [type, name, tbl, , sql] = row;
    if (type !== 'index' || !sql) continue;
    const col = /\(\s*`?(\w+)`?\s*\)/.exec(sql)?.[1];
    if (col) out.push({ name, table: tbl, column: col, sql });
  }
  return out;
}

/**
 * The change-set as JSON, for applying with the Python CLI.
 *
 * Carries the original value alongside the new one so `onelibrary apply` can
 * refuse to overwrite a field that changed on the device since the edit was
 * made, rather than silently clobbering it.
 */
export function exportChangeSet(db, editor) {
  const content = db.select('content');
  const byId = Object.fromEntries(content.map((r) => [r.content_id, r]));
  const edits = [];
  for (const [contentId, fields] of editor.changes) {
    const row = byId[contentId];
    const change = { content_id: contentId, title: row?.title ?? null, fields: {} };
    for (const [field, value] of fields) {
      change.fields[field] = { from: row?.[field] ?? null, to: value };
    }
    edits.push(change);
  }
  return JSON.stringify({ format: 'onelibrary-changeset', version: 1, edits }, null, 2);
}

/**
 * Save the edited library, by whichever route this view supports.
 *
 * Writing back to the stick directly is not one of them. The File System
 * Access API can only hand out a writable directory handle from a picker in a
 * top-level document, and the published page runs in a sandboxed frame where
 * that picker never opens — so saving produces a file and the database is
 * replaced by hand.
 *
 * - `changeset` — the published artifact, whose download allowlist has no
 *   `.db` extension: save JSON for `onelibrary apply`.
 * - `database`  — anywhere else: download the rebuilt database.
 *
 * @returns {Promise<'changeset'|'database'>}
 */
export async function saveEdits(db, editor, passphrase) {
  let downloads = null;
  try {
    downloads = (await globalThis.claude?.use?.('downloads')) ?? null;
  } catch {
    downloads = null;
  }
  if (downloads) {
    await downloads.save({
      filename: 'onelibrary-edits.json',
      data: exportChangeSet(db, editor),
    });
    return 'changeset';
  }

  const bytes = await buildEditedDatabase(db, editor, passphrase);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'exportLibrary.db';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'database';
}
