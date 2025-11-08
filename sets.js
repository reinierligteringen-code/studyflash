
// Shared utilities for managing Flashcard Sets in localStorage
(() => {
  const LS_KEY = 'study_sets_v1';

  function uid() { return 'set_' + Math.random().toString(36).slice(2,10); }

  function storageKeyFor(setId) { return 'study_deck_v2__' + setId; }

  function loadSets() {
    let sets = [];
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      try { sets = JSON.parse(raw) || []; } catch(e) { sets = []; }
    }
    if (!Array.isArray(sets)) sets = [];
    if (sets.length === 0) {
      // Create a default set if none exist
      const def = { id: 'default', name: 'Default', createdAt: Date.now() };
      sets = [def];
      localStorage.setItem(LS_KEY, JSON.stringify(sets));
      // Ensure an empty deck exists for default
      if (!localStorage.getItem(storageKeyFor(def.id))) {
        const empty = [{ front:{strokes:[],images:[]}, back:{strokes:[],images:[]}, createdAt: Date.now() }];
        localStorage.setItem(storageKeyFor(def.id), JSON.stringify(empty));
      }
    }
    return sets;
  }

  function saveSets(sets) {
    localStorage.setItem(LS_KEY, JSON.stringify(sets));
  }

  function getSetById(setId) {
    return loadSets().find(s => s.id === setId) || null;
  }

  function getSetName(setId) {
    const s = getSetById(setId);
    return s ? s.name : '(unknown set)';
  }

  function createSet(name) {
    const sets = loadSets();
    const id = uid();
    const s = { id, name: name || 'New Set', createdAt: Date.now() };
    sets.push(s);
    saveSets(sets);
    // Initialize empty deck
    const empty = [{ front:{strokes:[],images:[]}, back:{strokes:[],images:[]}, createdAt: Date.now() }];
    localStorage.setItem(storageKeyFor(id), JSON.stringify(empty));
    return s;
  }

  function renameSet(id, newName) {
    const sets = loadSets();
    const idx = sets.findIndex(s => s.id === id);
    if (idx >= 0) {
      sets[idx].name = newName || sets[idx].name;
      saveSets(sets);
    }
  }

  function deleteSet(id) {
    const sets = loadSets().filter(s => s.id !== id);
    saveSets(sets);
    // Remove deck storage
    localStorage.removeItem(storageKeyFor(id));
  }

  // Expose globally
  window.SetsAPI = { loadSets, saveSets, storageKeyFor, getSetName, getSetById, createSet, renameSet, deleteSet };
})();
