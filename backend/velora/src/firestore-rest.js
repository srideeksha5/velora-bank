import { getGoogleAccessToken } from './google-oauth.js';

function encodeValue(value) {
  if (value === null) return { nullValue: 'NULL_VALUE' };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === 'object') return { mapValue: { fields: encodeFields(value) } };
  return { nullValue: 'NULL_VALUE' };
}
function encodeFields(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data || {})) fields[key] = encodeValue(value);
  return fields;
}
function decodeValue(value = {}) {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}
function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}
class Snapshot {
  constructor(name, fields, exists = true) {
    this.id = name?.split('/').at(-1) || '';
    this.exists = exists;
    this._data = exists ? decodeFields(fields) : undefined;
  }
  data() { return this._data; }
  get(field) { return this._data?.[field]; }
}

export class FirestoreRest {
  constructor({ projectId, credentialsPath, databaseId = '(default)' }) {
    this.projectId = projectId;
    this.credentialsPath = credentialsPath;
    this.databaseId = databaseId;
    this.base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents`;
  }
  async request(url, options = {}) {
    const token = await getGoogleAccessToken(this.credentialsPath);
    const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body.error?.message || `Firestore REST request failed (${response.status}).`;
      const error = new Error(message); error.status = response.status; throw error;
    }
    return body;
  }
  collection(name) { return new CollectionRef(this, name); }
  docPath(collection, id) { return `${this.base}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`; }
}
class CollectionRef {
  constructor(db, name) { this.db = db; this.name = name; }
  doc(id) { return new DocumentRef(this.db, this.name, id); }
  where(field, op, value) { return new QueryRef(this.db, this.name, [{ field, op, value }]); }
  limit(n) { return new QueryRef(this.db, this.name, [], n); }
}
class QueryRef {
  constructor(db, collection, filters = [], max = 100) { this.db = db; this.collection = collection; this.filters = filters; this.max = max; }
  limit(n) { return new QueryRef(this.db, this.collection, this.filters, n); }
  async get() {
    const structuredQuery = { from: [{ collectionId: this.collection }], limit: Math.min(this.max, 500) };
    if (this.filters.length === 1) {
      const f = this.filters[0];
      const opMap = { '==': 'EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL' };
      structuredQuery.where = { fieldFilter: { field: { fieldPath: f.field }, op: opMap[f.op] || 'EQUAL', value: encodeValue(f.value) } };
    } else if (this.filters.length > 1) {
      structuredQuery.where = { compositeFilter: { op: 'AND', filters: this.filters.map(f => ({ fieldFilter: { field: { fieldPath: f.field }, op: 'EQUAL', value: encodeValue(f.value) } })) } };
    }
    const result = await this.db.request(`${this.db.base}:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery }) });
    const docs = (Array.isArray(result) ? result : []).filter(row => row.document).map(row => new Snapshot(row.document.name, row.document.fields));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}
class DocumentRef {
  constructor(db, collection, id) { this.db = db; this.collection = collection; this.id = id; this.path = `${collection}/${id}`; }
  async get() {
    try { const doc = await this.db.request(this.db.docPath(this.collection, this.id)); return new Snapshot(doc.name, doc.fields); }
    catch (e) { if (e.status === 404) return new Snapshot(this.path, {}, false); throw e; }
  }
  async create(data) {
    const url = `${this.db.base}/${encodeURIComponent(this.collection)}?documentId=${encodeURIComponent(this.id)}`;
    const doc = await this.db.request(url, { method: 'POST', body: JSON.stringify({ fields: encodeFields(data) }) });
    return new Snapshot(doc.name, doc.fields);
  }
  async set(data, options = {}) {
    const fields = encodeFields(data);
    const mask = options.merge ? Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&') : '';
    const url = `${this.db.docPath(this.collection, this.id)}${mask ? `?${mask}` : ''}`;
    const doc = await this.db.request(url, { method: 'PATCH', body: JSON.stringify({ fields }) });
    return new Snapshot(doc.name, doc.fields);
  }
  async delete() { await this.db.request(this.db.docPath(this.collection, this.id), { method: 'DELETE' }); }
}
export { encodeValue, decodeValue };
