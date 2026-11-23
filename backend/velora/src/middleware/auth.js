import { auth, db } from '../firebase.js';

export async function requireFirebaseUser(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'A Firebase ID token is required.' } });
  try {
    req.user = await auth.verifyIdToken(match[1]);
    return next();
  } catch {
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Your individual Velora Firebase session is invalid or expired. Sign in again.' } });
  }
}

export async function requireAdmin(req, res, next) {
  try {
    const admin = await db.collection('admin_users').doc(req.user.uid).get();
    if (admin.exists && admin.get('active') === true) return next();
    return res.status(403).json({ error: { code: 'ADMIN_REQUIRED', message: 'Administrator permission is required.' } });
  } catch (error) { return next(error); }
}
