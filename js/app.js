/* ==========================================================================
   simul — app.js
   Orchestrateur : navigation entre vues, capture, sauvegarde, galerie.
   ========================================================================== */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const views = {
    capture: $('#view-capture'),
    review:  $('#view-review'),
    gallery: $('#view-gallery'),
    detail:  $('#view-detail'),
  };

  let pendingSouvenir = null; // en cours de revue, pas encore sauvegarde
  let currentTags = [];
  let recordingVideo = false;
  let captureFormat = 'photo'; // 'photo' | 'video'

  function showView(name){
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[name].classList.add('active');
  }

  function toast(msg, ms = 2200){
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ---------------- capture ---------------- */

  async function initCapture(){
    const badge = $('#capture-mode-label');
    const badgeWrap = $('#capture-mode-badge');
    const swapBtn = $('#btn-preview-swap');
    try{
      const mode = await Capture.init($('#video-main'), $('#video-pip'));
      if (mode === 'simultane'){
        badge.textContent = 'Capture simultanee';
        badgeWrap.classList.remove('alt');
        swapBtn.style.display = 'none';
      } else {
        badgeWrap.classList.add('alt');
        updateAlterneBadge();
        swapBtn.style.display = 'flex';
      }
    }catch(err){
      badge.textContent = 'Camera indisponible';
      toast("Impossible d'acceder aux cameras. Verifie les autorisations.");
    }
  }

  function updateAlterneBadge(){
    const badge = $('#capture-mode-label');
    const isBack = Capture.currentFacing === 'environment';
    badge.textContent = isBack ? 'Aperçu : arriere' : 'Aperçu : avant';
  }

  $('#btn-preview-swap').addEventListener('click', async () => {
    const btn = $('#btn-preview-swap');
    btn.disabled = true;
    try{
      await Capture.previewSwitch();
      updateAlterneBadge();
    }catch(err){
      toast("Impossible de basculer de camera.");
    }finally{
      btn.disabled = false;
    }
  });

  $('#btn-mode-photo').addEventListener('click', () => {
    captureFormat = 'photo';
    $('#btn-mode-photo').classList.add('active');
    $('#btn-mode-video').classList.remove('active');
  });
  $('#btn-mode-video').addEventListener('click', () => {
    captureFormat = 'video';
    $('#btn-mode-video').classList.add('active');
    $('#btn-mode-photo').classList.remove('active');
  });

  $('#btn-shutter').addEventListener('click', async () => {
    if (captureFormat === 'photo'){
      await handlePhotoCapture();
    } else {
      await handleVideoToggle();
    }
  });

  async function handlePhotoCapture(){
    const shutter = $('#btn-shutter');
    shutter.disabled = true;
    try{
      const canvas = await Capture.capturePhoto();
      const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.92));
      if (Capture.mode === 'alterne') updateAlterneBadge();
      await openReview({ kind: 'photo', mediaBlob: blob, mediaCanvas: canvas });
    }catch(err){
      toast('La capture a echoue, reessaie.');
    }finally{
      shutter.disabled = false;
    }
  }

  async function handleVideoToggle(){
    const shutter = $('#btn-shutter');
    if (!recordingVideo){
      Capture.startVideoRecording();
      recordingVideo = true;
      shutter.classList.add('recording');
      toast('Enregistrement…', 1400);
    } else {
      shutter.classList.remove('recording');
      const blob = await Capture.stopVideoRecording();
      recordingVideo = false;
      if (blob) await openReview({ kind: 'video', mediaBlob: blob });
    }
  }

  /* ---------------- revue avant sauvegarde ---------------- */

  async function openReview({ kind, mediaBlob, mediaCanvas }){
    pendingSouvenir = {
      id: `sv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      kind,
      mediaBlob,
      captureMode: Capture.mode,
      lat: null, lng: null,
      mapImageBlob: null,
      tags: []
    };
    currentTags = [];
    renderTagChips();

    const wrap = $('#review-media-wrap');
    wrap.innerHTML = '';
    if (kind === 'photo'){
      const img = document.createElement('img');
      img.src = URL.createObjectURL(mediaBlob);
      wrap.appendChild(img);
    } else {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(mediaBlob);
      video.controls = true;
      video.playsInline = true;
      wrap.appendChild(video);
    }

    showView('review');
    resolveLocation();
    await refreshTagSuggestions();
  }

  async function resolveLocation(){
    const metaEl = $('#review-map-meta');
    const imgEl = $('#review-map-img');
    metaEl.textContent = 'Localisation…';
    imgEl.style.display = 'none';

    const pos = await MapModule.getPosition();
    if (!pos){
      metaEl.textContent = 'Lieu non disponible';
      return;
    }
    pendingSouvenir.lat = pos.lat;
    pendingSouvenir.lng = pos.lng;
    metaEl.textContent = `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`;

    const mosaic = await MapModule.fetchMapImage(pos.lat, pos.lng);
    const strip = MapModule.cropToStrip(mosaic);
    if (strip){
      const blob = await MapModule.canvasToBlob(strip);
      pendingSouvenir.mapImageBlob = blob;
      imgEl.src = URL.createObjectURL(blob);
      imgEl.style.display = 'block';
    }
  }

  /* ---------------- tags ---------------- */

  function renderTagChips(){
    const box = $('#tag-input-box');
    box.querySelectorAll('.tag-chip').forEach(c => c.remove());
    const input = $('#tag-input-field');
    currentTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML = `<span>${escapeHtml(tag)}</span>`;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Retirer ${tag}`);
      rm.innerHTML = '<svg class="icon" viewBox="0 0 24 24" style="width:13px;height:13px"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
      rm.addEventListener('click', () => {
        currentTags = currentTags.filter(t => t !== tag);
        renderTagChips();
      });
      chip.appendChild(rm);
      box.insertBefore(chip, input);
    });
  }

  function addTag(raw){
    const tag = raw.trim();
    if (!tag || currentTags.includes(tag)) return;
    currentTags.push(tag);
    renderTagChips();
  }

  $('#tag-input-field').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ','){
      e.preventDefault();
      addTag(e.target.value);
      e.target.value = '';
    }
  });

  async function refreshTagSuggestions(){
    const box = $('#tag-suggestions');
    box.innerHTML = '';
    const all = await Storage.allTags();
    all.filter(t => !currentTags.includes(t)).slice(0, 10).forEach(tag => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = tag;
      btn.addEventListener('click', () => {
        addTag(tag);
        refreshTagSuggestions();
      });
      box.appendChild(btn);
    });
  }

  function escapeHtml(s){
    return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /* ---------------- sauvegarde / suppression ---------------- */

  $('#btn-save').addEventListener('click', async () => {
    if (!pendingSouvenir) return;
    pendingSouvenir.tags = [...currentTags];
    await Storage.save(pendingSouvenir);
    toast('Souvenir garde.');
    pendingSouvenir = null;
    showView('capture');
  });

  $('#btn-discard').addEventListener('click', () => {
    pendingSouvenir = null;
    showView('capture');
  });

  $('#btn-review-back').addEventListener('click', () => {
    pendingSouvenir = null;
    showView('capture');
  });

  /* ---------------- galerie ---------------- */

  $('#btn-open-gallery').addEventListener('click', async () => {
    showView('gallery');
    await renderGallery();
  });
  $('#btn-gallery-back').addEventListener('click', () => showView('capture'));

  async function renderGallery(){
    const grid = $('#gallery-grid');
    const empty = $('#gallery-empty');
    const items = await Storage.getAll();
    grid.innerHTML = '';

    if (items.length === 0){
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';

    items.forEach(item => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'souvenir-card';
      card.setAttribute('aria-label', 'Ouvrir le souvenir');

      const media = item.kind === 'photo'
        ? Object.assign(document.createElement('img'), { src: URL.createObjectURL(item.mediaBlob) })
        : Object.assign(document.createElement('video'), { src: URL.createObjectURL(item.mediaBlob), muted: true });
      card.appendChild(media);

      const badge = document.createElement('span');
      badge.className = 'kind-badge';
      badge.innerHTML = item.kind === 'video'
        ? '<svg class="icon" viewBox="0 0 24 24" style="width:14px;height:14px"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>'
        : '<svg class="icon" viewBox="0 0 24 24" style="width:14px;height:14px"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>';
      card.appendChild(badge);

      const meta = document.createElement('span');
      meta.className = 'card-meta';
      const date = new Date(item.createdAt);
      meta.innerHTML = `<span class="date">${date.toLocaleDateString('fr-FR', { day:'2-digit', month:'short' })}</span>`;
      card.appendChild(meta);

      card.addEventListener('click', () => openDetail(item.id));
      grid.appendChild(card);
    });
  }

  /* ---------------- detail ---------------- */

  let currentDetailId = null;

  async function openDetail(id){
    const item = await Storage.getById(id);
    if (!item) return;
    currentDetailId = id;

    $('#detail-date').textContent = new Date(item.createdAt).toLocaleString('fr-FR', {
      day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const wrap = $('#detail-media-wrap');
    wrap.innerHTML = '';
    if (item.kind === 'photo'){
      const img = document.createElement('img');
      img.src = URL.createObjectURL(item.mediaBlob);
      wrap.appendChild(img);
    } else {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(item.mediaBlob);
      video.controls = true;
      video.playsInline = true;
      wrap.appendChild(video);
    }

    const mapStrip = $('#detail-map-strip');
    const mapImg = $('#detail-map-img');
    const mapMeta = $('#detail-map-meta');
    if (item.mapImageBlob){
      mapImg.src = URL.createObjectURL(item.mapImageBlob);
      mapStrip.style.display = 'block';
    } else {
      mapStrip.style.display = item.lat ? 'block' : 'none';
      mapImg.removeAttribute('src');
    }
    mapMeta.textContent = item.lat ? `${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}` : 'Lieu non disponible';

    const tagsBox = $('#detail-tags');
    tagsBox.innerHTML = '';
    (item.tags || []).forEach(tag => {
      const span = document.createElement('span');
      span.className = 'tag-chip';
      span.style.borderStyle = 'solid';
      span.textContent = tag;
      tagsBox.appendChild(span);
    });

    showView('detail');
  }

  $('#btn-detail-back').addEventListener('click', async () => {
    showView('gallery');
    await renderGallery();
  });

  $('#btn-detail-delete').addEventListener('click', async () => {
    if (!currentDetailId) return;
    await Storage.remove(currentDetailId);
    toast('Souvenir supprime.');
    showView('gallery');
    await renderGallery();
  });

  $('#btn-detail-share').addEventListener('click', async () => {
    const item = await Storage.getById(currentDetailId);
    if (!item) return;
    const ext = item.kind === 'photo' ? 'webp' : 'webm';
    const names = (item.tags || []).join(', ');
    const caption = names
      ? `Un souvenir avec ${names}, capture avec simul`
      : 'Un souvenir capture avec simul';
    await ShareModule.share(item.mediaBlob, `simul-souvenir.${ext}`, caption);
  });

  /* ---------------- PWA ---------------- */

  if ('serviceWorker' in navigator){
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  /* ---------------- boot ---------------- */

  initCapture();
})();
