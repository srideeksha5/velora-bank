import { FirestoreRest } from './firestore-rest.js';
import { FirebaseAuthRest } from './firebase-auth-rest.js';

export const BANK_ID = 'P649';
export const BANK_NAME = 'Velora Bank';
export const BANK_IFSC = 'DEEK0W3A6KR';
export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'velora-bank-36fcd';

if (!process.env.FIREBASE_WEB_API_KEY) {
  throw new Error('FIREBASE_WEB_API_KEY is required in backend/velora/.env');
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error('GOOGLE_APPLICATION_CREDENTIALS must point to a Velora service-account JSON file outside this repository.');
}

export const auth = new FirebaseAuthRest({ apiKey: process.env.FIREBASE_WEB_API_KEY });
export const db = new FirestoreRest({
  projectId: PROJECT_ID,
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
});
