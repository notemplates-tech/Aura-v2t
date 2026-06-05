export interface SavedSession {
  id: number; // Unix timestamp
  title: string; // Document filename or title
  timestamp: string; // Human-readable date string
  transcript: string; // Raw speech-to-text text
  summary: string; // Smart summary
  detailedAnalysis: string; // Detailed analysis report
  sentiment: {
    score: number;
    label: string;
    emoji: string;
    explanation?: string;
  } | null;
  detectedLanguage: string;
  tags: string[];
  recordingDuration: number; // Second duration of recording
  audioBlob?: Blob; // Actual audio/video file for offline playback
}

export interface QueuedDriveSync {
  id: number; // Unix timestamp
  title: string; // Document title
  content: string; // Content to save
  timestamp: string; // Human-readable timestamp
}

const DB_NAME = 'AuraVoiceAI_LocalDB';
const STORE_NAME = 'sessions';
const QUEUE_STORE_NAME = 'drive_queue';
const DB_VERSION = 3;

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Не удалось открыть локальную базу данных IndexedDB.'));
    };

    request.onsuccess = (event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
        db.createObjectStore(QUEUE_STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

export async function saveSession(session: Omit<SavedSession, 'id'> & { id?: number }): Promise<number> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    const id = session.id || Date.now();
    const fullSession: SavedSession = {
      ...session,
      id,
    };

    const request = store.put(fullSession);

    request.onsuccess = () => {
      resolve(id);
    };

    request.onerror = () => {
      reject(new Error('Ошибка при сохранении сессии в IndexedDB.'));
    };
  });
}

export async function getSessions(): Promise<SavedSession[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      // Sort sessions descending by id (timestamp, newest first)
      const sorted = (request.result as SavedSession[]).sort((a, b) => b.id - a.id);
      resolve(sorted);
    };

    request.onerror = () => {
      reject(new Error('Не удалось загрузить сохраненные сессии.'));
    };
  });
}

export async function deleteSession(id: number): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(new Error('Не удалось удалить сессию из локального хранилища.'));
    };
  });
}

export async function getSession(id: number): Promise<SavedSession | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(new Error('Не удалось получить сессию.'));
    };
  });
}

export async function renameSession(id: number, newTitle: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
      const session = request.result as SavedSession;
      if (session) {
        session.title = newTitle;
        const putReq = store.put(session);
        putReq.onsuccess = () => {
          resolve();
        };
        putReq.onerror = () => {
          reject(new Error('Не удалось обновить название сессии.'));
        };
      } else {
        reject(new Error('Сессия не найдена.'));
      }
    };

    request.onerror = () => {
      reject(new Error('Не удалось получить сессию для переименования.'));
    };
  });
}

export async function addQueuedDriveSync(title: string, content: string): Promise<number> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(QUEUE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    const id = Date.now();
    const item: QueuedDriveSync = {
      id,
      title,
      content,
      timestamp: new Date().toLocaleString('ru-RU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    };
    const request = store.put(item);
    request.onsuccess = () => resolve(id);
    request.onerror = () => reject(new Error('Не удалось добавить в очередь синхронизации.'));
  });
}

export async function getQueuedDriveSyncs(): Promise<QueuedDriveSync[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(QUEUE_STORE_NAME, 'readonly');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const sorted = (request.result as QueuedDriveSync[]).sort((a, b) => a.id - b.id);
      resolve(sorted);
    };
    request.onerror = () => reject(new Error('Не удалось прочитать очередь синхронизации.'));
  });
}

export async function deleteQueuedDriveSync(id: number): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(QUEUE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(QUEUE_STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Не удалось удалить элемент из очереди.'));
  });
}


