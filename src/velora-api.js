const defaultApi = import.meta.env.VITE_VELORA_API_URL || 'http://localhost:8788';
export const veloraApiBase = defaultApi.replace(/\/$/, '');
let firebaseSession = null;
export function clearVeloraFirebaseSession() { firebaseSession = null; }

async function parseResponse(response, fallback) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || fallback);
  return result;
}
async function refreshFirebaseToken() {
  if (!firebaseSession?.refreshToken) throw new Error('Your individual Velora session expired. Sign in again.');
  const result = await parseResponse(await fetch(`${veloraApiBase}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: firebaseSession.refreshToken }), credentials: 'omit', redirect: 'error',
  }), 'Your individual Velora session expired. Sign in again.');
  firebaseSession = { ...firebaseSession, idToken: result.idToken, refreshToken: result.refreshToken, uid: result.uid };
  return firebaseSession.idToken;
}

export async function signInToVeloraFirebase(email, password) {
  if (!veloraApiBase) throw new Error('Set VITE_VELORA_API_URL in the frontend .env file.');
  const result = await parseResponse(await fetch(`${veloraApiBase}/auth/sign-in`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }), credentials: 'omit', redirect: 'error',
  }), 'Individual Velora Firebase sign-in failed.');
  firebaseSession = { idToken: result.idToken, refreshToken: result.refreshToken, uid: result.uid, expiresIn: Number(result.expiresIn || 3600) };
  return { ...firebaseSession };
}

export async function veloraApi(path, { token, data, method, signal } = {}) {
  if (!veloraApiBase) throw new Error('Set VITE_VELORA_API_URL in the frontend .env file.');
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (data !== undefined) headers.set('Content-Type', 'application/json');
  const request = currentToken => {
    const requestHeaders = new Headers(headers);
    if (currentToken) requestHeaders.set('Authorization', `Bearer ${currentToken}`);
    return fetch(`${veloraApiBase}/api/v1${path}`, {
      method: method || (data !== undefined ? 'POST' : 'GET'), headers: requestHeaders,
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      credentials: 'omit', redirect: 'error', signal,
    });
  };
  let response;
  try {
    response = await request(firebaseSession?.idToken || token);
    if (response.status === 401 && firebaseSession?.refreshToken) response = await request(await refreshFirebaseToken());
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error(error?.message || 'Could not reach the individual Velora API. Start the backend on port 8788 and check VITE_VELORA_API_URL.');
  }
  return parseResponse(response, `Velora API returned HTTP ${response.status}.`);
}
