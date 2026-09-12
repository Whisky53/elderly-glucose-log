/**
 * 最小 IndexedDB 替身，仅覆盖 repo.ts 实际用到的 API：
 * open / onupgradeneeded / createObjectStore / createIndex / transaction /
 * objectStore / put / get / getAll / delete / clear / index().getAll(key)。
 *
 * 目的：在 Node 里跑真实的本地仓库与同步引擎代码，直连真实后端做端到端验证，
 * 不依赖浏览器，也不引入第三方依赖。
 */

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

class FakeObjectStore {
  constructor(name, keyPath, indexes) {
    this.name = name;
    this.keyPath = keyPath;
    this.indexes = indexes; // Map<name, keyPath|string[]>
    this.rows = new Map();
  }

  createIndex(name, keyPath) {
    this.indexes.set(name, keyPath);
    return { name, keyPath };
  }

  _keyOf(value) {
    if (Array.isArray(this.keyPath)) return this.keyPath.map((k) => value[k]).join('\u0000');
    return value[this.keyPath];
  }

  put(value) {
    const req = new FakeRequest();
    this.rows.set(this._keyOf(value), structuredClone(value));
    req.result = this._keyOf(value);
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  get(key) {
    const req = new FakeRequest();
    req.result = this.rows.has(key) ? structuredClone(this.rows.get(key)) : undefined;
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  getAll() {
    const req = new FakeRequest();
    req.result = [...this.rows.values()].map((v) => structuredClone(v));
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  delete(key) {
    const req = new FakeRequest();
    this.rows.delete(key);
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  clear() {
    const req = new FakeRequest();
    this.rows.clear();
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  index(name) {
    const keyPath = this.indexes.get(name);
    if (keyPath === undefined) throw new Error(`索引不存在: ${name}`);
    const store = this;
    return {
      getAll(key) {
        const req = new FakeRequest();
        const read = (value) => (Array.isArray(keyPath) ? keyPath.map((k) => value[k]).join('\u0000') : value[keyPath]);
        req.result = [...store.rows.values()].filter((v) => read(v) === key).map((v) => structuredClone(v));
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    };
  }
}

class FakeTransaction {
  constructor(stores, mode) {
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._stores = stores;
    this._done = false;
    queueMicrotask(() => {
      if (this._done) return;
      this._done = true;
      this.oncomplete?.();
    });
  }

  objectStore(name) {
    const store = this._stores.get(name);
    if (!store) throw new Error(`对象仓库不存在: ${name}`);
    return store;
  }
}

class FakeDatabase {
  constructor(stores) {
    this._stores = stores;
    this.objectStoreNames = {
      contains: (name) => stores.has(name),
    };
  }

  createObjectStore(name, options) {
    const store = new FakeObjectStore(name, options.keyPath, new Map());
    this._stores.set(name, store);
    return store;
  }

  transaction(names, mode) {
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) {
      if (!this._stores.has(n)) throw new Error(`事务引用了不存在的仓库: ${n}`);
    }
    return new FakeTransaction(this._stores, mode);
  }

  close() {}
}

export function createFakeIndexedDB() {
  const databases = new Map();

  return {
    open(name, version) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        let entry = databases.get(name);
        const isNew = !entry;
        if (isNew) {
          entry = { version, db: null };
          entry.db = new FakeDatabase(new Map());
          databases.set(name, entry);
        }
        req.result = entry.db;
        if (isNew || version > entry.version) {
          entry.version = version;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    },
    /** 测试辅助：彻底重置数据库，用于模拟“另一台设备”或全新安装 */
    _reset() {
      databases.clear();
    },
  };
}
