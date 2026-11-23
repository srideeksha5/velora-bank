import { db, BANK_ID, BANK_NAME, BANK_IFSC } from '../src/firebase.js';

export const nowIso = () => new Date().toISOString();
export const moneyFields = data => {
  const posted = Number.isSafeInteger(data.postedBalanceMinor) ? data.postedBalanceMinor : 0;
  const held = Number.isSafeInteger(data.heldMinor) ? data.heldMinor : 0;
  return { postedBalanceMinor: posted, heldMinor: held, availableMinor: posted - held };
};
function safeAccount(doc) {
  const data = doc.data();
  return { accountId: doc.id, accountNumber: data.accountNumber || '', accountType: data.accountType || data.type || 'Savings', currency: data.currency || 'INR', status: data.status || 'UNKNOWN', ...moneyFields(data), createdAt: data.createdAt || null };
}
export async function getCustomerAccounts(uid) {
  const snap = await db.collection('accounts').where('customerUid', '==', uid).limit(100).get();
  return snap.docs.map(safeAccount);
}
export async function getOwnedAccount(accountId, uid) {
  const snap = await db.collection('accounts').doc(accountId).get();
  if (!snap.exists || snap.get('customerUid') !== uid) return null;
  return safeAccount(snap);
}
export async function getCustomerLedger(uid, limit = 100) {
  const accounts = await getCustomerAccounts(uid), rows = [];
  for (const account of accounts) {
    const snap = await db.collection('ledger_entries').where('accountId', '==', account.accountId).limit(250).get();
    for (const doc of snap.docs) rows.push({ id: doc.id, ...doc.data(), accountId: account.accountId });
  }
  rows.sort((a,b) => new Date(b.postedAt || b.createdAt || 0) - new Date(a.postedAt || a.createdAt || 0));
  return { rows: rows.slice(0, limit), total: rows.length, accounts };
}
export function cleanText(value, max = 120) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
export function publicData(doc) { return { id: doc.id, ...doc.data() }; }
export async function ensureCustomerProfile(uid, decoded = {}) {
  const ref = db.collection('customer_profiles').doc(uid), snap = await ref.get(), source = snap.exists ? snap.data() : {};
  const profile = { uid, bankId: BANK_ID, bankName: BANK_NAME, ifsc: BANK_IFSC };
  for (const key of ['displayName','email','phone','address','city','postalCode','kycStatus','createdAt','updatedAt']) if (source[key] !== undefined) profile[key] = source[key];
  if (!profile.email) profile.email = decoded.email || '';
  if (!profile.displayName) profile.displayName = decoded.name || '';
  if (!snap.exists) await ref.set({ uid, bankId: BANK_ID, displayName: profile.displayName, email: profile.email, createdAt: nowIso(), updatedAt: nowIso() }, { merge: true });
  return profile;
}
export const serverTimestamp = nowIso;
