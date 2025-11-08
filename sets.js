// Shared utilities for managing flashcard sets with server sync and local fallback
(() => {
  const API_BASE = '/api/draw';
  const LOCAL_SETS_KEY = 'study_sets_sync_v1';
  const LOCAL_DECK_PREFIX = 'study_deck_sync_v1__';
  const LOCAL_PENDING_KEY = 'study_sync_pending_v1';

  function nowTs() {
    return Date.now();
  }

  function defaultSide() {
    return { strokes: [], images: [] };
  }

  function defaultCard() {
    return { front: defaultSide(), back: defaultSide(), createdAt: nowTs() };
  }

  function apiBase() {
    if (typeof window !== 'undefined') {
      const override = (window.STUDY_API_BASE || (window.localStorage && window.localStorage.getItem && window.localStorage.getItem('study_api_base')));
      if (typeof override === 'string' && override.trim()) {
        return override.replace(/\/$/, '');
      }
    }
    return API_BASE;
  }

  function ensureArray(value, fallback) {
    return Array.isArray(value) ? value : fallback;
  }

  function parseDate(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? nowTs() : parsed;
    }
    return nowTs();
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  const Local = {
    storageKeyFor(setId) {
      return `${LOCAL_DECK_PREFIX}${setId}`;
    },
    readSets() {
      let sets = [];
      const raw = localStorage.getItem(LOCAL_SETS_KEY);
      if (raw) {
        try { sets = JSON.parse(raw) || []; } catch (err) { sets = []; }
      }
      if (!Array.isArray(sets)) sets = [];
      if (!sets.length) {
        const created = nowTs();
        sets = [{ id: 'default', name: 'Default', createdAt: created, updatedAt: created }];
        localStorage.setItem(LOCAL_SETS_KEY, JSON.stringify(sets));
        if (!localStorage.getItem(Local.storageKeyFor('default'))) {
          localStorage.setItem(Local.storageKeyFor('default'), JSON.stringify([defaultCard()]));
        }
      }
      return sets;
    },
    loadSets() {
      return this.readSets().map((set) => ({ ...set }));
    },
    saveSets(sets) {
      localStorage.setItem(LOCAL_SETS_KEY, JSON.stringify(sets));
    },
    getSetById(id) {
      return this.readSets().find((set) => set.id === id) || null;
    },
    createSet(name) {
      const sets = this.readSets();
      const id = `set_${Math.random().toString(36).slice(2, 10)}`;
      const created = nowTs();
      const set = { id, name: name || 'New Set', createdAt: created, updatedAt: created };
      sets.push(set);
      this.saveSets(sets);
      localStorage.setItem(this.storageKeyFor(id), JSON.stringify([defaultCard()]));
      return set;
    },
    renameSet(id, name) {
      const sets = this.readSets();
      const idx = sets.findIndex((set) => set.id === id);
      if (idx >= 0) {
        sets[idx].name = name;
        sets[idx].updatedAt = nowTs();
        this.saveSets(sets);
      }
    },
    deleteSet(id) {
      const sets = this.readSets().filter((set) => set.id !== id);
      this.saveSets(sets);
      localStorage.removeItem(this.storageKeyFor(id));
    },
    loadDeck(id) {
      const raw = localStorage.getItem(this.storageKeyFor(id));
      if (!raw) {
        const deck = [defaultCard()];
        localStorage.setItem(this.storageKeyFor(id), JSON.stringify(deck));
        return deck;
      }
      try {
        const deck = JSON.parse(raw) || [];
        if (!Array.isArray(deck) || !deck.length) {
          return [defaultCard()];
        }
        return deck;
      } catch (err) {
        return [defaultCard()];
      }
    },
    saveDeck(id, deck) {
      localStorage.setItem(this.storageKeyFor(id), JSON.stringify(deck));
    }
  };

  let setsCache = Local.loadSets();
  let pendingCache = loadPending();
  let flushActive = false;

  function loadPending() {
    const raw = localStorage.getItem(LOCAL_PENDING_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      console.warn('Unable to parse pending sync cache', err);
      return {};
    }
  }

  function savePending() {
    try {
      localStorage.setItem(LOCAL_PENDING_KEY, JSON.stringify(pendingCache));
    } catch (err) {
      console.warn('Unable to persist pending sync cache', err);
    }
  }

  function ensurePendingEntry(id) {
    if (!pendingCache[id]) {
      pendingCache[id] = { id, updatedAt: nowTs() };
    }
    return pendingCache[id];
  }

  function clearPendingField(id, field) {
    const entry = pendingCache[id];
    if (!entry) return;
    delete entry[field];
    if (!entry.name && !entry.deck) {
      delete pendingCache[id];
    } else {
      entry.updatedAt = nowTs();
    }
    savePending();
  }

  async function flushPending() {
    if (flushActive) return;
    if (!Object.keys(pendingCache).length) return;
    if (typeof fetch !== 'function') return;
    flushActive = true;
    try {
      const entries = Object.values(pendingCache).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      for (const entry of entries) {
        const { id, name, deck } = entry;
        const encodedId = encodeURIComponent(id);
        try {
          if (deck) {
            await request(`/sets/${encodedId}/deck`, { method: 'PUT', body: { deck, name } });
            clearPendingField(id, 'deck');
          }
          if (name) {
            await request(`/sets/${encodedId}`, { method: 'PUT', body: { name } });
            clearPendingField(id, 'name');
          }
        } catch (err) {
          console.warn('Pending sync failed', id, err);
          if (err && err.status === 404 && deck) {
            try {
              await request('/sets', { method: 'POST', body: { id, name: name || 'New Set', deck } });
              clearPendingField(id, 'deck');
              clearPendingField(id, 'name');
            } catch (createErr) {
              console.warn('Pending create failed', id, createErr);
            }
          }
        }
      }
    } finally {
      flushActive = false;
      savePending();
    }
  }

  function queuePendingDeck(id, deck, name) {
    const entry = ensurePendingEntry(id);
    entry.deck = deck;
    if (name) entry.name = name;
    entry.updatedAt = nowTs();
    savePending();
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      flushPending();
    }
  }

  function queuePendingName(id, name) {
    const entry = ensurePendingEntry(id);
    entry.name = name;
    entry.updatedAt = nowTs();
    savePending();
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      flushPending();
    }
  }

  function collectPendingEntries() {
    const ids = Object.keys(pendingCache);
    if (!ids.length) return [];
    const entries = [];
    for (const id of ids) {
      const entry = pendingCache[id] || {};
      const localSet = Local.getSetById(id);
      const name = entry.name || (localSet && localSet.name) || 'New Set';
      let deck = entry.deck;
      if (!deck) {
        try {
          deck = Local.loadDeck(id);
        } catch (err) {
          deck = null;
        }
      }
      if (!Array.isArray(deck) || !deck.length) {
        deck = null;
      }
      entries.push({ id, name, deck });
    }
    return entries;
  }

  function beaconSyncPending() {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return false;
    }
    const entries = collectPendingEntries().filter((item) => item.deck || item.name);
    if (!entries.length) {
      return false;
    }
    try {
      const payload = JSON.stringify({ sets: entries });
      const blob = new Blob([payload], { type: 'application/json' });
      const base = apiBase();
      return navigator.sendBeacon(`${base}/sync`, blob);
    } catch (err) {
      console.warn('sendBeacon sync failed', err);
      return false;
    }
  }

  function handleLifecycleFlush() {
    if (!Object.keys(pendingCache).length) return;
    const sent = beaconSyncPending();
    if (!sent) {
      flushPending();
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => flushPending());
    window.addEventListener('pagehide', handleLifecycleFlush, { capture: true });
    window.addEventListener('beforeunload', handleLifecycleFlush, { capture: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          flushPending();
        }
      });
    }
  }

  async function request(path, options = {}) {
    if (typeof fetch !== 'function') {
      throw new Error('fetch is not available');
    }
    const { body, headers, ...rest } = options;
    const init = {
      method: 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      ...rest
    };
    if (body !== undefined) {
      init.method = init.method || 'POST';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const base = apiBase();
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    if (!res.ok) {
      const detail = data && (data.detail || data.error);
      const err = new Error(detail || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function normaliseSet(set) {
    if (!set) return null;
    return {
      id: set.id,
      name: set.name || 'Untitled',
      createdAt: parseDate(set.createdAt || set.created_at),
      updatedAt: parseDate(set.updatedAt || set.updated_at || set.createdAt || set.created_at)
    };
  }

  function updateCache(set) {
    const idx = setsCache.findIndex((item) => item.id === set.id);
    if (idx >= 0) {
      setsCache[idx] = set;
    } else {
      setsCache.push(set);
    }
    Local.saveSets(setsCache);
  }

  async function loadSets() {
    try {
      const payload = await request('/sets');
      const sets = ensureArray(payload && payload.sets, Local.loadSets());
      setsCache = sets.map((item) => normaliseSet(item)).filter(Boolean);
      Local.saveSets(setsCache);
      await flushPending();
      return setsCache.map((item) => ({ ...item }));
    } catch (err) {
      console.warn('Falling back to local sets cache', err);
      setsCache = Local.loadSets();
      return setsCache.map((item) => ({ ...item }));
    }
  }

  async function getSetById(id) {
    const existing = setsCache.find((set) => set.id === id);
    if (existing) return { ...existing };
    try {
      const payload = await request(`/sets/${encodeURIComponent(id)}`);
      const set = normaliseSet(payload);
      if (set) {
        updateCache(set);
        return { ...set };
      }
    } catch (err) {
      console.warn('Falling back to local set lookup', err);
    }
    const local = Local.getSetById(id);
    return local ? { ...local } : null;
  }

  async function getSetName(id) {
    const set = await getSetById(id);
    return set ? set.name : '(unknown set)';
  }

  async function createSet(name) {
    const desiredName = (name || 'New Set').trim() || 'New Set';
    try {
      const payload = await request('/sets', { method: 'POST', body: { name: desiredName } });
      const set = normaliseSet(payload) || Local.createSet(desiredName);
      updateCache(set);
      await saveDeck(set.id, [defaultCard()]);
      return { ...set };
    } catch (err) {
      console.warn('Server set creation failed, using local fallback', err);
      const set = Local.createSet(desiredName);
      setsCache = Local.loadSets();
      queuePendingName(set.id, set.name);
      queuePendingDeck(set.id, Local.loadDeck(set.id), set.name);
      return { ...set };
    }
  }

  async function renameSet(id, name) {
    const newName = (name || '').trim();
    if (!newName) return;
    try {
      const payload = await request(`/sets/${encodeURIComponent(id)}`, { method: 'PUT', body: { name: newName } });
      const updated = normaliseSet(payload);
      if (updated) {
        updateCache(updated);
        clearPendingField(id, 'name');
        return { ...updated };
      }
    } catch (err) {
      console.warn('Server rename failed, applying locally', err);
    }
    Local.renameSet(id, newName);
    setsCache = Local.loadSets();
    queuePendingName(id, newName);
    return Local.getSetById(id);
  }

  async function deleteSet(id) {
    try {
      await request(`/sets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      console.warn('Server delete failed, removing locally', err);
    }
    Local.deleteSet(id);
    setsCache = Local.loadSets();
    delete pendingCache[id];
    savePending();
    return true;
  }

  function normaliseDeck(deck) {
    const cleaned = ensureArray(deck, []);
    if (!cleaned.length) {
      return [defaultCard()];
    }
    return cleaned.map((card) => ({ ...card }));
  }

  async function loadDeck(id) {
    try {
      const payload = await request(`/sets/${encodeURIComponent(id)}/deck`);
      const deck = normaliseDeck(payload && payload.deck);
      Local.saveDeck(id, deck);
      clearPendingField(id, 'deck');
      return deepClone(deck);
    } catch (err) {
      console.warn('Falling back to local deck', err);
      return deepClone(Local.loadDeck(id));
    }
  }

  async function saveDeck(id, deck) {
    const prepared = normaliseDeck(deck);
    Local.saveDeck(id, prepared);
    const now = nowTs();
    const cacheIdx = setsCache.findIndex((set) => set.id === id);
    if (cacheIdx >= 0) {
      const cached = { ...setsCache[cacheIdx], updatedAt: now };
      setsCache[cacheIdx] = cached;
    } else {
      setsCache.push({ id, name: (Local.getSetById(id) || { name: 'Untitled' }).name, createdAt: now, updatedAt: now });
    }
    Local.saveSets(setsCache);
    const name = (() => {
      const local = Local.getSetById(id);
      return local ? local.name : undefined;
    })();
    try {
      await request(`/sets/${encodeURIComponent(id)}/deck`, { method: 'PUT', body: { deck: prepared, name } });
      clearPendingField(id, 'deck');
      const pendingName = pendingCache[id] && pendingCache[id].name;
      if (pendingName) {
        try {
          await request(`/sets/${encodeURIComponent(id)}`, { method: 'PUT', body: { name: pendingName } });
          clearPendingField(id, 'name');
        } catch (renameErr) {
          console.warn('Set name sync failed after deck save', renameErr);
        }
      }
    } catch (err) {
      console.warn('Server deck save failed, kept local cache', err);
      queuePendingDeck(id, prepared, name);
    }
    return true;
  }

  flushPending();

  window.SetsAPI = {
    storageKeyFor: Local.storageKeyFor.bind(Local),
    loadSets,
    getSetById,
    getSetName,
    createSet,
    renameSet,
    deleteSet,
    loadDeck,
    saveDeck
  };
})();
