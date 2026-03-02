(() => {
  'use strict';

  // PicMix Studio — Vanilla JS, fully local.

  /* ────────────────────────────────────────────────────────────────
     Utilities
     ──────────────────────────────────────────────────────────────── */
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const mulberry32 = (a) => () => {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rafSchedule = (fn) => {
    let raf = 0;
    let lastArgs = null;
    return (...args) => {
      lastArgs = args;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        fn(...(lastArgs || []));
      });
    };
  };

  const setRangeFill = (input) => {
    if (!input || input.type !== 'range') return;
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const val = Number(input.value || 0);
    const p = max === min ? 0 : clamp((val - min) / (max - min), 0, 1);
    input.style.setProperty('--p', String(p));
  };

  const initAllRangeFills = () => qsa('input[type="range"]').forEach(setRangeFill);

  const readFileAsDataURL = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('Failed to read file'));
      r.readAsDataURL(file);
    });

  const loadImageFromFile = async (file) => {
    if (!file || !file.type || !file.type.startsWith('image/')) throw new Error('Not an image');
    const url = await readFileAsDataURL(file);
    const img = new Image();
    img.src = url;
    if (img.decode) {
      try { await img.decode(); } catch { /* fallback to onload */ }
    }
    await new Promise((res, rej) => {
      if (img.complete && img.naturalWidth) return res();
      img.onload = () => res();
      img.onerror = () => rej(new Error('Failed to load image'));
    });
    return img;
  };

  const downloadCanvasJPEG = (canvas, filename, quality = 0.95) => {
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/jpeg', clamp(quality, 0.01, 1));
    link.click();
  };

  /* ────────────────────────────────────────────────────────────────
     Tab Manager (fade + slide)
     ──────────────────────────────────────────────────────────────── */
  const Tabs = (() => {
    const tabBtns = qsa('.tab');
    const panels = qsa('.tab-content');
    let active = qs('.tab.active')?.dataset.tab || 'editor';
    let token = 0;

    const setActive = (next) => {
      if (!next || next === active) return;
      const prev = active;
      active = next;
      const my = ++token;

      tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === next));

      const prevPanel = qs(`#tab-${prev}`);
      const nextPanel = qs(`#tab-${next}`);
      if (!nextPanel) return;

      // Clean up any other panels that might still be active (fast switching)
      panels.forEach((p) => {
        if (p !== prevPanel && p !== nextPanel) p.classList.remove('active', 'is-leaving');
      });

      if (prevPanel && prevPanel !== nextPanel) {
        prevPanel.classList.add('is-leaving');
        window.setTimeout(() => {
          if (token !== my) return; // a newer switch happened
          if (active !== prev) prevPanel.classList.remove('active');
          prevPanel.classList.remove('is-leaving');
        }, 260);
      }

      nextPanel.classList.add('active');
      // Ensure scroll resets feel deliberate (studio-like)
      nextPanel.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const init = () => {
      tabBtns.forEach((btn) => btn.addEventListener('click', () => setActive(btn.dataset.tab)));
    };

    return { init, setActive, get active() { return active; } };
  })();

  /* ────────────────────────────────────────────────────────────────
     Editor Lab (existing features preserved + smoother redraw)
     ──────────────────────────────────────────────────────────────── */
  const EditorLab = (() => {
    const editorDrop = qs('#editorDrop');
    const editorInput = qs('#editorInput');
    const editorWorkspace = qs('#editorWorkspace');
    const editorCanvas = qs('#editorCanvas');
    const ctx = editorCanvas.getContext('2d', { willReadFrequently: false });
    const vignetteOverlay = qs('#vignetteOverlay');
    const loading = qs('#editorLoading');

    let sourceImage = null;
    let localBlurEnabled = false;
    let brushRadius = 64;
    let brushStrength = 0.70; // 0..1
    let maskHasPaint = false;

    const blurModeLabel = qs('#lblBlurMode');
    const localBlurToggle = qs('#ctrlLocalBlur');
    const localBlurState = qs('#valLocalBlur');
    const blurBrushSize = qs('#ctrlBlurBrushSize');
    const blurBrushSizeVal = qs('#valBlurBrushSize');
    const blurBrushStrength = qs('#ctrlBlurBrushStrength');
    const blurBrushStrengthVal = qs('#valBlurBrushStrength');
    const clearLocalBlurBtn = qs('#clearLocalBlurBtn');

    // Offscreen layers for selective blur compositing
    const offBase = document.createElement('canvas');
    const offBlur = document.createElement('canvas');
    const offTemp = document.createElement('canvas');
    const mask = document.createElement('canvas');
    const bctx = offBase.getContext('2d', { willReadFrequently: false });
    const blctx = offBlur.getContext('2d', { willReadFrequently: false });
    const tctx = offTemp.getContext('2d', { willReadFrequently: false });
    const mctx = mask.getContext('2d', { willReadFrequently: false });

    const sliders = {
      brightness: { el: qs('#ctrlBrightness'), val: qs('#valBrightness'), unit: '%' },
      contrast: { el: qs('#ctrlContrast'), val: qs('#valContrast'), unit: '%' },
      saturation: { el: qs('#ctrlSaturation'), val: qs('#valSaturation'), unit: '%' },
      hue: { el: qs('#ctrlHue'), val: qs('#valHue'), unit: '°' },
      blur: { el: qs('#ctrlBlur'), val: qs('#valBlur'), unit: 'px' },
      opacity: { el: qs('#ctrlOpacity'), val: qs('#valOpacity'), unit: '%' },
      sepia: { el: qs('#ctrlSepia'), val: qs('#valSepia'), unit: '%' },
      grayscale: { el: qs('#ctrlGrayscale'), val: qs('#valGrayscale'), unit: '%' },
      invert: { el: qs('#ctrlInvert'), val: qs('#valInvert'), unit: '%' },
      vignette: { el: qs('#ctrlVignette'), val: qs('#valVignette'), unit: '%' },
    };

    const PRESETS = {
      vivid: { brightness: 110, contrast: 120, saturation: 160, hue: 0, blur: 0, opacity: 100, sepia: 0, grayscale: 0, invert: 0, vignette: 0 },
      matte: { brightness: 105, contrast: 90, saturation: 80, hue: 0, blur: 0, opacity: 100, sepia: 10, grayscale: 0, invert: 0, vignette: 30 },
      noir: { brightness: 90, contrast: 130, saturation: 0, hue: 0, blur: 0, opacity: 100, sepia: 0, grayscale: 100, invert: 0, vignette: 60 },
      warm: { brightness: 108, contrast: 105, saturation: 110, hue: 15, blur: 0, opacity: 100, sepia: 20, grayscale: 0, invert: 0, vignette: 10 },
      cool: { brightness: 100, contrast: 105, saturation: 90, hue: 200, blur: 0, opacity: 100, sepia: 0, grayscale: 0, invert: 0, vignette: 10 },
      faded: { brightness: 115, contrast: 80, saturation: 60, hue: 0, blur: 0, opacity: 90, sepia: 15, grayscale: 0, invert: 0, vignette: 20 },
      chrome: { brightness: 110, contrast: 140, saturation: 130, hue: 0, blur: 0, opacity: 100, sepia: 0, grayscale: 0, invert: 0, vignette: 40 },
      vintage: { brightness: 100, contrast: 100, saturation: 70, hue: 10, blur: 0, opacity: 100, sepia: 40, grayscale: 0, invert: 0, vignette: 50 },
    };

    const buildFilter = ({ includeBlur } = { includeBlur: true }) => [
      `brightness(${sliders.brightness.el.value}%)`,
      `contrast(${sliders.contrast.el.value}%)`,
      `saturate(${sliders.saturation.el.value}%)`,
      `hue-rotate(${sliders.hue.el.value}deg)`,
      ...(includeBlur ? [`blur(${sliders.blur.el.value}px)`] : []),
      `opacity(${sliders.opacity.el.value}%)`,
      `sepia(${sliders.sepia.el.value}%)`,
      `grayscale(${sliders.grayscale.el.value}%)`,
      `invert(${sliders.invert.el.value}%)`,
    ].join(' ');

    const render = () => {
      if (!sourceImage) return;
      ctx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);

      if (!localBlurEnabled) {
        // Original behavior: global blur applies to full image.
        ctx.filter = buildFilter({ includeBlur: true });
        ctx.drawImage(sourceImage, 0, 0, editorCanvas.width, editorCanvas.height);
        ctx.filter = 'none';
      } else {
        // Selective blur: base layer (no blur) + blurred layer masked by brush strokes.
        bctx.filter = buildFilter({ includeBlur: false });
        bctx.clearRect(0, 0, offBase.width, offBase.height);
        bctx.drawImage(sourceImage, 0, 0, offBase.width, offBase.height);
        bctx.filter = 'none';

        ctx.drawImage(offBase, 0, 0);

        if (maskHasPaint && (parseFloat(sliders.blur.el.value) || 0) > 0) {
          blctx.filter = buildFilter({ includeBlur: true });
          blctx.clearRect(0, 0, offBlur.width, offBlur.height);
          blctx.drawImage(sourceImage, 0, 0, offBlur.width, offBlur.height);
          blctx.filter = 'none';

          // temp = blurred layer masked by mask alpha
          tctx.clearRect(0, 0, offTemp.width, offTemp.height);
          tctx.globalCompositeOperation = 'source-over';
          tctx.drawImage(offBlur, 0, 0);
          tctx.globalCompositeOperation = 'destination-in';
          tctx.drawImage(mask, 0, 0);
          tctx.globalCompositeOperation = 'source-over';

          ctx.drawImage(offTemp, 0, 0);
        }
      }

      const v = parseInt(sliders.vignette.el.value, 10) || 0;
      if (v > 0) {
        const spread = Math.round(v * 2);
        const opacity = (v / 100).toFixed(2);
        vignetteOverlay.style.boxShadow = `inset 0 0 ${spread}px ${Math.round(spread / 2)}px rgba(0,0,0,${opacity})`;
        vignetteOverlay.style.display = 'block';
      } else {
        vignetteOverlay.style.display = 'none';
      }
    };

    let scheduleRender = rafSchedule(render);

    const showLoading = (on) => loading?.classList.toggle('active', !!on);

    const fitCanvasToImage = (img) => {
      const maxW = 1400, maxH = 1050;
      let w = img.width, h = img.height;
      if (w > maxW) { h = (h * maxW) / w; w = maxW; }
      if (h > maxH) { w = (w * maxH) / h; h = maxH; }
      editorCanvas.width = Math.max(1, Math.round(w));
      editorCanvas.height = Math.max(1, Math.round(h));

      // sync offscreen buffers
      offBase.width = editorCanvas.width; offBase.height = editorCanvas.height;
      offBlur.width = editorCanvas.width; offBlur.height = editorCanvas.height;
      offTemp.width = editorCanvas.width; offTemp.height = editorCanvas.height;
      mask.width = editorCanvas.width; mask.height = editorCanvas.height;
      mctx.clearRect(0, 0, mask.width, mask.height);
      maskHasPaint = false;
    };

    const loadImageToEditor = async (file) => {
      try {
        editorDrop.style.display = 'none';
        editorWorkspace.style.display = 'grid';
        showLoading(true);
        const img = await loadImageFromFile(file);
        sourceImage = img;
        fitCanvasToImage(img);
        scheduleRender();
      } finally {
        showLoading(false);
      }
    };

    const reset = () => {
      const defaults = { brightness: 100, contrast: 100, saturation: 100, hue: 0, blur: 0, opacity: 100, sepia: 0, grayscale: 0, invert: 0, vignette: 0 };
      Object.entries(defaults).forEach(([k, v]) => {
        sliders[k].el.value = String(v);
        sliders[k].val.textContent = String(v);
        setRangeFill(sliders[k].el);
      });
      qsa('.preset-btn').forEach((b) => b.classList.remove('active'));
      // Reset local blur too (studio-grade "clean slate")
      localBlurEnabled = false;
      if (localBlurToggle) localBlurToggle.checked = false;
      mctx.clearRect(0, 0, mask.width, mask.height);
      maskHasPaint = false;
      if (localBlurState) localBlurState.textContent = 'Off';
      if (blurModeLabel) blurModeLabel.textContent = 'Blur';
      editorCanvas.classList.remove('brush-on');
      if (blurBrushSize) blurBrushSize.disabled = true;
      if (blurBrushStrength) blurBrushStrength.disabled = true;
      if (clearLocalBlurBtn) clearLocalBlurBtn.disabled = true;
      scheduleRender();
    };

    const download = () => {
      if (!sourceImage) return;
      const out = document.createElement('canvas');
      out.width = editorCanvas.width;
      out.height = editorCanvas.height;
      const octx = out.getContext('2d');

      if (!localBlurEnabled) {
        octx.filter = buildFilter({ includeBlur: true });
        octx.drawImage(sourceImage, 0, 0, out.width, out.height);
        octx.filter = 'none';
      } else {
        // base (no blur)
        octx.filter = buildFilter({ includeBlur: false });
        octx.drawImage(sourceImage, 0, 0, out.width, out.height);
        octx.filter = 'none';

        if (maskHasPaint && (parseFloat(sliders.blur.el.value) || 0) > 0) {
          const blurOut = document.createElement('canvas');
          blurOut.width = out.width; blurOut.height = out.height;
          const bo = blurOut.getContext('2d');
          bo.filter = buildFilter({ includeBlur: true });
          bo.drawImage(sourceImage, 0, 0, out.width, out.height);
          bo.filter = 'none';

          const temp = document.createElement('canvas');
          temp.width = out.width; temp.height = out.height;
          const tc = temp.getContext('2d');
          tc.drawImage(blurOut, 0, 0);
          tc.globalCompositeOperation = 'destination-in';
          tc.drawImage(mask, 0, 0);
          tc.globalCompositeOperation = 'source-over';

          octx.drawImage(temp, 0, 0);
        }
      }

      const v = parseInt(sliders.vignette.el.value, 10) || 0;
      if (v > 0) {
        const grd = octx.createRadialGradient(out.width / 2, out.height / 2, out.width * 0.30, out.width / 2, out.height / 2, out.width * 0.92);
        grd.addColorStop(0, 'rgba(0,0,0,0)');
        grd.addColorStop(1, `rgba(0,0,0,${(v / 100).toFixed(2)})`);
        octx.fillStyle = grd;
        octx.fillRect(0, 0, out.width, out.height);
      }
      downloadCanvasJPEG(out, 'picmix-edit.jpg', 0.95);
    };

    const newPhoto = () => {
      sourceImage = null;
      editorInput.value = '';
      editorWorkspace.style.display = 'none';
      editorDrop.style.display = 'block';
      mctx.clearRect(0, 0, mask.width, mask.height);
      maskHasPaint = false;
    };

    const init = () => {
      // Drop zone
      editorDrop.addEventListener('click', (e) => {
        // Prevent double-open when clicking the <label> that already opens the picker.
        if (e.target.closest('label, .link, input, button')) return;
        editorInput.click();
      });
      editorInput.addEventListener('change', () => editorInput.files?.[0] && loadImageToEditor(editorInput.files[0]));
      editorDrop.addEventListener('dragover', (e) => { e.preventDefault(); editorDrop.classList.add('drag-over'); });
      editorDrop.addEventListener('dragleave', () => editorDrop.classList.remove('drag-over'));
      editorDrop.addEventListener('drop', (e) => {
        e.preventDefault();
        editorDrop.classList.remove('drag-over');
        const f = e.dataTransfer?.files?.[0];
        if (f) loadImageToEditor(f);
      });

      // Sliders
      Object.entries(sliders).forEach(([, s]) => {
        setRangeFill(s.el);
        s.el.addEventListener('input', () => {
          s.val.textContent = s.el.value;
          setRangeFill(s.el);
          qsa('.preset-btn').forEach((b) => b.classList.remove('active'));
          scheduleRender();
        });
      });

      // Local blur brush controls
      const syncLocalBlurUI = () => {
        if (localBlurState) localBlurState.textContent = localBlurEnabled ? 'On' : 'Off';
        if (blurModeLabel) blurModeLabel.textContent = localBlurEnabled ? 'Blur Amount' : 'Blur';
        editorCanvas.classList.toggle('brush-on', localBlurEnabled);
        if (blurBrushSize) blurBrushSize.disabled = !localBlurEnabled;
        if (blurBrushStrength) blurBrushStrength.disabled = !localBlurEnabled;
        if (clearLocalBlurBtn) clearLocalBlurBtn.disabled = !localBlurEnabled || !maskHasPaint;
      };

      if (blurBrushSize) {
        brushRadius = Number(blurBrushSize.value) || brushRadius;
        if (blurBrushSizeVal) blurBrushSizeVal.textContent = String(brushRadius);
        setRangeFill(blurBrushSize);
        blurBrushSize.addEventListener('input', () => {
          brushRadius = Number(blurBrushSize.value) || brushRadius;
          if (blurBrushSizeVal) blurBrushSizeVal.textContent = String(brushRadius);
          setRangeFill(blurBrushSize);
        });
      }
      if (blurBrushStrength) {
        brushStrength = clamp((Number(blurBrushStrength.value) || 70) / 100, 0.1, 1);
        if (blurBrushStrengthVal) blurBrushStrengthVal.textContent = String(blurBrushStrength.value);
        setRangeFill(blurBrushStrength);
        blurBrushStrength.addEventListener('input', () => {
          brushStrength = clamp((Number(blurBrushStrength.value) || 70) / 100, 0.1, 1);
          if (blurBrushStrengthVal) blurBrushStrengthVal.textContent = String(blurBrushStrength.value);
          setRangeFill(blurBrushStrength);
        });
      }

      if (localBlurToggle) {
        localBlurToggle.addEventListener('change', () => {
          localBlurEnabled = !!localBlurToggle.checked;
          syncLocalBlurUI();
          scheduleRender();
        });
      }
      clearLocalBlurBtn?.addEventListener('click', () => {
        mctx.clearRect(0, 0, mask.width, mask.height);
        maskHasPaint = false;
        syncLocalBlurUI();
        scheduleRender();
      });

      // Paint-to-blur on the canvas
      let painting = false;
      let last = null;
      const toCanvasXY = (e) => {
        const rect = editorCanvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (editorCanvas.width / rect.width);
        const y = (e.clientY - rect.top) * (editorCanvas.height / rect.height);
        return { x, y };
      };
      const stamp = (x, y) => {
        mctx.save();
        mctx.globalCompositeOperation = 'source-over';
        mctx.fillStyle = `rgba(255,255,255,${brushStrength})`;
        mctx.beginPath();
        mctx.arc(x, y, brushRadius, 0, Math.PI * 2);
        mctx.fill();
        mctx.restore();
      };
      const stroke = (a, b) => {
        mctx.save();
        mctx.globalCompositeOperation = 'source-over';
        mctx.strokeStyle = `rgba(255,255,255,${brushStrength})`;
        mctx.lineWidth = brushRadius * 2;
        mctx.lineCap = 'round';
        mctx.lineJoin = 'round';
        mctx.beginPath();
        mctx.moveTo(a.x, a.y);
        mctx.lineTo(b.x, b.y);
        mctx.stroke();
        mctx.restore();
      };

      editorCanvas.addEventListener('pointerdown', (e) => {
        if (!localBlurEnabled || !sourceImage) return;
        painting = true;
        editorCanvas.setPointerCapture(e.pointerId);
        const p = toCanvasXY(e);
        stamp(p.x, p.y);
        last = p;
        maskHasPaint = true;
        syncLocalBlurUI();
        scheduleRender();
        e.preventDefault();
      });
      editorCanvas.addEventListener('pointermove', (e) => {
        if (!painting || !localBlurEnabled || !sourceImage) return;
        const p = toCanvasXY(e);
        if (last) stroke(last, p);
        last = p;
        maskHasPaint = true;
        syncLocalBlurUI();
        scheduleRender();
        e.preventDefault();
      });
      const endPaint = (e) => {
        if (!painting) return;
        painting = false;
        last = null;
        try { editorCanvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      };
      editorCanvas.addEventListener('pointerup', endPaint);
      editorCanvas.addEventListener('pointercancel', endPaint);

      syncLocalBlurUI();

      // Presets
      qsa('.preset-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const p = PRESETS[btn.dataset.preset];
          if (!p) return;
          Object.entries(p).forEach(([k, v]) => {
            if (!sliders[k]) return;
            sliders[k].el.value = String(v);
            sliders[k].val.textContent = String(v);
            setRangeFill(sliders[k].el);
          });
          qsa('.preset-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          scheduleRender();
        });
      });

      qs('#resetBtn')?.addEventListener('click', reset);
      qs('#downloadBtn')?.addEventListener('click', download);
      qs('#newPhotoBtn')?.addEventListener('click', newPhoto);
    };

    return { init };
  })();

  /* ────────────────────────────────────────────────────────────────
     Collage Studio 2.0 (drag reorder, aspect presets, gradients, text)
     ──────────────────────────────────────────────────────────────── */
  const CollageStudio = (() => {
    const els = {
      drop: qs('#collageDrop'),
      input: qs('#collageInput'),
      thumbs: qs('#collageThumbs'),
      options: qs('#collageOptions'),
      setup: qs('#collageSetup'),
      result: qs('#collageResult'),
      canvas: qs('#collageCanvas'),
      cwrap: qs('.collage-canvas-wrap'),
      ctx: qs('#collageCanvas')?.getContext('2d'),
      gap: qs('#collageGap'),
      pad: qs('#collagePad'),
      valGap: qs('#valGap'),
      valPad: qs('#valPad'),
      buildBtn: qs('#buildCollageBtn'),
      clearBtn: qs('#clearCollageBtn'),
      backBtn: qs('#collageBackBtn'),
      dlBtn: qs('#collageDownloadBtn'),
      // new
      bgSolidRow: qs('#collageBgSolidRow'),
      bgGradRow: qs('#collageBgGradientRow'),
      gradA: qs('#collageGradA'),
      gradB: qs('#collageGradB'),
      gradAngle: qs('#collageGradAngle'),
      round: qs('#collageRound'),
      valRound: qs('#valRound'),
      shadow: qs('#collageShadow'),
      text: qs('#collageText'),
      textSize: qs('#collageTextSize'),
      valTextSize: qs('#valTextSize'),
      textColor: qs('#collageTextColor'),
      textOpacity: qs('#collageTextOpacity'),
      valTextOpacity: qs('#valTextOpacity'),
      quality: qs('#collageQuality'),
      valQuality: qs('#valQuality'),
      textDrag: qs('#collageTextDrag'),
    };

    const BASE_W = 1400;

    const state = {
      items: /** @type {{id:string,img:HTMLImageElement}[]} */ ([]),
      layout: 'grid',
      aspect: '1:1',
      bgMode: 'solid',
      bgColor: '#0d0d0d',
      gradA: '#070A12',
      gradB: '#2D1B69',
      gradAngle: 45,
      gap: 8,
      pad: 16,
      round: 10,
      shadow: true,
      frame: 'minimal', // minimal | neon | film | torn
      text: {
        value: '',
        size: 40,
        color: '#ffffff',
        opacity: 0.85,
        x: 0.5,
        y: 0.85,
      },
      quality: 0.95,
    };

    const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
    const roundRectPath = (ctx, x, y, w, h, r) => {
      const rr = clamp(r, 0, Math.min(w, h) / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    };

    const coverDraw = (ctx, img, x, y, w, h) => {
      const ir = img.width / img.height;
      const cr = w / h;
      let sx, sy, sw, sh;
      if (ir > cr) { sh = img.height; sw = sh * cr; sx = (img.width - sw) / 2; sy = 0; }
      else { sw = img.width; sh = sw / cr; sx = 0; sy = (img.height - sh) / 2; }
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    };

    const canvasSizeForAspect = (aspect) => {
      const W = BASE_W;
      let H = BASE_W;
      if (aspect === '4:5') H = Math.round(W * 5 / 4);
      if (aspect === '9:16') H = Math.round(W * 16 / 9);
      return { W, H };
    };

    const fillBackground = (ctx, W, H) => {
      if (state.bgMode === 'gradient') {
        const ang = (Number(state.gradAngle) || 0) * Math.PI / 180;
        const cx = W / 2, cy = H / 2;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        const len = Math.hypot(W, H) / 2;
        const x0 = cx - dx * len, y0 = cy - dy * len;
        const x1 = cx + dx * len, y1 = cy + dy * len;
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, state.gradA);
        g.addColorStop(1, state.gradB);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = state.bgColor;
      }
      ctx.fillRect(0, 0, W, H);
    };

    const drawFrame = (ctx, rect, style, seedStr) => {
      const { x, y, w, h, r } = rect;
      if (style === 'minimal') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 2;
        roundRectPath(ctx, x, y, w, h, r);
        ctx.stroke();
        ctx.restore();
        return;
      }
      if (style === 'neon') {
        ctx.save();
        ctx.strokeStyle = 'rgba(35,213,255,0.85)';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(35,213,255,0.35)';
        ctx.shadowBlur = 18;
        roundRectPath(ctx, x, y, w, h, r);
        ctx.stroke();
        ctx.restore();
        return;
      }
      if (style === 'film') {
        ctx.save();
        // dark frame
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 10;
        roundRectPath(ctx, x, y, w, h, Math.max(2, r));
        ctx.stroke();
        // perforations
        const holeR = 3;
        const holes = Math.max(8, Math.floor(w / 22));
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        for (let i = 0; i < holes; i++) {
          const t = (i + 0.5) / holes;
          const hx = x + t * w;
          ctx.beginPath();
          ctx.arc(hx, y + 6, holeR, 0, Math.PI * 2);
          ctx.arc(hx, y + h - 6, holeR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        return;
      }
      if (style === 'torn') {
        const seed = Array.from(seedStr).reduce((a, c) => a + c.charCodeAt(0), 0) >>> 0;
        const rnd = mulberry32(seed);
        const amp = Math.min(10, Math.max(4, r));
        const step = 18;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = 16;
        ctx.beginPath();
        // top
        for (let px = x; px <= x + w; px += step) ctx.lineTo(px, y + (rnd() - 0.5) * amp);
        // right
        for (let py = y; py <= y + h; py += step) ctx.lineTo(x + w + (rnd() - 0.5) * amp, py);
        // bottom
        for (let px = x + w; px >= x; px -= step) ctx.lineTo(px, y + h + (rnd() - 0.5) * amp);
        // left
        for (let py = y + h; py >= y; py -= step) ctx.lineTo(x + (rnd() - 0.5) * amp, py);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    };

    const layoutRects = (n, W, H) => {
      const gap = state.gap;
      const pad = state.pad;
      const rects = [];

      if (state.layout === 'horizontal') {
        const cellH = H - pad * 2;
        const cellW = (W - pad * 2 - gap * (n - 1)) / n;
        for (let i = 0; i < n; i++) rects.push({ x: pad + i * (cellW + gap), y: pad, w: cellW, h: cellH });
        return rects;
      }

      if (state.layout === 'diagonal') {
        const cellW = Math.min(W, H) * 0.62;
        const cellH = Math.min(W, H) * 0.44;
        const step = n <= 1 ? 0 : (Math.min(W, H) * 0.22);
        for (let i = 0; i < n; i++) {
          rects.push({
            x: pad + i * step,
            y: pad + i * step,
            w: cellW,
            h: cellH,
          });
        }
        return rects;
      }

      if (state.layout === 'polaroid') {
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const polW = Math.min(320, (W - pad * 2 - gap * (cols - 1)) / cols);
        const polH = polW * 1.12;
        for (let i = 0; i < n; i++) {
          const col = i % cols;
          const row = Math.floor(i / cols);
          rects.push({
            x: pad + col * (polW + gap),
            y: pad + row * (polH + gap),
            w: polW,
            h: polH,
            polaroid: true,
          });
        }
        return rects;
      }

      if (state.layout === 'mosaic') {
        const rows = Math.ceil(n / 3);
        const cellH = (H - pad * 2 - gap * (rows - 1)) / rows;
        let idx = 0;
        for (let r = 0; r < rows && idx < n; r++) {
          const remaining = n - idx;
          const cols = remaining >= 3 ? (r % 2 === 0 ? 3 : 2) : remaining;
          const cellW = (W - pad * 2 - gap * (cols - 1)) / cols;
          const y = pad + r * (cellH + gap);
          for (let c = 0; c < cols && idx < n; c++, idx++) {
            rects.push({ x: pad + c * (cellW + gap), y, w: cellW, h: cellH });
          }
        }
        return rects;
      }

      // default: grid
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cellW = (W - pad * 2 - gap * (cols - 1)) / cols;
      const cellH = (H - pad * 2 - gap * (rows - 1)) / rows;
      for (let i = 0; i < n; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        rects.push({ x: pad + col * (cellW + gap), y: pad + row * (cellH + gap), w: cellW, h: cellH });
      }
      return rects;
    };

    const render = () => {
      if (!els.ctx) return;
      const n = state.items.length;
      if (!n) return;
      const { W, H } = canvasSizeForAspect(state.aspect);
      els.canvas.width = W;
      els.canvas.height = H;

      const ctx = els.ctx;
      ctx.clearRect(0, 0, W, H);
      fillBackground(ctx, W, H);

      const rects = layoutRects(n, W, H);
      const corner = state.round;

      state.items.forEach((it, i) => {
        const base = rects[i] || rects[rects.length - 1];
        const x = base.x, y = base.y, w = base.w, h = base.h;
        const r = clamp(corner, 0, Math.min(w, h) / 2);
        const rect = { x, y, w, h, r };

        // Polaroid variant: draw card + inset photo
        if (base.polaroid) {
          const seed = Array.from(it.id).reduce((a, c) => a + c.charCodeAt(0), 0) >>> 0;
          const rnd = mulberry32(seed);
          const angle = (rnd() * 10 - 5) * Math.PI / 180;
          const border = Math.max(10, Math.round(w * 0.06));
          const bottomSpace = Math.max(30, Math.round(h * 0.17));
          const innerX = x + border;
          const innerY = y + border;
          const innerW = w - border * 2;
          const innerH = h - border * 2 - bottomSpace;

          ctx.save();
          ctx.translate(x + w / 2, y + h / 2);
          ctx.rotate(angle);

          // shadow
          if (state.shadow) {
            ctx.shadowColor = 'rgba(0,0,0,0.55)';
            ctx.shadowBlur = 18;
            ctx.shadowOffsetY = 8;
          }
          ctx.fillStyle = 'rgba(255,255,255,0.92)';
          ctx.fillRect(-w / 2, -h / 2, w, h);
          ctx.shadowColor = 'transparent';

          // photo
          ctx.save();
          roundRectPath(ctx, -w / 2 + border, -h / 2 + border, innerW, innerH, Math.max(6, r));
          ctx.clip();
          coverDraw(ctx, it.img, -w / 2 + border, -h / 2 + border, innerW, innerH);
          ctx.restore();

          // subtle frame on card
          ctx.strokeStyle = 'rgba(0,0,0,0.10)';
          ctx.lineWidth = 2;
          ctx.strokeRect(-w / 2, -h / 2, w, h);

          ctx.restore();
          return;
        }

        // shadow pass
        if (state.shadow) {
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.55)';
          ctx.shadowBlur = 18;
          ctx.shadowOffsetY = 8;
          ctx.fillStyle = 'rgba(0,0,0,0.01)';
          roundRectPath(ctx, x, y, w, h, r);
          ctx.fill();
          ctx.restore();
        }

        // image pass
        ctx.save();
        roundRectPath(ctx, x, y, w, h, r);
        ctx.clip();
        coverDraw(ctx, it.img, x, y, w, h);
        ctx.restore();

        // frame overlay
        drawFrame(ctx, rect, state.frame, it.id);
      });

      // text overlay (baked into canvas)
      const t = state.text.value.trim();
      if (t) {
        ctx.save();
        const fontPx = Number(state.text.size) || 40;
        ctx.font = `800 ${fontPx}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-display') || 'Syne'}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.65)';
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 6;
        const x = clamp(state.text.x, 0, 1) * W;
        const y = clamp(state.text.y, 0, 1) * H;
        const a = clamp(state.text.opacity, 0, 1);
        ctx.fillStyle = withAlpha(state.text.color, a);
        ctx.fillText(t, x, y);
        ctx.restore();
      }
    };

    const scheduleRender = rafSchedule(render);

    function withAlpha(hex, alpha) {
      const h = (hex || '#ffffff').replace('#', '').trim();
      const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
      const r = parseInt(v.slice(0, 2), 16) || 255;
      const g = parseInt(v.slice(2, 4), 16) || 255;
      const b = parseInt(v.slice(4, 6), 16) || 255;
      return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
    }

    const updateThumbVisibility = () => {
      const has = state.items.length > 0;
      els.thumbs.style.display = has ? 'flex' : 'none';
      els.options.style.display = has ? 'flex' : 'none';
    };

    const renderThumbs = () => {
      els.thumbs.innerHTML = '';
      state.items.forEach((it, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'collage-thumb';
        wrap.draggable = true;
        wrap.dataset.id = it.id;
        wrap.dataset.index = String(idx);

        const im = document.createElement('img');
        im.src = it.img.src;
        im.alt = `Photo ${idx + 1}`;

        const btn = document.createElement('button');
        btn.className = 'remove-thumb';
        btn.textContent = '×';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.items.splice(idx, 1);
          renderThumbs();
          if (els.result.style.display !== 'none') scheduleRender();
        });

        wrap.appendChild(im);
        wrap.appendChild(btn);
        els.thumbs.appendChild(wrap);
      });
      wireThumbDnD();
      updateThumbVisibility();
    };

    let dragId = null;
    const wireThumbDnD = () => {
      qsa('.collage-thumb', els.thumbs).forEach((node) => {
        node.addEventListener('dragstart', (e) => {
          dragId = node.dataset.id || null;
          node.classList.add('dragging');
          e.dataTransfer?.setData('text/plain', dragId || '');
          e.dataTransfer?.setDragImage(node, 30, 30);
        });
        node.addEventListener('dragend', () => {
          dragId = null;
          node.classList.remove('dragging');
          qsa('.collage-thumb', els.thumbs).forEach((n) => n.classList.remove('drag-over'));
        });
        node.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (!dragId || dragId === node.dataset.id) return;
          node.classList.add('drag-over');
        });
        node.addEventListener('dragleave', () => node.classList.remove('drag-over'));
        node.addEventListener('drop', (e) => {
          e.preventDefault();
          const targetId = node.dataset.id;
          if (!dragId || !targetId || dragId === targetId) return;
          const from = state.items.findIndex((x) => x.id === dragId);
          const to = state.items.findIndex((x) => x.id === targetId);
          if (from < 0 || to < 0) return;
          const [moved] = state.items.splice(from, 1);
          state.items.splice(to, 0, moved);
          renderThumbs();
          if (els.result.style.display !== 'none') scheduleRender();
        });
      });
    };

    const addFiles = async (files) => {
      const arr = Array.from(files || []);
      for (const f of arr) {
        if (!f.type.startsWith('image/')) continue;
        const img = await loadImageFromFile(f);
        state.items.push({ id: uid(), img });
        renderThumbs();
      }
    };

    const showGradientControls = () => {
      const isGrad = state.bgMode === 'gradient';
      if (els.bgSolidRow) els.bgSolidRow.style.display = isGrad ? 'none' : 'flex';
      if (els.bgGradRow) els.bgGradRow.style.display = isGrad ? 'flex' : 'none';
    };

    const syncTextDrag = () => {
      const txt = state.text.value.trim();
      if (!els.textDrag) return;
      if (!txt || els.result.style.display === 'none') {
        els.textDrag.style.display = 'none';
        return;
      }

      els.textDrag.style.display = 'block';
      els.textDrag.textContent = txt;
      // Make the drag overlay visible without doubling the baked canvas text.
      els.textDrag.style.color = 'transparent';
      els.textDrag.style.webkitTextStroke = `1px ${withAlpha(state.text.color, 0.85)}`;
      els.textDrag.style.textShadow = '0 14px 34px rgba(0,0,0,0.65)';
      els.textDrag.style.fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-display') || 'Syne';
      els.textDrag.style.fontWeight = '800';
      els.textDrag.style.fontSize = `${Math.max(12, Number(state.text.size) || 40)}px`;
      els.textDrag.style.transform = 'translate(-50%, -50%)';

      const rect = els.canvas.getBoundingClientRect();
      const x = rect.left + rect.width * clamp(state.text.x, 0, 1);
      const y = rect.top + rect.height * clamp(state.text.y, 0, 1);
      const hostRect = els.cwrap.getBoundingClientRect();
      els.textDrag.style.left = `${x - hostRect.left}px`;
      els.textDrag.style.top = `${y - hostRect.top}px`;
    };

    const wireTextDragging = () => {
      if (!els.textDrag) return;
      let dragging = false;

      const onMove = (e) => {
        if (!dragging) return;
        const rect = els.canvas.getBoundingClientRect();
        const nx = clamp((e.clientX - rect.left) / rect.width, 0.02, 0.98);
        const ny = clamp((e.clientY - rect.top) / rect.height, 0.06, 0.96);
        state.text.x = nx;
        state.text.y = ny;
        syncTextDrag();
        scheduleRender();
      };

      els.textDrag.addEventListener('pointerdown', (e) => {
        dragging = true;
        els.textDrag.setPointerCapture(e.pointerId);
        els.textDrag.style.cursor = 'grabbing';
      });
      els.textDrag.addEventListener('pointerup', () => {
        dragging = false;
        els.textDrag.style.cursor = 'grab';
      });
      els.textDrag.addEventListener('pointercancel', () => {
        dragging = false;
        els.textDrag.style.cursor = 'grab';
      });
      window.addEventListener('pointermove', onMove);

      // keep overlay in correct place on resize
      window.addEventListener('resize', rafSchedule(syncTextDrag));
    };

    const build = () => {
      if (!state.items.length) return;
      els.setup.style.display = 'none';
      els.result.style.display = 'flex';
      scheduleRender();
      window.setTimeout(syncTextDrag, 20);
    };

    const back = () => {
      els.result.style.display = 'none';
      els.setup.style.display = 'block';
    };

    const clearAll = () => {
      state.items = [];
      els.input.value = '';
      els.result.style.display = 'none';
      els.setup.style.display = 'block';
      els.thumbs.innerHTML = '';
      updateThumbVisibility();
    };

    const init = () => {
      // Drop zone
      els.drop.addEventListener('click', (e) => {
        // Prevent double-open when clicking the <label> that already opens the picker.
        if (e.target.closest('label, .link, input, button')) return;
        els.input.click();
      });
      els.input.addEventListener('change', () => els.input.files && addFiles(els.input.files));
      els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('drag-over'); });
      els.drop.addEventListener('dragleave', () => els.drop.classList.remove('drag-over'));
      els.drop.addEventListener('drop', (e) => {
        e.preventDefault();
        els.drop.classList.remove('drag-over');
        const files = e.dataTransfer?.files;
        if (files) addFiles(files);
      });

      // existing buttons
      qsa('.layout-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          qsa('.layout-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          state.layout = btn.dataset.layout || 'grid';
          if (els.result.style.display !== 'none') scheduleRender();
        });
      });
      qsa('.bg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          qsa('.bg-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          state.bgColor = btn.dataset.bg || '#0d0d0d';
          state.bgMode = 'solid';
          qsa('.pill-btn[data-bgmode]').forEach((b) => b.classList.toggle('active', b.dataset.bgmode === 'solid'));
          showGradientControls();
          if (els.result.style.display !== 'none') scheduleRender();
        });
      });

      const bindRange = (input, labelEl, onValue) => {
        if (!input) return;
        setRangeFill(input);
        const sync = () => {
          setRangeFill(input);
          if (labelEl) labelEl.textContent = String(input.value);
          onValue?.(Number(input.value));
        };
        input.addEventListener('input', () => {
          sync();
          if (els.result.style.display !== 'none') scheduleRender();
          if (input === els.textSize || input === els.textOpacity) syncTextDrag();
        });
        sync();
      };

      bindRange(els.gap, els.valGap, (v) => state.gap = v);
      bindRange(els.pad, els.valPad, (v) => state.pad = v);
      bindRange(els.round, els.valRound, (v) => state.round = v);
      bindRange(els.textSize, els.valTextSize, (v) => state.text.size = v);
      bindRange(els.textOpacity, els.valTextOpacity, (v) => state.text.opacity = v / 100);
      bindRange(els.quality, els.valQuality, (v) => state.quality = clamp(v / 100, 0.8, 1));

      // aspect pills
      qsa('.pill-btn[data-aspect]').forEach((btn) => {
        btn.addEventListener('click', () => {
          qsa('.pill-btn[data-aspect]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          state.aspect = btn.dataset.aspect || '1:1';
          if (els.result.style.display !== 'none') scheduleRender();
        });
      });

      // bg mode pills
      qsa('.pill-btn[data-bgmode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          qsa('.pill-btn[data-bgmode]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          state.bgMode = btn.dataset.bgmode || 'solid';
          showGradientControls();
          if (els.result.style.display !== 'none') scheduleRender();
        });
      });
      showGradientControls();

      // gradient controls
      els.gradA?.addEventListener('input', () => { state.gradA = els.gradA.value; if (els.result.style.display !== 'none') scheduleRender(); });
      els.gradB?.addEventListener('input', () => { state.gradB = els.gradB.value; if (els.result.style.display !== 'none') scheduleRender(); });
      els.gradAngle?.addEventListener('change', () => { state.gradAngle = Number(els.gradAngle.value) || 45; if (els.result.style.display !== 'none') scheduleRender(); });

      // shadow toggle
      els.shadow?.addEventListener('change', () => { state.shadow = !!els.shadow.checked; if (els.result.style.display !== 'none') scheduleRender(); });

      // frame pills
      qsa('.pill-btn[data-frame]').forEach((btn) => {
        btn.addEventListener('click', () => {
          qsa('.pill-btn[data-frame]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          state.frame = btn.dataset.frame || 'minimal';
          if (els.result.style.display !== 'none') scheduleRender();
        });
      });

      // text controls
      els.text?.addEventListener('input', () => {
        state.text.value = els.text.value;
        if (els.result.style.display !== 'none') {
          syncTextDrag();
          scheduleRender();
        }
      });
      els.textColor?.addEventListener('input', () => {
        state.text.color = els.textColor.value;
        if (els.result.style.display !== 'none') {
          syncTextDrag();
          scheduleRender();
        }
      });

      // actions
      els.buildBtn?.addEventListener('click', build);
      els.clearBtn?.addEventListener('click', clearAll);
      els.backBtn?.addEventListener('click', back);
      els.dlBtn?.addEventListener('click', () => downloadCanvasJPEG(els.canvas, 'picmix-collage.jpg', state.quality));

      // overlay drag behavior
      wireTextDragging();

      // keep text overlay synced after rendering
      const afterRender = rafSchedule(syncTextDrag);
      const oldSchedule = scheduleRender;
      // wrap scheduleRender to also refresh overlay position after draw
      // (kept tiny to avoid extra work on every input)
      scheduleRender = (...args) => { oldSchedule(...args); afterRender(); };
    };

    return { init };
  })();

  /* ────────────────────────────────────────────────────────────────
     Tone Fusion (Base + Style, palette extraction, tone mapping)
     ──────────────────────────────────────────────────────────────── */
  const ToneFusion = (() => {
    const els = {
      baseDrop: qs('#toneBaseDrop'),
      baseInput: qs('#toneBaseInput'),
      styleDrop: qs('#toneStyleDrop'),
      styleInput: qs('#toneStyleInput'),
      palette: qs('#tonePalette'),
      workspace: qs('#toneWorkspace'),
      canvas: qs('#toneCanvas'),
      ctx: qs('#toneCanvas')?.getContext('2d', { willReadFrequently: true }),
      loading: qs('#toneLoading'),
      intensity: qs('#toneIntensity'),
      valIntensity: qs('#valToneIntensity'),
      dl: qs('#toneDownloadBtn'),
      reset: qs('#toneResetBtn'),
    };

    let baseImg = null;
    let styleImg = null;
    let palette = [];
    let baseOriginal = null; // ImageData
    let outImage = null; // ImageData (reused)

    const showLoading = (on) => els.loading?.classList.toggle('active', !!on);

    const fitToneCanvas = (img) => {
      const maxW = 1400, maxH = 1050;
      let w = img.width, h = img.height;
      if (w > maxW) { h = (h * maxW) / w; w = maxW; }
      if (h > maxH) { w = (w * maxH) / h; h = maxH; }
      els.canvas.width = Math.max(1, Math.round(w));
      els.canvas.height = Math.max(1, Math.round(h));
    };

    const extractPalette = (img, k = 5) => {
      const c = document.createElement('canvas');
      const s = 80;
      c.width = s; c.height = s;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, s, s);
      const data = cx.getImageData(0, 0, s, s).data;

      const samples = [];
      for (let i = 0; i < data.length; i += 16) {
        const a = data[i + 3];
        if (a < 40) continue;
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
      if (!samples.length) return [[120, 120, 120]];

      const rnd = mulberry32((img.width + img.height) >>> 0);
      const centers = [];
      for (let i = 0; i < k; i++) centers.push(samples[Math.floor(rnd() * samples.length)].slice());
      const counts = new Array(k).fill(0);

      for (let iter = 0; iter < 8; iter++) {
        counts.fill(0);
        const sums = centers.map(() => [0, 0, 0]);
        for (const s of samples) {
          let bi = 0;
          let bd = Infinity;
          for (let i = 0; i < k; i++) {
            const c0 = centers[i];
            const d0 = (s[0] - c0[0]) ** 2 + (s[1] - c0[1]) ** 2 + (s[2] - c0[2]) ** 2;
            if (d0 < bd) { bd = d0; bi = i; }
          }
          counts[bi]++;
          sums[bi][0] += s[0]; sums[bi][1] += s[1]; sums[bi][2] += s[2];
        }
        for (let i = 0; i < k; i++) {
          const cCount = counts[i] || 1;
          centers[i][0] = sums[i][0] / cCount;
          centers[i][1] = sums[i][1] / cCount;
          centers[i][2] = sums[i][2] / cCount;
        }
      }

      // Sort by dominance
      const ranked = centers
        .map((c0, i) => ({ c: c0.map((v) => clamp(Math.round(v), 0, 255)), n: counts[i] || 0 }))
        .sort((a, b) => b.n - a.n)
        .map((x) => x.c);
      return ranked.filter((c0) => c0 && c0.length === 3);
    };

    const softLight = (a, b) => {
      // a,b in 0..1
      const d = (x) => (x <= 0.25 ? (((16 * x - 12) * x + 4) * x) : Math.sqrt(x));
      return b < 0.5 ? (a - (1 - 2 * b) * a * (1 - a)) : (a + (2 * b - 1) * (d(a) - a));
    };

    const toneMap = () => {
      if (!els.ctx || !baseImg || !baseOriginal || !palette.length) return;
      const intensity = clamp((Number(els.intensity?.value || 65) || 0) / 100, 0, 1);
      const src = baseOriginal.data;
      if (!outImage || outImage.width !== baseOriginal.width || outImage.height !== baseOriginal.height) {
        outImage = els.ctx.createImageData(baseOriginal.width, baseOriginal.height);
      }
      const dst = outImage.data;

      const pal = palette;
      const last = pal.length - 1;

      for (let i = 0; i < src.length; i += 4) {
        const r = src[i], g = src[i + 1], b = src[i + 2], a = src[i + 3];
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const pi = Math.min(last, Math.max(0, Math.floor(l * last)));
        const tc = pal[pi];

        const ar = r / 255, ag = g / 255, ab = b / 255;
        const br = tc[0] / 255, bg = tc[1] / 255, bb = tc[2] / 255;

        let rr = lerp(ar, softLight(ar, br), intensity);
        let gg = lerp(ag, softLight(ag, bg), intensity);
        let bb2 = lerp(ab, softLight(ab, bb), intensity);

        // subtle studio curve
        const curve = (x) => clamp((x - 0.5) * 1.06 + 0.5, 0, 1);
        rr = curve(rr); gg = curve(gg); bb2 = curve(bb2);

        dst[i] = (rr * 255) | 0;
        dst[i + 1] = (gg * 255) | 0;
        dst[i + 2] = (bb2 * 255) | 0;
        dst[i + 3] = a;
      }

      els.ctx.putImageData(outImage, 0, 0);
    };

    const scheduleTone = rafSchedule(toneMap);

    const updatePaletteUI = () => {
      if (!els.palette) return;
      if (!palette.length) {
        els.palette.style.display = 'none';
        els.palette.innerHTML = '';
        return;
      }
      els.palette.style.display = 'flex';
      els.palette.innerHTML = '';
      palette.slice(0, 6).forEach((c) => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
        els.palette.appendChild(chip);
      });
    };

    const maybeEnableWorkspace = () => {
      if (!baseImg || !styleImg) return;
      els.workspace.style.display = 'grid';
      showLoading(true);
      window.setTimeout(() => {
        scheduleTone();
        showLoading(false);
      }, 30);
    };

    const loadBase = async (file) => {
      try {
        showLoading(true);
        baseImg = await loadImageFromFile(file);
        fitToneCanvas(baseImg);
        els.ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
        els.ctx.drawImage(baseImg, 0, 0, els.canvas.width, els.canvas.height);
        baseOriginal = els.ctx.getImageData(0, 0, els.canvas.width, els.canvas.height);
        outImage = null;
      } finally {
        showLoading(false);
      }
      maybeEnableWorkspace();
      if (styleImg && palette.length) scheduleTone();
    };

    const loadStyle = async (file) => {
      try {
        showLoading(true);
        styleImg = await loadImageFromFile(file);
        palette = extractPalette(styleImg, 5);
        updatePaletteUI();
      } finally {
        showLoading(false);
      }
      maybeEnableWorkspace();
      if (baseImg && baseOriginal) scheduleTone();
    };

    const reset = () => {
      baseImg = null;
      styleImg = null;
      palette = [];
      baseOriginal = null;
      outImage = null;
      els.baseInput.value = '';
      els.styleInput.value = '';
      els.workspace.style.display = 'none';
      if (els.palette) { els.palette.style.display = 'none'; els.palette.innerHTML = ''; }
      if (els.intensity) {
        els.intensity.value = '65';
        if (els.valIntensity) els.valIntensity.textContent = '65';
        setRangeFill(els.intensity);
      }
      if (els.ctx) els.ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    };

    const init = () => {
      if (els.intensity) {
        setRangeFill(els.intensity);
        els.intensity.addEventListener('input', () => {
          if (els.valIntensity) els.valIntensity.textContent = String(els.intensity.value);
          setRangeFill(els.intensity);
          scheduleTone();
        });
      }

      // drop zones
      els.baseDrop?.addEventListener('click', (e) => {
        // Prevent double-open when clicking the <label> that already opens the picker.
        if (e.target.closest('label, .link, input, button')) return;
        els.baseInput.click();
      });
      els.styleDrop?.addEventListener('click', (e) => {
        // Prevent double-open when clicking the <label> that already opens the picker.
        if (e.target.closest('label, .link, input, button')) return;
        els.styleInput.click();
      });
      els.baseInput?.addEventListener('change', () => els.baseInput.files?.[0] && loadBase(els.baseInput.files[0]));
      els.styleInput?.addEventListener('change', () => els.styleInput.files?.[0] && loadStyle(els.styleInput.files[0]));

      const wireDnD = (dropEl, handler) => {
        if (!dropEl) return;
        dropEl.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.classList.add('drag-over'); });
        dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag-over'));
        dropEl.addEventListener('drop', (e) => {
          e.preventDefault();
          dropEl.classList.remove('drag-over');
          const f = e.dataTransfer?.files?.[0];
          if (f) handler(f);
        });
      };
      wireDnD(els.baseDrop, loadBase);
      wireDnD(els.styleDrop, loadStyle);

      els.dl?.addEventListener('click', () => {
        if (!baseImg || !styleImg) return;
        downloadCanvasJPEG(els.canvas, 'picmix-tone-fusion.jpg', 0.95);
      });
      els.reset?.addEventListener('click', reset);
    };

    return { init };
  })();

  /* ────────────────────────────────────────────────────────────────
     Boot
     ──────────────────────────────────────────────────────────────── */
  const boot = () => {
    Tabs.init();
    initAllRangeFills();
    EditorLab.init();
    CollageStudio.init();
    ToneFusion.init();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

