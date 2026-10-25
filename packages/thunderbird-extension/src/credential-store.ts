/** Background-owned extension-origin storage. Profile storage is not encrypted. */
export type CredentialScope = Readonly<{ provider: string; apiBase: string }>;
export interface InferenceCredentialStore {
  get(id: string, scope: CredentialScope): Promise<string | null>;
  put(id: string, key: string, scope: CredentialScope): Promise<void>;
  delete(id: string): Promise<void>;
  retainOnly(id: string | null): Promise<void>;
}

export class IndexedDbInferenceCredentialStore implements InferenceCredentialStore {
  private database: Promise<IDBDatabase> | null = null;
  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}
  private open(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise((resolve, reject) => {
      if (!this.factory) { reject(new Error("Credential storage unavailable")); return; }
      const request = this.factory.open("thunderclaw-inference-credentials-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("credentials");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Credential storage unavailable"));
      request.onblocked = () => reject(new Error("Credential storage unavailable"));
    });
    return this.database;
  }
  private async transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("credentials", mode);
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(new Error("Credential storage unavailable"));
      work(transaction.objectStore("credentials"), (value) => { result = value; });
    });
  }
  get(id: string, scope: CredentialScope): Promise<string | null> {
    return this.transaction("readonly", (store, done) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const value = request.result;
        done(value && value.provider === scope.provider && value.apiBase === scope.apiBase && typeof value.key === "string" ? value.key : null);
      };
    });
  }
  put(id: string, key: string, scope: CredentialScope): Promise<void> { return this.transaction("readwrite", (store) => { store.put({ key, provider: scope.provider, apiBase: scope.apiBase }, id); }); }
  delete(id: string): Promise<void> { return this.transaction("readwrite", (store) => { store.delete(id); }); }
  retainOnly(id: string | null): Promise<void> {
    return this.transaction("readwrite", (store) => {
      const request = store.openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { if (cursor.key !== id) store.delete(cursor.key); cursor.continue(); }
      };
    });
  }
}
