import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bankRoutes from './routes/bank.js';
import { BANK_ID, BANK_NAME, auth } from './firebase.js';

const app = express();
const port = Number(process.env.PORT || 8788);
const allowedOrigins = (process.env.FRONTEND_ORIGINS || 'http://localhost:5173').split(',').map(x => x.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin is not allowed by Velora API CORS policy.'));
}, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'], maxAge: 600 }));
app.use(express.json({ limit: '32kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'velora-bank-api', bankId: BANK_ID, bankName: BANK_NAME, firebaseMode: 'REST-only' }));
app.post('/auth/sign-in', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Email and password are required.' } });
    const result = await auth.signIn(email, password);
    return res.json({ idToken: result.idToken, refreshToken: result.refreshToken, uid: result.localId, expiresIn: Number(result.expiresIn || 3600), email: result.email || email });
  } catch (error) {
    const code = error.firebaseCode || '';
    const messages = { EMAIL_NOT_FOUND: 'This email is not registered in individual Velora Firebase Authentication.', INVALID_PASSWORD: 'The password does not match the individual Velora Firebase account.', INVALID_LOGIN_CREDENTIALS: 'The individual Velora Firebase email or password is incorrect.', USER_DISABLED: 'This individual Velora Firebase account is disabled.', TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many sign-in attempts. Try again later.' };
    return res.status(401).json({ error: { code: 'FIREBASE_AUTH_FAILED', message: messages[code] || 'Individual Velora Firebase sign-in failed.' } });
  }
});
app.post('/auth/refresh', async (req, res, next) => {
  try {
    const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
    if (!refreshToken) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Refresh token is required.' } });
    const result = await auth.refresh(refreshToken);
    return res.json({ idToken: result.id_token, refreshToken: result.refresh_token, uid: result.user_id, expiresIn: Number(result.expires_in || 3600) });
  } catch { return res.status(401).json({ error: { code: 'SESSION_EXPIRED', message: 'Your individual Velora session expired. Sign in again.' } }); }
});
app.use('/api/v1/banks', bankRoutes);
app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Velora API route not found.' } }));
app.use((err, _req, res, _next) => {
  console.error('Velora API error:', err?.name, err?.message);
  if (err?.message?.includes('CORS')) return res.status(403).json({ error: { code: 'CORS', message: 'This frontend origin is not allowed.' } });
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'The Velora API could not complete this request.' } });
});
app.listen(port, () => console.log(`Velora Bank API listening on http://localhost:${port} for ${BANK_ID}`));
