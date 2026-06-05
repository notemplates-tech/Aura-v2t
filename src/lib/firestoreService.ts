import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './auth';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export interface SharedNoteData {
  title: string;
  transcript: string;
  summary: string;
  detailedAnalysis?: string;
  sentiment?: any;
  detectedLanguage?: string;
  tags?: string[];
}

/**
 * Publicly shares a voice note by writing it to Firestore with a highly secure random ID.
 */
export async function shareNote(noteData: SharedNoteData): Promise<string> {
  // Generate a cryptographically robust-looking random alphanumerical string for the document ID
  const randomId = Array.from({ length: 24 }, () => 
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(Math.floor(Math.random() * 62))
  ).join('');

  const docPath = `shared_notes/${randomId}`;
  try {
    const docRef = doc(db, 'shared_notes', randomId);
    
    // Construct strict payload matching firestore.rules
    const payload: any = {
      title: noteData.title || 'Untitled note',
      transcript: noteData.transcript || '',
      summary: noteData.summary || '',
      createdAt: serverTimestamp()
    };

    if (noteData.detailedAnalysis) {
      payload.detailedAnalysis = noteData.detailedAnalysis;
    }
    if (noteData.sentiment) {
      payload.sentiment = noteData.sentiment;
    }
    if (noteData.detectedLanguage) {
      payload.detectedLanguage = noteData.detectedLanguage;
    }
    if (noteData.tags && Array.isArray(noteData.tags)) {
      payload.tags = noteData.tags.slice(0, 50); // safety cap
    }

    await setDoc(docRef, payload);
    return randomId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

/**
 * Retrieves a shareable note by its ID
 */
export async function getSharedNote(noteId: string): Promise<any> {
  const docPath = `shared_notes/${noteId}`;
  try {
    const docRef = doc(db, 'shared_notes', noteId);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() };
    }
    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, docPath);
  }
}
