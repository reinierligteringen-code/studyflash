// Shared utilities for managing flashcard sets with server sync and local fallback
(() => {
  const API_BASE = '/api/draw';
  const LOCAL_SETS_KEY = 'study_sets_sync_v1';
  const LOCAL_DECK_PREFIX = 'study_deck_sync_v1__';

  function nowTs() {
    return Date.now();
  }

  function defaultSide() {
    return { strokes: [], images: [] };
  }

  function defaultCard() {
    return { front: defaultSide(), back: defaultSide(), createdAt: nowTs() };
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
    const res = await fetch(`${API_BASE}${path}`, init);
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
        return { ...updated };
      }
    } catch (err) {
      console.warn('Server rename failed, applying locally', err);
    }
    Local.renameSet(id, newName);
    setsCache = Local.loadSets();
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
      return deepClone(deck);
    } catch (err) {
      console.warn('Falling back to local deck', err);
      return deepClone(Local.loadDeck(id));
    }
  }

  async function saveDeck(id, deck) {
    const prepared = normaliseDeck(deck);
    Local.saveDeck(id, prepared);
    try {
      await request(`/sets/${encodeURIComponent(id)}/deck`, { method: 'PUT', body: { deck: prepared } });
    } catch (err) {
      console.warn('Server deck save failed, kept local cache', err);
    }
    return true;
  }

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
