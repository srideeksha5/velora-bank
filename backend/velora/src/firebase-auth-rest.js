const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1';

export class FirebaseAuthRest {
  constructor({ apiKey }) { this.apiKey = apiKey; }
  async call(url, body, form = false) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body) : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error?.message || 'Firebase Authentication REST request failed.');
      error.status = response.status; error.firebaseCode = result.error?.message; throw error;
    }
    return result;
  }
  signIn(email, password) {
    return this.call(`${IDENTITY}/accounts:signInWithPassword?key=${encodeURIComponent(this.apiKey)}`, { email, password, returnSecureToken: true });
  }
  refresh(refreshToken) {
    return this.call(`${SECURE_TOKEN}/token?key=${encodeURIComponent(this.apiKey)}`, { grant_type: 'refresh_token', refresh_token: refreshToken }, true);
  }
  async verifyIdToken(idToken) {
    const result = await this.call(`${IDENTITY}/accounts:lookup?key=${encodeURIComponent(this.apiKey)}`, { idToken });
    const user = result.users?.[0];
    if (!user?.localId || user.disabled) throw new Error('Firebase user is unavailable or disabled.');
    let claims = {};
    try { claims = user.customAttributes ? JSON.parse(user.customAttributes) : {}; } catch { claims = {}; }
    return { uid: user.localId, email: user.email || '', emailVerified: !!user.emailVerified, ...claims };
  }
}
