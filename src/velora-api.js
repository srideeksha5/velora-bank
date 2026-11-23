const FIREBASE_API_KEY = import.meta.env.VITE_VELORA_FIREBASE_API_KEY || '';
const PROJECT_ID = import.meta.env.VITE_VELORA_FIREBASE_PROJECT_ID || 'velora-bank-36fcd';
const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
let firebaseSession = null;

export function clearVeloraFirebaseSession() { firebaseSession = null; }

function requireConfig() {
  if (!FIREBASE_API_KEY) throw new Error('Velora Firebase is not configured. Add VITE_VELORA_FIREBASE_API_KEY to the GitHub Actions repository variables and rebuild the Pages site.');
}

async function requestJson(url, options = {}, fallback = 'Firebase request failed.') {
  let response;
  try { response = await fetch(url, { credentials: 'omit', redirect: 'error', ...options }); }
  catch (error) { if (error?.name === 'AbortError') throw error; throw new Error('Could not connect to Firebase. Check the project configuration and network connection.'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body.error?.message || '';
    const messages = {
      EMAIL_NOT_FOUND: 'This email is not registered in Velora Firebase Authentication.',
      INVALID_PASSWORD: 'The password does not match the Velora Firebase account.',
      INVALID_LOGIN_CREDENTIALS: 'The Velora Firebase email or password is incorrect.',
      USER_DISABLED: 'This Velora Firebase account is disabled.',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many sign-in attempts. Try again later.',
      PERMISSION_DENIED: 'Firestore denied this request. Check the Velora Firestore Security Rules.',
      UNAUTHENTICATED: 'Your Velora session expired. Sign in again.',
      NOT_FOUND: 'The requested Velora record was not found.',
    };
    throw new Error(messages[code] || body.error?.message || fallback);
  }
  return body;
}

async function refreshFirebaseToken() {
  requireConfig();
  if (!firebaseSession?.refreshToken) throw new Error('Your individual Velora session expired. Sign in again.');
  const result = await requestJson(`${SECURE_TOKEN}/token?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: firebaseSession.refreshToken }),
  }, 'Your Velora session expired. Sign in again.');
  firebaseSession = { ...firebaseSession, idToken: result.id_token, refreshToken: result.refresh_token, uid: result.user_id };
  return firebaseSession.idToken;
}

export async function signInToVeloraFirebase(email, password) {
  requireConfig();
  const result = await requestJson(`${IDENTITY}/accounts:signInWithPassword?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  }, 'Individual Velora Firebase sign-in failed.');
  firebaseSession = { idToken: result.idToken, refreshToken: result.refreshToken, uid: result.localId, expiresIn: Number(result.expiresIn || 3600) };
  return { ...firebaseSession };
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)])) } };
}

function decodeValue(value = {}) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields = {}) { return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)])); }
function decodeDocument(document) {
  if (!document) return null;
  const id = document.name.split('/').pop();
  return { id, ...decodeFields(document.fields || {}) };
}
function authHeaders(token) {
  const current = firebaseSession?.idToken || token;
  if (!current) throw new Error('A Firebase ID token is required. Sign in again.');
  return { Authorization: `Bearer ${current}`, 'Content-Type': 'application/json' };
}

async function firestoreFetch(path, { token, method = 'GET', body, signal } = {}) {
  requireConfig();
  const send = currentToken => fetch(`${FIRESTORE}${path}`, {
    method, headers: authHeaders(currentToken), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'omit', redirect: 'error', signal,
  });
  let response;
  try {
    response = await send(firebaseSession?.idToken || token);
    if (response.status === 401 && firebaseSession?.refreshToken) response = await send(await refreshFirebaseToken());
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (error instanceof Error && error.message.includes('token')) throw error;
    throw new Error('Could not connect to Velora Firestore. Check your Firebase project and internet connection.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = result.error?.status || result.error?.message || '';
    if (response.status === 404) return null;
    if (code === 'PERMISSION_DENIED') throw new Error('Firestore denied this request. Check the deployed Velora Firestore Security Rules.');
    if (response.status === 401) throw new Error('Your Velora session expired. Sign in again.');
    throw new Error(result.error?.message || `Firestore request failed (HTTP ${response.status}).`);
  }
  return result;
}

async function queryCollection(collection, field, value, token, limit = 100) {
  const result = await firestoreFetch(':runQuery', { token, method: 'POST', body: {
    structuredQuery: { from: [{ collectionId: collection }], where: { fieldFilter: {
      field: { fieldPath: field }, op: 'EQUAL', value: encodeValue(value),
    } }, limit },
  } });
  return (Array.isArray(result) ? result : []).map(row => decodeDocument(row.document)).filter(Boolean);
}

async function getDocument(collection, id, token) {
  const result = await firestoreFetch(`/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { token });
  return decodeDocument(result);
}

async function createDocument(collection, id, data, token) {
  const fields = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encodeValue(value)]));
  const result = await firestoreFetch(`/${encodeURIComponent(collection)}?documentId=${encodeURIComponent(id)}`, {
    token, method: 'POST', body: { fields },
  });
  return decodeDocument(result);
}

async function patchDocument(collection, id, data, token) {
  const fields = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encodeValue(value)]));
  const mask = Object.keys(data).map(key => `updateMask.fieldPaths=${encodeURIComponent(key)}`).join('&');
  const result = await firestoreFetch(`/${encodeURIComponent(collection)}/${encodeURIComponent(id)}?${mask}`, {
    token, method: 'PATCH', body: { fields },
  });
  return decodeDocument(result);
}

function uidFromToken(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    return claims.user_id || claims.sub || firebaseSession?.uid || '';
  } catch { return firebaseSession?.uid || ''; }
}

function newId() { return globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now()}${Math.random().toString(16).slice(2)}`; }
const bankId = 'P649';
const isoNow = () => new Date().toISOString();

export async function veloraApi(path, { token, data, method, signal } = {}) {
  const current = firebaseSession?.idToken || token;
  if (!current) throw new Error('A Firebase ID token is required. Sign in again.');
  const uid = firebaseSession?.uid || uidFromToken(current);
  if (!uid) throw new Error('Could not identify the signed-in Velora customer. Sign in again.');
  const parts = path.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'banks' || parts[1] !== bankId) throw new Error('This request is not for Velora Bank.');
  const resource = parts[2];
  const verb = (method || (data !== undefined ? 'POST' : 'GET')).toUpperCase();

  if (resource === 'beneficiaries') {
    if (verb === 'GET') return { beneficiaries: await queryCollection('beneficiaries', 'uid', uid, current) };
    if (verb === 'POST') {
      const name = String(data?.name || '').trim().slice(0, 100);
      const accountNumber = String(data?.accountNumber || '').trim().toUpperCase();
      const ifsc = String(data?.ifsc || '').trim().toUpperCase();
      if (!name || !/^[A-Z0-9]{6,20}$/.test(accountNumber) || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new Error('Enter a beneficiary name, 6–20 character account number and valid IFSC.');
      const beneficiaryId = newId();
      const beneficiary = { beneficiaryId, uid, bankId, name, accountNumber, ifsc, createdAt: isoNow() };
      await createDocument('beneficiaries', beneficiaryId, beneficiary, current);
      return { beneficiary: { id: beneficiaryId, ...beneficiary } };
    }
    if (verb === 'DELETE' && parts[3]) {
      const beneficiary = await getDocument('beneficiaries', parts[3], current);
      if (!beneficiary || beneficiary.uid !== uid) throw new Error('Beneficiary not found.');
      await firestoreFetch(`/beneficiaries/${encodeURIComponent(parts[3])}`, { token: current, method: 'DELETE' });
      return { ok: true };
    }
  }

  if (resource === 'accounts' && verb === 'GET') {
    const accounts = await queryCollection('accounts', 'customerUid', uid, current, 50);
    const safe = accounts.map(a => ({ accountId: a.accountId || a.id, accountNumber: a.accountNumber || '', accountType: a.accountType || a.type || 'Savings', currency: a.currency || 'INR', status: a.status || 'UNKNOWN', postedBalanceMinor: Number(a.postedBalanceMinor || 0), heldMinor: Number(a.heldMinor || 0), availableMinor: Number(a.postedBalanceMinor || 0) - Number(a.heldMinor || 0), createdAt: a.createdAt || null }));
    if (parts[3]) { const account = safe.find(a => a.accountId === parts[3]); return account ? { account } : (() => { throw new Error('Account not found.'); })(); }
    return { accounts: safe };
  }

  if (resource === 'transactions' && verb === 'GET') {
    const accounts = await queryCollection('accounts', 'customerUid', uid, current, 50);
    const accountIds = accounts.map(a => a.accountId || a.id);
    const groups = await Promise.all(accountIds.map(accountId => queryCollection('ledger_entries', 'accountId', accountId, current, 200)));
    const rows = groups.flat().sort((a, b) => new Date(b.postedAt || b.createdAt || 0) - new Date(a.postedAt || a.createdAt || 0));
    const url = new URL(`https://velora.invalid${path}`);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    return { transactions: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
  }

  if (resource === 'loans') {
    if (verb === 'GET') return { loans: await queryCollection('loans', 'uid', uid, current) };
    if (verb === 'POST') {
      const loanType = String(data?.loanType || '').toUpperCase();
      const requestedMinor = data?.requestedMinor, tenureMonths = data?.tenureMonths;
      if (!['PERSONAL', 'HOME', 'EDUCATION', 'VEHICLE'].includes(loanType) || !Number.isSafeInteger(requestedMinor) || requestedMinor <= 0 || !Number.isInteger(tenureMonths) || tenureMonths < 1 || tenureMonths > 360) throw new Error('Enter a supported loan type, positive amount and tenure from 1 to 360 months.');
      const accounts = await queryCollection('accounts', 'customerUid', uid, current, 50);
      const accountId = accounts[0]?.accountId || accounts[0]?.id;
      if (!accountId) throw new Error('No Velora account is linked to this customer.');
      const loanId = newId(), now = isoNow();
      const loan = { loanId, uid, bankId, accountId, loanType, requestedMinor, tenureMonths, status: 'PENDING', createdAt: now, updatedAt: now };
      await createDocument('loans', loanId, loan, current);
      return { loan: { id: loanId, ...loan } };
    }
  }

  if (resource === 'profile') {
    if (verb === 'GET') {
      let profile = await getDocument('customer_profiles', uid, current);
      if (!profile) {
        let claims = {};
        try { claims = JSON.parse(atob(current.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { /* use empty defaults */ }
        profile = { uid, bankId, displayName: claims.name || '', email: claims.email || '', createdAt: isoNow(), updatedAt: isoNow() };
        await createDocument('customer_profiles', uid, profile, current);
      }
      return { profile };
    }
    if (verb === 'PATCH') {
      const allowed = ['displayName', 'phone', 'address', 'city', 'postalCode'];
      const update = Object.fromEntries(allowed.filter(key => data?.[key] !== undefined).map(key => [key, String(data[key]).trim().slice(0, 180)]));
      if (!Object.keys(update).length) throw new Error('Provide at least one editable profile field.');
      update.updatedAt = isoNow();
      await patchDocument('customer_profiles', uid, update, current);
      return { profile: await getDocument('customer_profiles', uid, current) };
    }
  }

  if (resource === 'analytics' && parts[3] === 'overview' && verb === 'GET') {
    const accounts = await queryCollection('accounts', 'customerUid', uid, current, 50);
    const accountIds = accounts.map(a => a.accountId || a.id);
    const totalHeldMinor = accounts.reduce((sum, a) => sum + Number(a.heldMinor || 0), 0);
    const totalAvailableMinor = accounts.reduce((sum, a) => sum + Number(a.postedBalanceMinor || 0) - Number(a.heldMinor || 0), 0);
    const groups = await Promise.all(accountIds.map(accountId => queryCollection('ledger_entries', 'accountId', accountId, current, 200)));
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    let monthlyCreditsMinor = 0, monthlyDebitsMinor = 0;
    for (const entry of groups.flat()) {
      const when = entry.postedAt || entry.createdAt;
      if (!when || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date(when)) !== month) continue;
      if (entry.direction === 'CREDIT') monthlyCreditsMinor += Number(entry.amountMinor || 0);
      if (entry.direction === 'DEBIT') monthlyDebitsMinor += Number(entry.amountMinor || 0);
    }
    return { totalAvailableMinor, totalHeldMinor, monthlyCreditsMinor, monthlyDebitsMinor, currency: 'INR' };
  }

  throw new Error('This Velora feature or operation is not available through the GitHub Pages client.');
}
