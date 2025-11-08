(async () => {
  const params = new URLSearchParams(location.search);
  let setId = params.get('set');

  async function ensureSetId() {
    if (!window.SetsAPI) {
      return setId || 'default';
    }
    let sets = [];
    try {
      sets = await SetsAPI.loadSets();
    } catch (err) {
      console.error('Unable to load sets', err);
    }
    if (!sets.length) {
      const created = await SetsAPI.createSet('Default');
      sets = [created];
    }
    if (!setId) {
      setId = sets[sets.length - 1].id;
      params.set('set', setId);
      history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
      return setId;
    }
    if (!sets.some((s) => s.id === setId)) {
      setId = sets[sets.length - 1].id;
      params.set('set', setId);
      history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
    }
    return setId;
  }

  setId = await ensureSetId();

  function resolveStorageKeys(id) {
    const keys = [];
    if (window.SetsAPI && typeof SetsAPI.storageKeyFor === 'function') {
      try {
        const key = SetsAPI.storageKeyFor(id);
        if (key) keys.push(key);
      } catch (err) {
        console.warn('Unable to resolve storage key from SetsAPI', err);
      }
    }
    keys.push(`study_deck_v2__${id}`);
    keys.push(`study_deck_sync_v1__${id}`);
    return Array.from(new Set(keys.filter(Boolean)));
  }

  const STORAGE_KEYS = resolveStorageKeys(setId);

  function writeLocalDeck(deck) {
    const payload = JSON.stringify(deck);
    for (const key of STORAGE_KEYS) {
      try {
        localStorage.setItem(key, payload);
      } catch (err) {
        console.warn('Unable to persist deck locally', err);
      }
    }
  }

  function readLocalDeck() {
    for (const key of STORAGE_KEYS) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          return parsed;
        }
      } catch (err) {
        console.warn('Unable to parse deck from storage', key, err);
      }
    }
    return null;
  }

  const setNameEl = document.getElementById('setName');
  if (setNameEl) {
    if (window.SetsAPI) {
      try {
        setNameEl.textContent = await SetsAPI.getSetName(setId);
      } catch (err) {
        console.error('Unable to resolve set name', err);
        setNameEl.textContent = setId;
      }
    } else {
      setNameEl.textContent = setId;
    }
  }

  const cardsLink = document.getElementById('cardsLink');
  if (cardsLink) {
    cardsLink.href = `cards.html?set=${encodeURIComponent(setId)}`;
  }
  const rehearseLink = document.getElementById('rehearseLink');
  if (rehearseLink) {
    rehearseLink.href = `rehearse.html?set=${encodeURIComponent(setId)}`;
  }

  const cardIndexEl = document.getElementById('cardIndex');
  const prevBtn = document.getElementById('btnPrevCard');
  const nextBtn = document.getElementById('btnNextCard');
  const newBtn = document.getElementById('btnNewCard');
  const duplicateBtn = document.getElementById('btnDuplicateCard');
  const deleteBtn = document.getElementById('btnDeleteCard');
  const penBtn = document.getElementById('penBtn');
  const eraserBtn = document.getElementById('eraserBtn');
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');

  const cardCells = {
    front: document.querySelector('.card-cell.front'),
    back: document.querySelector('.card-cell.back')
  };

  const state = {
    deck: [],
    index: 0,
    activeSide: 'front',
    tool: 'pen',
    undoStack: [],
    redoStack: []
  };

  function createEmptySide() {
    return { strokes: [], images: [] };
  }

  function createCard() {
    return { front: createEmptySide(), back: createEmptySide(), createdAt: Date.now() };
  }

  async function loadDeck() {
    if (window.SetsAPI) {
      try {
        const deck = await SetsAPI.loadDeck(setId);
        if (Array.isArray(deck) && deck.length) {
          state.deck = deck;
          writeLocalDeck(deck);
          return;
        }
        state.deck = [createCard()];
        writeLocalDeck(state.deck);
        await SetsAPI.saveDeck(setId, state.deck);
        return;
      } catch (err) {
        console.error('Unable to load deck from server', err);
      }
    }
    const localDeck = readLocalDeck();
    if (localDeck) {
      state.deck = localDeck;
      return;
    }
    state.deck = [createCard()];
    writeLocalDeck(state.deck);
  }

  function snapshotDeck() {
    return JSON.parse(JSON.stringify(state.deck));
  }

  let saveTimer = null;
  let pendingSnapshot = null;

  async function flushSave(snapshot) {
    if (!window.SetsAPI || !snapshot) return;
    try {
      await SetsAPI.saveDeck(setId, snapshot);
    } catch (err) {
      console.error('Deck sync failed', err);
    }
  }

  function saveDeck({ immediate = false } = {}) {
    const snapshot = snapshotDeck();
    writeLocalDeck(snapshot);
    pendingSnapshot = snapshot;
    if (!window.SetsAPI) return;
    if (immediate) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      const snap = pendingSnapshot;
      pendingSnapshot = null;
      flushSave(snap);
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const snap = pendingSnapshot;
      pendingSnapshot = null;
      flushSave(snap);
    }, 350);
  }

  function clampIndex() {
    if (state.index >= state.deck.length) {
      state.index = state.deck.length - 1;
    }
    if (state.index < 0) {
      state.index = 0;
    }
  }

  function updateCardIndex() {
    clampIndex();
    if (cardIndexEl) {
      cardIndexEl.textContent = `${state.index + 1} / ${state.deck.length}`;
    }
  }

  function setActiveSide(side) {
    state.activeSide = side;
    Object.entries(cardCells).forEach(([name, el]) => {
      if (!el) return;
      el.classList.toggle('active', name === side);
    });
  }

  function pushUndoSnapshot() {
    const snapshot = JSON.stringify({ deck: state.deck, index: state.index });
    state.undoStack.push(snapshot);
    if (state.undoStack.length > 40) {
      state.undoStack.shift();
    }
    state.redoStack.length = 0;
  }

  function applySnapshot(snapshot) {
    try {
      const payload = JSON.parse(snapshot);
      if (payload && Array.isArray(payload.deck)) {
        state.deck = payload.deck;
        state.index = Math.min(Math.max(0, payload.index || 0), state.deck.length - 1);
        if (!state.deck.length) {
          state.deck = [createCard()];
          state.index = 0;
        }
        attachImages(state.deck);
        refresh();
        saveDeck({ immediate: true });
      }
    } catch (err) {
      console.error('Unable to restore snapshot', err);
    }
  }

  function undo() {
    if (!state.undoStack.length) return;
    const current = JSON.stringify({ deck: state.deck, index: state.index });
    state.redoStack.push(current);
    const snap = state.undoStack.pop();
    applySnapshot(snap);
  }

  function redo() {
    if (!state.redoStack.length) return;
    const current = JSON.stringify({ deck: state.deck, index: state.index });
    state.undoStack.push(current);
    const snap = state.redoStack.pop();
    applySnapshot(snap);
  }

  function duplicateCard() {
    if (!state.deck.length) return;
    pushUndoSnapshot();
    const copy = JSON.parse(JSON.stringify(state.deck[state.index]));
    copy.createdAt = Date.now();
    state.deck.splice(state.index + 1, 0, copy);
    state.index += 1;
    saveDeck({ immediate: true });
    refresh();
  }

  function deleteCard() {
    if (!state.deck.length) return;
    pushUndoSnapshot();
    state.deck.splice(state.index, 1);
    if (!state.deck.length) {
      state.deck.push(createCard());
      state.index = 0;
    } else if (state.index >= state.deck.length) {
      state.index = state.deck.length - 1;
    }
    saveDeck({ immediate: true });
    refresh();
  }

  function newCard() {
    pushUndoSnapshot();
    state.deck.splice(state.index + 1, 0, createCard());
    state.index += 1;
    saveDeck({ immediate: true });
    refresh();
  }

  function prevCard() {
    if (state.index > 0) {
      state.index -= 1;
      refresh();
    }
  }

  function nextCard() {
    if (state.index < state.deck.length - 1) {
      state.index += 1;
      refresh();
    }
  }

  function attachImages(deck) {
    for (const card of deck) {
      for (const side of ['front', 'back']) {
        const sideData = card[side];
        if (!sideData || !Array.isArray(sideData.images)) continue;
        for (const img of sideData.images) {
          if (!img || !img.src) continue;
          const image = new Image();
          image.onload = () => {
            img.__image = image;
            const currentCard = state.deck[state.index];
            if (currentCard && currentCard[side] === sideData) {
              pads[side].setContent(sideData);
            }
          };
          image.src = img.src;
        }
      }
    }
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  class LowPassFilter {
    constructor(alpha) {
      this.alpha = alpha;
      this.initialized = false;
      this.last = 0;
    }

    setAlpha(alpha) {
      this.alpha = alpha;
    }

    filter(value) {
      if (!this.initialized) {
        this.initialized = true;
        this.last = value;
        return value;
      }
      const result = this.alpha * value + (1 - this.alpha) * this.last;
      this.last = result;
      return result;
    }

    reset() {
      this.initialized = false;
      this.last = 0;
    }
  }

  class OneEuroFilter {
    constructor({ minCutoff = 1.2, beta = 0.007, dCutoff = 1.0 } = {}) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.lastTime = null;
      this.dxFilter = new LowPassFilter(1);
      this.valueFilter = new LowPassFilter(1);
    }

    alpha(cutoff, dt) {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    }

    filter(value, timestamp) {
      if (this.lastTime == null) {
        this.lastTime = timestamp;
        this.dxFilter.reset();
        this.valueFilter.reset();
        return value;
      }
      const dt = Math.max((timestamp - this.lastTime) / 1000, 1e-4);
      this.lastTime = timestamp;
      const dx = this.valueFilter.initialized ? (value - this.valueFilter.last) / dt : 0;
      const aD = this.alpha(this.dCutoff, dt);
      this.dxFilter.setAlpha(aD);
      const dxHat = this.dxFilter.filter(dx);
      const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
      const a = this.alpha(cutoff, dt);
      this.valueFilter.setAlpha(a);
      return this.valueFilter.filter(value);
    }

    reset() {
      this.lastTime = null;
      this.dxFilter.reset();
      this.valueFilter.reset();
    }
  }

  function createFilterSet() {
    return {
      x: new OneEuroFilter({ minCutoff: 1.2, beta: 0.007, dCutoff: 1.0 }),
      y: new OneEuroFilter({ minCutoff: 1.2, beta: 0.007, dCutoff: 1.0 })
    };
  }

  function resolveGridStroke() {
    const rootStyles = getComputedStyle(document.documentElement);
    const muted = rootStyles.getPropertyValue('--muted') || '#9fa9c6';
    const probe = document.createElement('span');
    probe.style.color = muted;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color.match(/\d+/g);
    probe.remove();
    if (rgb && rgb.length >= 3) {
      return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.2)`;
    }
    return 'rgba(159, 169, 198, 0.2)';
  }

  class CanvasPad {
    constructor(side, { container, grid, ink, callbacks, gridStroke }) {
      this.side = side;
      this.container = container;
      this.gridCanvas = grid;
      this.inkCanvas = ink;
      this.callbacks = callbacks;
      this.gridStroke = gridStroke;
      this.gridCtx = this.gridCanvas.getContext('2d');
      this.inkCtx = this.inkCanvas.getContext('2d', { desynchronized: true });
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      this.rect = this.container.getBoundingClientRect();
      this.content = createEmptySide();
      this.activeStroke = null;
      this.currentStrokeData = null;

      this.onPointerDown = this.onPointerDown.bind(this);
      this.onPointerMove = this.onPointerMove.bind(this);
      this.onPointerUp = this.onPointerUp.bind(this);
      this.onBlur = this.onBlur.bind(this);

      this.container.addEventListener('pointerdown', this.onPointerDown, { passive: false });
      this.container.addEventListener('pointermove', this.onPointerMove, { passive: false });
      this.container.addEventListener('pointerup', this.onPointerUp, { passive: false });
      this.container.addEventListener('pointercancel', this.onPointerUp, { passive: false });
      window.addEventListener('blur', this.onBlur);

      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
      window.addEventListener('orientationchange', () => this.resize());
      window.addEventListener('resize', () => this.resize());

      this.resize();
    }

    resize() {
      this.rect = this.container.getBoundingClientRect();
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(this.rect.width * this.dpr));
      const height = Math.max(1, Math.round(this.rect.height * this.dpr));
      [this.gridCanvas, this.inkCanvas].forEach((canvas) => {
        canvas.style.width = `${this.rect.width}px`;
        canvas.style.height = `${this.rect.height}px`;
        canvas.width = width;
        canvas.height = height;
      });
      this.gridCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.inkCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawGrid();
      this.renderFromContent();
    }

    drawGrid() {
      const ctx = this.gridCtx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
      ctx.restore();
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const spacing = 24;
      const w = this.gridCanvas.width / this.dpr;
      const h = this.gridCanvas.height / this.dpr;
      ctx.strokeStyle = this.gridStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = spacing; x < w; x += spacing) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = spacing; y < h; y += spacing) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
      ctx.restore();
    }

    setContent(content) {
      this.content = content || createEmptySide();
      if (this.content && (!this.content.dimensions || !Number.isFinite(this.content.dimensions.width) || !Number.isFinite(this.content.dimensions.height))) {
        const size = {
          width: this.rect?.width || this.gridCanvas.width / Math.max(1, this.dpr),
          height: this.rect?.height || this.gridCanvas.height / Math.max(1, this.dpr)
        };
        this.content.dimensions = size;
        this.callbacks.onDimensions?.(this.side, size);
      }
      this.renderFromContent();
    }

    renderFromContent() {
      const ctx = this.inkCtx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.inkCanvas.width, this.inkCanvas.height);
      ctx.restore();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (!this.content) return;

      const dims = this.content.dimensions || {};
      const baseWidth = Number.isFinite(dims.width) && dims.width > 0 ? dims.width : this.rect.width || 1;
      const baseHeight = Number.isFinite(dims.height) && dims.height > 0 ? dims.height : this.rect.height || 1;
      const scaleX = baseWidth ? (this.rect.width || baseWidth) / baseWidth : 1;
      const scaleY = baseHeight ? (this.rect.height || baseHeight) / baseHeight : 1;

      ctx.save();
      ctx.scale(scaleX, scaleY);

      if (Array.isArray(this.content.images)) {
        for (const img of this.content.images) {
          if (!img || !img.__image) continue;
          const angle = (typeof img.angle === 'number') ? img.angle : 0;
          const scale = (img.scale || 100) / 100;
          const w = (img.w || img.__image.width) * scale;
          const h = (img.h || img.__image.height) * scale;
          const cx = (img.x || 0) + w / 2;
          const cy = (img.y || 0) + h / 2;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate((angle * Math.PI) / 180);
          ctx.drawImage(img.__image, -w / 2, -h / 2, w, h);
          ctx.restore();
        }
      }

      if (Array.isArray(this.content.strokes)) {
        for (const stroke of this.content.strokes) {
          this.drawStoredStroke(stroke);
        }
      }

      ctx.restore();
    }

    drawStoredStroke(stroke) {
      if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) return;
      const ctx = this.inkCtx;
      ctx.save();
      ctx.globalCompositeOperation = stroke.mode || 'source-over';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const strokeColor = stroke.color || (stroke.mode === 'destination-out' ? 'rgba(0,0,0,1)' : '#111827');
      ctx.strokeStyle = strokeColor;
      const widthValue = typeof stroke.size === 'number' ? stroke.size : Number(stroke.size);
      ctx.lineWidth = Number.isFinite(widthValue) && widthValue > 0 ? widthValue : 2.4;
      if (stroke.points.length === 1) {
        const rawPoint = stroke.points[0];
        const p = {
          x: typeof rawPoint.x === 'number' ? rawPoint.x : Number(rawPoint.x) || 0,
          y: typeof rawPoint.y === 'number' ? rawPoint.y : Number(rawPoint.y) || 0
        };
        ctx.beginPath();
        ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
        ctx.restore();
        return;
      }
      const pts = stroke.points.map((pt) => ({
        x: typeof pt.x === 'number' ? pt.x : Number(pt.x) || 0,
        y: typeof pt.y === 'number' ? pt.y : Number(pt.y) || 0
      }));
      let prev = pts[0];
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      for (let i = 1; i < pts.length; i++) {
        const current = pts[i];
        const mid = midpoint(prev, current);
        ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
        prev = current;
      }
      const last = pts[pts.length - 1];
      const penultimate = pts[pts.length - 2];
      ctx.quadraticCurveTo(penultimate.x, penultimate.y, last.x, last.y);
      ctx.stroke();
      ctx.restore();
    }

    sampleEvent(evt) {
      const x = (evt.clientX - this.rect.left);
      const y = (evt.clientY - this.rect.top);
      let filteredX = x;
      let filteredY = y;
      if (this.activeStroke && this.activeStroke.filters) {
        filteredX = this.activeStroke.filters.x.filter(x, evt.timeStamp);
        filteredY = this.activeStroke.filters.y.filter(y, evt.timeStamp);
      }
      return { x: filteredX, y: filteredY, time: evt.timeStamp };
    }

    startStroke(evt) {
      const tool = this.callbacks.getTool();
      const mode = tool === 'eraser' ? 'destination-out' : 'source-over';
      const width = tool === 'eraser' ? this.callbacks.getEraserSize() : this.callbacks.getPenSize();
      const color = mode === 'destination-out' ? 'rgba(0,0,0,1)' : '#111827';
      this.activeStroke = {
        pointerId: evt.pointerId,
        mode,
        width,
        color,
        filters: this.callbacks.useSmoothing() ? createFilterSet() : null,
        points: [],
        lastMid: null
      };
      this.currentStrokeData = {
        mode,
        size: width,
        color,
        points: []
      };
      this.callbacks.onStrokeStart(this.side);
      this.callbacks.onActivate(this.side);
    }

    processSamples(events) {
      for (const evt of events) {
        const sample = this.sampleEvent(evt);
        const points = this.activeStroke.points;
        if (points.length) {
          const prev = points[points.length - 1];
          const dist = Math.hypot(sample.x - prev.x, sample.y - prev.y);
          if (dist < 0.35) {
            continue;
          }
        }
        points.push(sample);
        this.currentStrokeData.points.push({ x: sample.x, y: sample.y });
        this.drawSegment();
      }
    }

    drawSegment() {
      const stroke = this.activeStroke;
      const points = stroke.points;
      const ctx = this.inkCtx;
      ctx.save();
      ctx.globalCompositeOperation = stroke.mode;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.fillStyle = stroke.color;
      if (points.length === 1) {
        const p = points[0];
        ctx.beginPath();
        ctx.arc(p.x, p.y, stroke.width / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }
      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      const mid = midpoint(prev, last);
      ctx.beginPath();
      if (!stroke.lastMid) {
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(mid.x, mid.y);
      } else {
        ctx.moveTo(stroke.lastMid.x, stroke.lastMid.y);
        ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
      }
      ctx.stroke();
      stroke.lastMid = mid;
      ctx.restore();
    }

    finishStroke(evt) {
      if (!this.activeStroke) return;
      const stroke = this.activeStroke;
      if (stroke.points.length >= 2) {
        const last = stroke.points[stroke.points.length - 1];
        const prev = stroke.points[stroke.points.length - 2];
        const ctx = this.inkCtx;
        ctx.save();
        ctx.globalCompositeOperation = stroke.mode;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.beginPath();
        if (stroke.lastMid) {
          ctx.moveTo(stroke.lastMid.x, stroke.lastMid.y);
        } else {
          ctx.moveTo(prev.x, prev.y);
        }
        ctx.quadraticCurveTo(prev.x, prev.y, last.x, last.y);
        ctx.stroke();
        ctx.restore();
      }
      if (evt) {
        this.container.releasePointerCapture?.(evt.pointerId);
      }
      if (this.content) {
        this.content.dimensions = {
          width: this.rect?.width || this.gridCanvas.width / Math.max(1, this.dpr),
          height: this.rect?.height || this.gridCanvas.height / Math.max(1, this.dpr)
        };
      }
      if (this.currentStrokeData && this.currentStrokeData.points.length) {
        const size = this.content?.dimensions || {
          width: this.rect?.width || this.gridCanvas.width / Math.max(1, this.dpr),
          height: this.rect?.height || this.gridCanvas.height / Math.max(1, this.dpr)
        };
        this.callbacks.onStrokeComplete(this.side, this.currentStrokeData, size);
      }
      this.activeStroke = null;
      this.currentStrokeData = null;
    }

    onPointerDown(evt) {
      if (evt.pointerType === 'mouse' && evt.button !== 0) return;
      if (evt.pointerType !== 'mouse' && evt.pointerType !== 'pen' && evt.pointerType !== 'touch') return;
      evt.preventDefault();
      this.rect = this.container.getBoundingClientRect();
      this.container.setPointerCapture?.(evt.pointerId);
      this.startStroke(evt);
      const coalesced = (evt.getCoalescedEvents && evt.getCoalescedEvents().length) ? evt.getCoalescedEvents() : [evt];
      this.processSamples(coalesced);
    }

    onPointerMove(evt) {
      if (!this.activeStroke || evt.pointerId !== this.activeStroke.pointerId) return;
      evt.preventDefault();
      const events = (evt.getCoalescedEvents && evt.getCoalescedEvents().length) ? evt.getCoalescedEvents() : [evt];
      this.processSamples(events);
    }

    onPointerUp(evt) {
      if (!this.activeStroke || (evt && evt.pointerId !== this.activeStroke.pointerId)) return;
      evt && evt.preventDefault();
      this.finishStroke(evt);
    }

    onBlur() {
      if (this.activeStroke) {
        this.finishStroke();
      }
    }
  }

  const gridStroke = resolveGridStroke();

  const pads = {
    front: new CanvasPad('front', {
      container: document.getElementById('pad-front'),
      grid: document.getElementById('grid-front'),
      ink: document.getElementById('ink-front'),
      gridStroke,
      callbacks: {
        getTool: () => state.tool,
        getPenSize: () => 2.6,
        getEraserSize: () => 18,
        useSmoothing: () => true,
        onStrokeStart: () => pushUndoSnapshot(),
        onStrokeComplete: (side, stroke, size) => {
          const card = state.deck[state.index];
          card[side].strokes.push(stroke);
          if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
            card[side].dimensions = { width: size.width, height: size.height };
          }
          saveDeck();
          refresh();
        },
        onDimensions: (side, size) => {
          if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
          const card = state.deck[state.index];
          if (!card || !card[side]) return;
          const dims = card[side].dimensions || {};
          if (dims.width === size.width && dims.height === size.height) return;
          card[side].dimensions = { width: size.width, height: size.height };
          saveDeck();
        },
        onActivate: (side) => setActiveSide(side)
      }
    }),
    back: new CanvasPad('back', {
      container: document.getElementById('pad-back'),
      grid: document.getElementById('grid-back'),
      ink: document.getElementById('ink-back'),
      gridStroke,
      callbacks: {
        getTool: () => state.tool,
        getPenSize: () => 2.6,
        getEraserSize: () => 18,
        useSmoothing: () => true,
        onStrokeStart: () => pushUndoSnapshot(),
        onStrokeComplete: (side, stroke, size) => {
          const card = state.deck[state.index];
          card[side].strokes.push(stroke);
          if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
            card[side].dimensions = { width: size.width, height: size.height };
          }
          saveDeck();
          refresh();
        },
        onDimensions: (side, size) => {
          if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
          const card = state.deck[state.index];
          if (!card || !card[side]) return;
          const dims = card[side].dimensions || {};
          if (dims.width === size.width && dims.height === size.height) return;
          card[side].dimensions = { width: size.width, height: size.height };
          saveDeck();
        },
        onActivate: (side) => setActiveSide(side)
      }
    })
  };

  function refresh() {
    clampIndex();
    updateCardIndex();
    const card = state.deck[state.index];
    setActiveSide(state.activeSide);
    pads.front.setContent(card.front);
    pads.back.setContent(card.back);
  }

  function setTool(tool) {
    state.tool = tool;
    if (penBtn) {
      penBtn.classList.toggle('active', tool === 'pen');
      penBtn.setAttribute('aria-pressed', tool === 'pen' ? 'true' : 'false');
    }
    if (eraserBtn) {
      eraserBtn.classList.toggle('active', tool === 'eraser');
      eraserBtn.setAttribute('aria-pressed', tool === 'eraser' ? 'true' : 'false');
    }
  }

  if (penBtn) penBtn.addEventListener('click', () => setTool('pen'));
  if (eraserBtn) eraserBtn.addEventListener('click', () => setTool('eraser'));
  if (undoBtn) undoBtn.addEventListener('click', () => undo());
  if (redoBtn) redoBtn.addEventListener('click', () => redo());
  if (newBtn) newBtn.addEventListener('click', () => newCard());
  if (duplicateBtn) duplicateBtn.addEventListener('click', () => duplicateCard());
  if (deleteBtn) deleteBtn.addEventListener('click', () => deleteCard());
  if (prevBtn) prevBtn.addEventListener('click', () => prevCard());
  if (nextBtn) nextBtn.addEventListener('click', () => nextCard());

  document.querySelectorAll('.card-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const side = cell.dataset.side;
      if (side) setActiveSide(side);
    });
  });

  window.addEventListener('keydown', (evt) => {
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'z') {
      evt.preventDefault();
      if (evt.shiftKey) redo(); else undo();
    }
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'y') {
      evt.preventDefault();
      redo();
    }
    if (evt.key === 'p' || evt.key === 'P') setTool('pen');
    if (evt.key === 'e' || evt.key === 'E') setTool('eraser');
    if (evt.key === 'ArrowLeft') { evt.preventDefault(); prevCard(); }
    if (evt.key === 'ArrowRight') { evt.preventDefault(); nextCard(); }
  });

  await loadDeck();
  attachImages(state.deck);
  setActiveSide('front');
  refresh();

  window.addEventListener('beforeunload', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const snap = pendingSnapshot || snapshotDeck();
    pendingSnapshot = null;
    flushSave(snap);
  });
})();
