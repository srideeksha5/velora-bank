import { Router } from 'express';
import { db, BANK_ID, BANK_NAME, BANK_IFSC } from '../firebase.js';
import { requireFirebaseUser, requireAdmin } from '../middleware/auth.js';
import { cleanText, ensureCustomerProfile, getCustomerAccounts, getOwnedAccount, getCustomerLedger, publicData, serverTimestamp } from '../../services/banking.js';

const router = Router();
const accountNumberPattern = /^[A-Z0-9]{6,20}$/i;
const ifscPattern = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const loanTypes = new Set(['PERSONAL', 'HOME', 'EDUCATION', 'VEHICLE']);
const error = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const id = () => crypto.randomUUID().replaceAll('-', '');

router.use('/:bankId', (req, res, next) => {
  if (req.params.bankId !== BANK_ID) return error(res, 404, 'BANK_NOT_FOUND', 'This API serves Velora Bank only.');
  next();
}, requireFirebaseUser);

// Customer profile: only safe, explicitly allowed fields can be edited.
router.get('/:bankId/profile', async (req, res, next) => {
  try { return res.json({ profile: await ensureCustomerProfile(req.user.uid, req.user) }); } catch (e) { next(e); }
});
router.patch('/:bankId/profile', async (req, res, next) => {
  try {
    const allowed = ['displayName', 'phone', 'address', 'city', 'postalCode'];
    const update = {};
    for (const key of allowed) if (req.body?.[key] !== undefined) {
      if (typeof req.body[key] !== 'string' || req.body[key].length > 180) return error(res, 400, 'VALIDATION', `Invalid ${key}.`);
      update[key] = req.body[key].trim();
    }
    if (!Object.keys(update).length) return error(res, 400, 'EMPTY_UPDATE', 'Provide at least one editable profile field.');
    update.updatedAt = serverTimestamp();
    const ref = db.collection('customer_profiles').doc(req.user.uid);
    await ref.set({ uid: req.user.uid, bankId: BANK_ID, ...update }, { merge: true });
    return res.json({ profile: await ensureCustomerProfile(req.user.uid, req.user) });
  } catch (e) { next(e); }
});

// Customer accounts are read-only here. Existing transfer service remains the only writer of balances.
router.get('/:bankId/accounts', async (req, res, next) => {
  try { return res.json({ accounts: await getCustomerAccounts(req.user.uid) }); } catch (e) { next(e); }
});
router.get('/:bankId/accounts/:accountId', async (req, res, next) => {
  try {
    const account = await getOwnedAccount(req.params.accountId, req.user.uid);
    if (!account) return error(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    return res.json({ account });
  } catch (e) { next(e); }
});

// Beneficiary records belong to the authenticated customer.
router.get('/:bankId/beneficiaries', async (req, res, next) => {
  try {
    const snap = await db.collection('beneficiaries').where('uid', '==', req.user.uid).limit(100).get();
    return res.json({ beneficiaries: snap.docs.map(doc => { const d = doc.data(); return { id: doc.id, beneficiaryId: doc.id, name: d.name || '', accountNumber: d.accountNumber || '', ifsc: d.ifsc || '', bankName: d.bankName || '', createdAt: d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : d.createdAt || null }; }) });
  } catch (e) { next(e); }
});
router.post('/:bankId/beneficiaries', async (req, res, next) => {
  try {
    const name = cleanText(req.body?.name, 100), accountNumber = cleanText(req.body?.accountNumber, 20).toUpperCase(), ifsc = cleanText(req.body?.ifsc, 11).toUpperCase();
    if (!name || !accountNumberPattern.test(accountNumber) || !ifscPattern.test(ifsc)) return error(res, 400, 'VALIDATION', 'Enter a beneficiary name, 6–20 digit account number and valid IFSC.');
    if (accountNumber === '') return error(res, 400, 'VALIDATION', 'Account number is required.');
    const beneficiaryId = id();
    const record = { beneficiaryId, uid: req.user.uid, bankId: BANK_ID, name, accountNumber, ifsc, createdAt: serverTimestamp() };
    await db.collection('beneficiaries').doc(beneficiaryId).create(record);
    return res.status(201).json({ beneficiary: { ...record, createdAt: new Date().toISOString() } });
  } catch (e) { next(e); }
});
router.delete('/:bankId/beneficiaries/:beneficiaryId', async (req, res, next) => {
  try {
    const ref = db.collection('beneficiaries').doc(req.params.beneficiaryId), snap = await ref.get();
    if (!snap.exists || snap.get('uid') !== req.user.uid) return error(res, 404, 'BENEFICIARY_NOT_FOUND', 'Beneficiary not found.');
    await ref.delete(); return res.json({ ok: true });
  } catch (e) { next(e); }
});

// Read-only customer transaction history from the existing individual ledger.
router.get('/:bankId/transactions', async (req, res, next) => {
  try {
    const requested = Number(req.query.limit || 50), limit = Number.isInteger(requested) ? Math.min(100, Math.max(1, requested)) : 50;
    const { rows, total } = await getCustomerLedger(req.user.uid, 250);
    const offset = Math.max(0, Number(req.query.offset || 0));
    return res.json({ transactions: rows.slice(offset, offset + limit), total, limit, offset });
  } catch (e) { next(e); }
});
router.get('/:bankId/transactions/:transferId', async (req, res, next) => {
  try {
    const { rows } = await getCustomerLedger(req.user.uid, 250);
    const matching = rows.filter(row => row.transferId === req.params.transferId || row.id === req.params.transferId);
    if (!matching.length) return error(res, 404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.');
    return res.json({ transaction: matching });
  } catch (e) { next(e); }
});

// Loan application workflow. Applications are created as PENDING; approvals/disbursements are admin-only separate workflows.
router.get('/:bankId/loans', async (req, res, next) => {
  try {
    const snap = await db.collection('loans').where('uid', '==', req.user.uid).limit(100).get();
    return res.json({ loans: snap.docs.map(doc => { const d = doc.data(); return { id: doc.id, loanId: doc.id, accountId: d.accountId, loanType: d.loanType, requestedMinor: d.requestedMinor, tenureMonths: d.tenureMonths, status: d.status, createdAt: d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : d.createdAt || null, updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : d.updatedAt || null }; }) });
  } catch (e) { next(e); }
});
router.post('/:bankId/loans', async (req, res, next) => {
  try {
    const loanType = cleanText(req.body?.loanType, 20).toUpperCase();
    const requestedMinor = req.body?.requestedMinor, tenureMonths = req.body?.tenureMonths;
    if (!loanTypes.has(loanType) || !Number.isSafeInteger(requestedMinor) || requestedMinor <= 0 || !Number.isInteger(tenureMonths) || tenureMonths < 1 || tenureMonths > 360) return error(res, 400, 'VALIDATION', 'Enter a supported loan type, amount in paise and tenure between 1 and 360 months.');
    const accounts = await getCustomerAccounts(req.user.uid);
    const accountId = cleanText(req.body?.accountId, 80) || accounts[0]?.accountId;
    if (!accountId || !accounts.some(account => account.accountId === accountId)) return error(res, 422, 'ACCOUNT_REQUIRED', 'Select an account owned by your profile.');
    const loanId = id(), record = { loanId, uid: req.user.uid, bankId: BANK_ID, accountId, loanType, requestedMinor, tenureMonths, status: 'PENDING', createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    await db.collection('loans').doc(loanId).create(record);
    return res.status(201).json({ loan: { ...record, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  } catch (e) { next(e); }
});
router.get('/:bankId/loans/:loanId', async (req, res, next) => {
  try {
    const snap = await db.collection('loans').doc(req.params.loanId).get();
    if (!snap.exists || snap.get('uid') !== req.user.uid) return error(res, 404, 'LOAN_NOT_FOUND', 'Loan application not found.');
    return res.json({ loan: publicData(snap) });
  } catch (e) { next(e); }
});

// Overview is calculated from authoritative account fields and ledger entries; browser totals are never trusted.
router.get('/:bankId/analytics/overview', async (req, res, next) => {
  try {
    const { rows, accounts } = await getCustomerLedger(req.user.uid, 500);
    const totalAvailableMinor = accounts.reduce((sum, a) => sum + a.availableMinor, 0);
    const totalHeldMinor = accounts.reduce((sum, a) => sum + a.heldMinor, 0);
    const now = new Date(), month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let monthlyCreditsMinor = 0, monthlyDebitsMinor = 0;
    for (const entry of rows) {
      const date = entry.postedAt?.toDate ? entry.postedAt.toDate() : new Date(entry.postedAt || entry.createdAt || 0);
      if (!Number.isNaN(date.getTime()) && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` === month) {
        if (entry.direction === 'CREDIT') monthlyCreditsMinor += Number(entry.amountMinor || 0);
        if (entry.direction === 'DEBIT') monthlyDebitsMinor += Number(entry.amountMinor || 0);
      }
    }
    return res.json({ totalAvailableMinor, totalHeldMinor, monthlyCreditsMinor, monthlyDebitsMinor, currency: 'INR' });
  } catch (e) { next(e); }
});

// Administrator endpoints use Firebase custom claims (admin=true or role=ADMIN).
router.get('/:bankId/admin/customers', requireAdmin, async (req, res, next) => {
  try {
    const snap = await db.collection('customer_profiles').limit(200).get();
    return res.json({ customers: snap.docs.map(publicData) });
  } catch (e) { next(e); }
});
router.patch('/:bankId/admin/customers/:uid/kyc', requireAdmin, async (req, res, next) => {
  try {
    const status = cleanText(req.body?.status, 20).toUpperCase();
    if (!['PENDING', 'APPROVED', 'REJECTED', 'ON_HOLD'].includes(status)) return error(res, 400, 'VALIDATION', 'KYC status must be PENDING, APPROVED, REJECTED or ON_HOLD.');
    const ref = db.collection('customer_profiles').doc(req.params.uid);
    if (!(await ref.get()).exists) return error(res, 404, 'CUSTOMER_NOT_FOUND', 'Customer profile not found.');
    await ref.set({ kycStatus: status, kycReviewedBy: req.user.uid, kycReviewedAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
    return res.json({ ok: true, uid: req.params.uid, kycStatus: status });
  } catch (e) { next(e); }
});
router.get('/:bankId/admin/loans', requireAdmin, async (req, res, next) => {
  try {
    const snap = await db.collection('loans').limit(200).get();
    return res.json({ loans: snap.docs.map(doc => { const d = doc.data(); return { id: doc.id, loanId: doc.id, accountId: d.accountId, loanType: d.loanType, requestedMinor: d.requestedMinor, tenureMonths: d.tenureMonths, status: d.status, createdAt: d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : d.createdAt || null, updatedAt: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : d.updatedAt || null }; }) });
  } catch (e) { next(e); }
});
router.patch('/:bankId/admin/loans/:loanId/review', requireAdmin, async (req, res, next) => {
  try {
    const status = cleanText(req.body?.status, 20).toUpperCase();
    if (!['APPROVED', 'REJECTED', 'ON_HOLD'].includes(status)) return error(res, 400, 'VALIDATION', 'Loan review status must be APPROVED, REJECTED or ON_HOLD.');
    const ref = db.collection('loans').doc(req.params.loanId), snap = await ref.get();
    if (!snap.exists) return error(res, 404, 'LOAN_NOT_FOUND', 'Loan application not found.');
    await ref.set({ status, reviewedBy: req.user.uid, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
    return res.json({ ok: true, loanId: req.params.loanId, status });
  } catch (e) { next(e); }
});

router.get('/:bankId/health', (req, res) => res.json({ ok: true, bankId: BANK_ID, bankName: BANK_NAME, ifsc: BANK_IFSC }));
export default router;
