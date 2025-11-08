/* Study Cards — No OCR, Draw + Images */
(() => {
  const params = new URLSearchParams(location.search);
  const setId = params.get('set') || (function(){
    const sets = window.SetsAPI ? SetsAPI.loadSets() : [{id:'default',name:'Default'}];
    return sets[0].id;
  })();
  const STORAGE_KEY = 'study_deck_v2__' + setId;
  const setNameEl = document.getElementById('set-name');
  if (setNameEl && window.SetsAPI) setNameEl.textContent = SetsAPI.getSetName(setId);

  const grid = document.getElementById('grid');
  const draw = document.getElementById('draw');
  const gctx = grid.getContext('2d');
  const ctx = draw.getContext('2d');

  const toolPen = document.getElementById('tool-pen');
  const toolEraser = document.getElementById('tool-eraser');
  const toolSelect = document.getElementById('tool-select');
  const penSize = document.getElementById('pen-size');
  const eraserSize = document.getElementById('eraser-size');
  const btnAddImage = document.getElementById('btn-add-image');
  const imageFile = document.getElementById('image-file');
  const imageScale = document.getElementById('image-scale');
  const imageRotate = document.getElementById('image-rotate');
  const btnRotLeft = document.getElementById('btn-rot-left');
  const btnRotRight = document.getElementById('btn-rot-right');

  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnClear = document.getElementById('btn-clear');
  const btnSavePNG = document.getElementById('btn-save-png');
  const btnExportDeck = document.getElementById('btn-export-deck');
  const btnImportDeck = document.getElementById('btn-import-deck');
  const deckFile = document.getElementById('deck-file');

  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const deckInfo = document.getElementById('deck-info');

  const btnFront = document.getElementById('btn-front');
  const btnBack = document.getElementById('btn-back');

  const btnNewCard = document.getElementById('btn-new-card');
  const btnDuplicateCard = document.getElementById('btn-duplicate-card');
  const btnDeleteCard = document.getElementById('btn-delete-card');

  let state = {
    tool: 'pen', // 'pen' | 'eraser' | 'select'
    side: 'front', // 'front' | 'back'
    deck: [],
    index: 0,
    undoStack: [],
    redoStack: [],
    pointer: { down:false, x:0, y:0 },
    currentStroke: null,
    selectedImageId: null
  };

  const GRID_SIZE = 24;

  function scaledDims(im) {
    const w = im.w * (im.scale/100);
    const h = im.h * (im.scale/100);
    return { w, h };
  }
  function centerOf(im) {
    const { w, h } = scaledDims(im);
    return { cx: im.x + w/2, cy: im.y + h/2 };
  }
  function degToRad(d) { return d * Math.PI / 180; }

  const BG_COLOR = '#0b0f15';
  const GRID_COLOR = 'rgba(122,162,247,0.12)';
  const GUIDE_COLOR = 'rgba(160,170,190,0.35)';

  function drawGrid() {
    const w = grid.width, h = grid.height;
    gctx.clearRect(0,0,w,h);
    // background
    gctx.fillStyle = BG_COLOR;
    gctx.fillRect(0,0,w,h);
    // minor grid
    gctx.strokeStyle = GRID_COLOR;
    gctx.lineWidth = 1;
    gctx.beginPath();
    for (let x = 0; x <= w; x += GRID_SIZE) {
      gctx.moveTo(x+0.5, 0); gctx.lineTo(x+0.5, h);
    }
    for (let y = 0; y <= h; y += GRID_SIZE) {
      gctx.moveTo(0, y+0.5); gctx.lineTo(w, y+0.5);
    }
    gctx.stroke();
    // outer guide
    gctx.strokeStyle = GUIDE_COLOR;
    gctx.lineWidth = 2;
    gctx.strokeRect(8.5,8.5,w-17,h-17);
  }

  function createEmptySide() {
    return { strokes: [], images: [] }; // images: { id, x,y,w,h, scale, src }
  }

  function createCard() {
    return { front: createEmptySide(), back: createEmptySide(), createdAt: Date.now() };
  }

  function ensureDeckInit() {
    // Load deck for current set id
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try { state.deck = JSON.parse(raw) || [createCard()]; }
      catch(e) { state.deck = [createCard()]; }
    } else { state.deck = [createCard()]; }
  }

  // ORIGINAL ensureDeckInit BELOW (unused)
  function __unused_ensureDeckInit_v1() {
    const saved = localStorage.getItem('study_deck_v2');
    if (saved) {
      try {
        state.deck = JSON.parse(saved);
      } catch(e) {
        state.deck = [createCard()];
      }
    } else {
      state.deck = [createCard()];
    }
  }

  function saveDeckLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.deck));
  }

  // ORIGINAL saveDeckLocal BELOW (unused)
  function __unused_saveDeckLocal_v1() {
    localStorage.setItem('study_deck_v2', JSON.stringify(state.deck));
  }

  function pushUndo() {
    const snapshot = JSON.stringify(state.deck[state.index]);
    state.undoStack.push(snapshot);
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack.length = 0;
  }

  function applySnapshot(json) {
    state.deck[state.index] = JSON.parse(json);
    render();
    saveDeckLocal();
  }

  function currentSideData() {
    const card = state.deck[state.index];
    return card[state.side];
  }

  function setTool(which) {
    state.tool = which;
    [toolPen, toolEraser, toolSelect].forEach(b => b.classList.remove('active'));
    if (which === 'pen') toolPen.classList.add('active');
    if (which === 'eraser') toolEraser.classList.add('active');
    if (which === 'select') toolSelect.classList.add('active');
    draw.style.cursor = which === 'select' ? 'move' : 'crosshair';
    if (which !== 'select') state.selectedImageId = null;
    render();
  }

  function setSide(side) {
    state.side = side;
    [btnFront, btnBack].forEach(b => b.classList.remove('active'));
    (side === 'front' ? btnFront : btnBack).classList.add('active');
    state.selectedImageId = null;
    render();
  }

  function setIndex(i) {
    state.index = i;
    state.selectedImageId = null;
    updateDeckInfo();
    render();
  }

  function updateDeckInfo() {
    deckInfo.textContent = `Card ${state.index+1} / ${state.deck.length}`;
  }

  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function render() {
    // clear draw layer
    ctx.clearRect(0,0,draw.width, draw.height);

    const side = currentSideData();

    // images first (with rotation)
    for (const img of side.images) {
      if (!img.__image) continue; // not yet loaded
      const a = (typeof img.angle === 'number') ? img.angle : 0;
      const { w, h } = scaledDims(img);
      const { cx, cy } = centerOf(img);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(degToRad(a));
      ctx.drawImage(img.__image, -w/2, -h/2, w, h);
      if (state.selectedImageId === img.id) {
        ctx.setLineDash([6,6]);
        ctx.strokeStyle = '#7aa2f7';
        ctx.lineWidth = 2;
        ctx.strokeRect(-w/2, -h/2, w, h);
      }
      ctx.restore();
    }

    // strokes on top
    for (const s of side.strokes) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalCompositeOperation = s.mode || 'source-over';
      ctx.strokeStyle = s.color || '#e7e9ee';
      ctx.lineWidth = s.size || 2;
      ctx.beginPath();
      for (let i=0;i<s.points.length;i++) {
        const p = s.points[i];
        if (i===0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  function loadImageToImageObj(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve({ src: e.target.result, w: img.width, h: img.height, __image: img });
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function hitTestImage(x,y) {
    const side = currentSideData();
    for (let i=side.images.length-1; i>=0; i--) {
      const im = side.images[i];
      const a = (typeof im.angle === 'number') ? im.angle : 0;
      const { w, h } = scaledDims(im);
      const { cx, cy } = centerOf(im);
      // Transform point to image local space: translate to center, rotate by -a
      const dx = x - cx, dy = y - cy;
      const ca = Math.cos(degToRad(-a)), sa = Math.sin(degToRad(-a));
      const lx = dx * ca - dy * sa;
      const ly = dx * sa + dy * ca;
      if (lx >= -w/2 && lx <= w/2 && ly >= -h/2 && ly <= h/2) {
        return im.id;
      }
    }
    return null;
  }

  function pointerPos(evt) {
    const rect = draw.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * (draw.width / rect.width);
    const y = (evt.clientY - rect.top) * (draw.height / rect.height);
    return { x, y };
  }

  function onPointerDown(evt) {
    const {x,y} = pointerPos(evt);
    state.pointer = { down:true, x, y };
    const side = currentSideData();

    if (state.tool === 'pen' || state.tool === 'eraser') {
      pushUndo();
      const size = state.tool === 'pen' ? Number(penSize.value) : Number(eraserSize.value);
      const mode = state.tool === 'pen' ? 'source-over' : 'destination-out';
      state.currentStroke = { points:[{x,y}], size, mode, color:'#e7e9ee' };
      side.strokes.push(state.currentStroke);
      render();
      saveDeckLocal();
      return;
    }

    if (state.tool === 'select') {
      const id = hitTestImage(x,y);
      state.selectedImageId = id;
      state.dragOffset = null;
      if (id) {
        const im = side.images.find(m => m.id === id);
        const { w, h } = scaledDims(im);
        // drag offset from pointer to image top-left (so moving ignores rotation, which is OK for UX)
        state.dragOffset = { dx: x - im.x, dy: y - im.y, w, h };
        // sync controls
        imageScale.value = String(im.scale ?? 100);
        imageRotate.value = String(im.angle ?? 0);
      }
      render();
      return;
    }
  }

  function onPointerMove(evt) {
    const {x,y} = pointerPos(evt);
    if (!state.pointer.down) return;

    if (state.tool === 'pen' || state.tool === 'eraser') {
      if (state.currentStroke) {
        state.currentStroke.points.push({x,y});
        render();
      }
      return;
    }

    if (state.tool === 'select' && state.selectedImageId && state.dragOffset) {
      const side = currentSideData();
      const im = side.images.find(m => m.id === state.selectedImageId);
      im.x = x - state.dragOffset.dx;
      im.y = y - state.dragOffset.dy;
      render();
      saveDeckLocal();
      return;
    }
  }

  function onPointerUp() {
    state.pointer.down = false;
    state.currentStroke = null;
  }

  function addImageFromFile(file) {
    if (!file) return;
    loadImageToImageObj(file).then(info => {
      pushUndo();
      const side = currentSideData();
      const id = 'img_' + Math.random().toString(36).slice(2,8);
      const imgObj = { id, x: 40, y: 40, w: info.w, h: info.h, scale: 50, angle: 0, src: info.src, __image: info.__image };
      side.images.push(imgObj);
      state.selectedImageId = id;
      render();
      saveDeckLocal();
    }).catch(err => alert('Could not load image: ' + err));
  }

  function attachImageBitmaps() {
    // Ensure data URLs are turned into Image objects after import or load
    for (const card of state.deck) {
      for (const sideName of ['front','back']) {
        for (const im of card[sideName].images) {
          const img = new Image();
          img.onload = () => { im.__image = img; render(); };
          img.src = im.src;
        }
      }
    }
  }

  function clearSide() {
    pushUndo();
    const side = currentSideData();
    side.strokes = [];
    side.images = [];
    state.selectedImageId = null;
    render();
    saveDeckLocal();
  }

  function savePNG() {
    // composite both layers
    const tmp = document.createElement('canvas');
    tmp.width = draw.width; tmp.height = draw.height;
    const c = tmp.getContext('2d');
    // Re-draw background grid lightly for PNG? Many prefer without grid.
    // We'll export WITH the grid so it's true to what you see.
    c.drawImage(grid, 0, 0);
    c.drawImage(draw, 0, 0);
    const url = tmp.toDataURL('image/png');
    const a = document.createElement('a');
    const idx = String(state.index+1).padStart(3,'0');
    a.href = url;
    a.download = `card-${idx}-${state.side}.png`;
    a.click();
  }

  function exportDeck() {
    const data = JSON.stringify(state.deck);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    a.href = url;
    a.download = `deck-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importDeckFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const deck = JSON.parse(e.target.result);
        if (!Array.isArray(deck)) throw new Error('Invalid deck format');
        state.deck = deck;
        state.index = 0;
        state.undoStack = [];
        state.redoStack = [];
        attachImageBitmaps();
        updateDeckInfo();
        render();
        saveDeckLocal();
      } catch (err) {
        alert('Import failed: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  function duplicateCard() {
    const copy = deepClone(state.deck[state.index]);
    state.deck.splice(state.index+1, 0, copy);
    setIndex(state.index+1);
    saveDeckLocal();
  }

  function deleteCard() {
    if (state.deck.length === 1) {
      clearSide();
      return;
    }
    state.deck.splice(state.index, 1);
    if (state.index >= state.deck.length) state.index = state.deck.length-1;
    updateDeckInfo();
    render();
    saveDeckLocal();
  }

  function newCard() {
    state.deck.splice(state.index+1, 0, createCard());
    setIndex(state.index+1);
    saveDeckLocal();
  }

  function handleKey(e) {
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); btnUndo.click(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); btnRedo.click(); }
    if (e.key.toLowerCase() === 'p') setTool('pen');
    if (e.key.toLowerCase() === 'e') setTool('eraser');
    if (e.key.toLowerCase() === 'v') setTool('select');
  }

  // Wire up events
  toolPen.addEventListener('click', () => setTool('pen'));
  toolEraser.addEventListener('click', () => setTool('eraser'));
  toolSelect.addEventListener('click', () => setTool('select'));

  btnAddImage.addEventListener('click', () => imageFile.click());
  imageFile.addEventListener('change', e => addImageFromFile(e.target.files[0]));
  imageScale.addEventListener('input', () => {
    if (!state.selectedImageId) return;
    const side = currentSideData();
    const im = side.images.find(m => m.id === state.selectedImageId);
    if (!im) return;
    const { cx, cy } = centerOf(im);
    im.scale = Number(imageScale.value);
    const { w, h } = scaledDims(im);
    im.x = cx - w/2;
    im.y = cy - h/2;
    render();
    saveDeckLocal();
  });
  imageRotate.addEventListener('input', () => {
    if (!state.selectedImageId) return;
    const side = currentSideData();
    const im = side.images.find(m => m.id === state.selectedImageId);
    if (!im) return;
    im.angle = Number(imageRotate.value);
    render();
    saveDeckLocal();
  });

  function nudgeRotate(delta) {
    if (!state.selectedImageId) return;
    const side = currentSideData();
    const im = side.images.find(m => m.id === state.selectedImageId);
    if (!im) return;
    const val = Math.max(-180, Math.min(180, (im.angle ?? 0) + delta));
    im.angle = val;
    imageRotate.value = String(val);
    render();
    saveDeckLocal();
  }
  btnRotLeft.addEventListener('click', () => nudgeRotate(-15));
  btnRotRight.addEventListener('click', () => nudgeRotate(15));


  btnUndo.addEventListener('click', () => {
    if (!state.undoStack.length) return;
    const snap = state.undoStack.pop();
    state.redoStack.push(JSON.stringify(state.deck[state.index]));
    applySnapshot(snap);
  });
  btnRedo.addEventListener('click', () => {
    if (!state.redoStack.length) return;
    const snap = state.redoStack.pop();
    state.undoStack.push(JSON.stringify(state.deck[state.index]));
    applySnapshot(snap);
  });
  btnClear.addEventListener('click', clearSide);
  btnSavePNG.addEventListener('click', savePNG);
  btnExportDeck.addEventListener('click', exportDeck);
  btnImportDeck.addEventListener('click', () => deckFile.click());
  deckFile.addEventListener('change', e => importDeckFile(e.target.files[0]));

  btnPrev.addEventListener('click', () => {
    if (state.index > 0) setIndex(state.index-1);
  });
  btnNext.addEventListener('click', () => {
    if (state.index < state.deck.length-1) setIndex(state.index+1);
  });

  btnFront.addEventListener('click', () => setSide('front'));
  btnBack.addEventListener('click', () => setSide('back'));

  btnNewCard.addEventListener('click', newCard);
  btnDuplicateCard.addEventListener('click', duplicateCard);
  btnDeleteCard.addEventListener('click', deleteCard);

  draw.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);
  window.addEventListener('keydown', handleKey);

  // Initialize
  ensureDeckInit();
  attachImageBitmaps();
  drawGrid();
  updateDeckInfo();
  render();

  // Redraw grid on resize to keep pixel crispness
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
  const params = new URLSearchParams(location.search);
  const setId = params.get('set') || (function(){
    const sets = window.SetsAPI ? SetsAPI.loadSets() : [{id:'default',name:'Default'}];
    return sets[0].id;
  })();
  const STORAGE_KEY = 'study_deck_v2__' + setId;
  const setNameEl = document.getElementById('set-name');
  if (setNameEl && window.SetsAPI) setNameEl.textContent = SetsAPI.getSetName(setId);

      // keep canvas internal size; only CSS scales. Grid is fine.
      drawGrid();
      render();
    }, 120);
  });
})();