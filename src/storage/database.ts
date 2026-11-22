import { initialState, schemaVersion, type State } from '../engine/engine.ts';

const stores = ['progress', 'dailyStats', 'settings', 'reviewQueue', 'appMeta'] as const;
type Store = typeof stores[number];
interface Entry {
  key: string;
  value: unknown;
}

export class StaleStateError extends Error {}

export function openDatabase(name = 'kana-loop'): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, schemaVersion);
    request.onupgradeneeded = () => {
      const keyPaths: Record<Store, string> = {
        progress: 'kanaId', dailyStats: 'localDate', settings: 'key', reviewQueue: 'kanaId', appMeta: 'key',
      };
      for (const name of stores) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath: keyPaths[name] });
        }
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('다른 탭을 닫은 뒤 다시 열어 주세요.'));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

const complete = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
});

function readAll(transaction: IDBTransaction, name: Store): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = transaction.objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function recordValues<T>(entries: unknown[], key: string): Record<string, T> {
  return Object.fromEntries(entries.map((entry) => {
    const { [key]: id, ...value } = entry as Record<string, unknown>;
    return [id, value];
  }));
}

export async function loadState(db: IDBDatabase): Promise<{ state: State; revision: number }> {
  const state = initialState();
  const transaction = db.transaction(stores, 'readonly');
  const [progress, daily, settings, reviews, meta] = await Promise.all([
    ...stores.map((name) => readAll(transaction, name)), complete(transaction),
  ]) as [unknown[], unknown[], Entry[], unknown[], Entry[], void];
  const metadata = Object.fromEntries(meta.map(({ key, value }) => [key, value]));
  return {
    state: {
      progress: recordValues(progress, 'kanaId'),
      dailyStats: recordValues(daily, 'localDate'),
      reviewQueue: recordValues(reviews, 'kanaId'),
      settings: (settings.find(({ key }) => key === 'preferences')?.value as State['settings']) ?? state.settings,
      appMeta: (metadata.state as State['appMeta']) ?? state.appMeta,
    },
    revision: typeof metadata.revision === 'number' ? metadata.revision : 0,
  };
}

function syncRecords<T extends object>(
  store: IDBObjectStore, key: string, before: Record<string, T>, after: Record<string, T>,
): void {
  for (const id of Object.keys(before)) {
    if (!Object.hasOwn(after, id)) store.delete(id);
  }
  for (const [id, record] of Object.entries(after)) {
    if (JSON.stringify(record) !== JSON.stringify(before[id])) store.put({ ...record, [key]: id });
  }
}

export async function saveState(db: IDBDatabase, before: State, after: State, revision: number): Promise<number> {
  const transaction = db.transaction(stores, 'readwrite');
  const finished = complete(transaction);
  const meta = transaction.objectStore('appMeta');
  const request = meta.get('revision');
  let failure: unknown;
  request.onsuccess = () => {
    try {
      if ((request.result?.value ?? 0) !== revision) {
        throw new StaleStateError('다른 탭에서 기록이 바뀌었습니다. 화면을 새로고침해 주세요.');
      }
      syncRecords(transaction.objectStore('progress'), 'kanaId', before.progress, after.progress);
      syncRecords(transaction.objectStore('dailyStats'), 'localDate', before.dailyStats, after.dailyStats);
      syncRecords(transaction.objectStore('reviewQueue'), 'kanaId', before.reviewQueue, after.reviewQueue);
      if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) {
        transaction.objectStore('settings').put({ key: 'preferences', value: after.settings });
      }
      meta.put({ key: 'state', value: after.appMeta });
      meta.put({ key: 'revision', value: revision + 1 });
    } catch (error) {
      failure = error;
      transaction.abort();
    }
  };
  try {
    await finished;
  } catch (error) {
    throw failure ?? error;
  }
  return revision + 1;
}

// Hold a same-origin write lock until the document is left. The database
// revision check still protects writes in browsers without Web Locks.
export function claimWriter(): Promise<{ writable: boolean; release: () => void }> {
  if (!navigator.locks) return Promise.resolve({ writable: true, release: () => {} });
  return new Promise((resolve, reject) => {
    navigator.locks.request('kana-loop/writer', { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve({ writable: false, release: () => {} });
        return;
      }
      return new Promise<void>((release) => resolve({ writable: true, release }));
    }).catch(reject);
  });
}
