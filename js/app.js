/* ==========================================================================
   simul — app.js
   Orchestrateur : navigation entre vues, capture, sauvegarde, galerie,
   carte des lieux, contacts, enregistrement dans la phototheque.
   ========================================================================== */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const views = {
    capture: $('#view-capture'),
    review:  $('#view-review'),
    gallery: $('#view-gallery'),
    detail:  $('#view-detail'),
  };

  let pendingSouvenir = null;
  let currentTags = [];
  let recordingVideo = false;
  let captureFormat = 'photo';
  let galleryMapMode = false;

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
    const pipCanvas = $('#pip-canvas');
    const videoMain = $('#video-main');

    Capture.onPipUpdate = (frameCanvas) => {
      pipCanvas.width = frameCanvas.width;
      pipCanvas.height = frameCanvas.height;
      pipCanvas.getContext('2d').drawImage(frameCanvas, 0, 0);
    };
    Capture.onPreviewFlicker = (isFlickering) => {
      videoMain.classList.toggle('updating', isFlickering);
    };

    try{
      const mode = await Capture.init(videoMain, $('#video-pip'));
      if (mode === 'simultane'){
        badge.textContent = 'Capture simultanee';
        badgeWrap.classList.remove('alt');
        swapBtn.style.display = 'none';
        pipCanvas.style.display = 'none';
      } else {
        badge.textContent = 'Arriere en direct · avant en PiP';
        badgeWrap.classList.add('alt');
        swapBtn.style.display = 'flex';
        pipCanvas.style.display = 'block';
      }
    }catch(err){
      badge.textContent = 'Camera indisponible';
      toast("Impossible d'acceder aux cameras. Verifie les autorisations.");
    }
  }

  $('#btn-preview-swap').addEventListener('click', async () => {
    const btn = $('#btn-preview-swap');
    btn.disabled = true;
    try{
      await Capture.refreshPipNow();
    }catch(err){
      toast("Impossible d'actualiser l'apercu.");
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
      const { back, front, composed } = await Capture.capturePhoto();
      const blob = await new Promise(r => composed.toBlob(r, 'image/webp', 0.92));
      await openReview({ kind: 'photo', mediaBlob: blob, backCanvas: back, frontCanvas: front });
    }catch(err){
      toast('La capture a echoue, reessaie.');
    }finally{
      shutter.disabled = false;
    }
  }

  async function handleVideoToggle(){
    const shutter = $('#btn-shutter');
    if (!recordingVideo){
      if (Capture.mode === 'alterne'){
        toast('Avant figee sur le dernier apercu pendant le clip', 2600);
      }
      shutter.classList.add('recording');
      shutter.disabled = true;
      await Capture.startVideoRecording();
      shutter.disabled = false;
      recordingVideo = true;
    } else {
      shutter.classList.remove('recording');
      const blob = await Capture.stopVideoRecording();
      recordingVideo = false;
      if (blob) await openReview({ kind: 'video', mediaBlob: blob });
    }
  }

  /* ---------------- revue avant sauvegarde ---------------- */

  async function openReview({ kind, mediaBlob, backCanvas, frontCanvas }){
    pendingSouvenir = {
      id: `sv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      kind,
      mediaBlob,
      captureMode: Capture.mode,
      lat: null, lng: null,
      tags: []
    };
    // canvas bruts gardes en memoire (pas persistes) pour la composition
    // finale complete une fois le lieu resolu — image finale unique, pas
    // de fichier intermediaire
    pendingSouvenir._rawBack = (kind === 'photo') ? backCanvas : null;
    pendingSouvenir._rawFront = (kind === 'photo') ? frontCanvas : null;
    currentTags = [];
    renderTagChips();

    $('#review-datetime').textContent = new Date(pendingSouvenir.createdAt).toLocaleString('fr-FR', {
      day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit'
    });

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
    await resolveLocation();
    await refreshTagSuggestions();

    // Enregistrement dans la phototheque : une seule image/video finale,
    // aucun fichier separe. Ouvre la feuille de partage native une fois
    // la carte fusionnee dans la photo (ou la localisation resolue pour
    // une video). Aucun navigateur ne permet d'ecrire silencieusement
    // dans la pellicule ; ceci est le plus proche possible, un seul tap
    // pour confirmer "Enregistrer".
    const ext = pendingSouvenir.kind === 'photo' ? 'webp' : 'webm';
    ShareModule.saveToLibrary([{ blob: pendingSouvenir.mediaBlob, name: `simul-souvenir.${ext}` }]).then(ok => {
      if (ok) toast('Enregistre dans ta phototheque.');
    });
  }

  async function resolveLocation(){
    const metaEl = $('#review-map-meta');
    const imgEl = $('#review-map-img');
    $('#review-map-strip').classList.remove('status-only');
    metaEl.textContent = 'Localisation…';
    imgEl.style.display = 'none';

    const pos = await MapModule.getPosition();
    if (!pos){
      metaEl.textContent = 'Lieu non disponible';
      return;
    }
    pendingSouvenir.lat = pos.lat;
    pendingSouvenir.lng = pos.lng;

    if (pendingSouvenir.kind === 'photo' && pendingSouvenir._rawBack){
      // composition finale complete : fond carte floutee, photo arriere
      // en grande carte inseree, PiP avant, bandeau carte nette + point
      // GPS — image unique, aucun fichier separe
      const canvas = pendingSouvenir._rawBack;
      const margin = canvas.width * 0.045;
      const mainW = canvas.width - margin * 2;
      const bandPad = mainW * 0.035;
      const bandW = mainW - bandPad * 2;
      const bandH = bandW * 0.42;

      const [bgMap, bandMap] = await Promise.all([
        MapModule.fetchCenteredImage(pos.lat, pos.lng, canvas.width * 1.15, canvas.height * 1.15, 15),
        MapModule.fetchCenteredImage(pos.lat, pos.lng, bandW, bandH, 17)
      ]);

      const finalCanvas = Capture.composeFinalLayout(
        pendingSouvenir._rawBack, pendingSouvenir._rawFront, bgMap, bandMap
      );
      const finalBlob = await new Promise(r => finalCanvas.toBlob(r, 'image/webp', 0.92));
      pendingSouvenir.mediaBlob = finalBlob;
      pendingSouvenir._rawBack = finalCanvas; // pour un rendu de secours si reappel

      const wrap = $('#review-media-wrap');
      wrap.innerHTML = '';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(finalBlob);
      wrap.appendChild(img);

      $('#review-map-strip').classList.add('status-only');
      metaEl.textContent = bandMap ? 'Lieu ajoute a la photo' : `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`;
      imgEl.style.display = 'none';
    } else {
      const mosaic = await MapModule.fetchMapImage(pos.lat, pos.lng, 18);
      if (!mosaic){
        metaEl.textContent = `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`;
        return;
      }
      // video : la carte n'est pas fusionnee dans le flux video (hors de
      // portee actuellement) — on affiche un simple aperçu de lieu
      const strip = MapModule.cropToStrip(mosaic);
      if (strip){
        const blob = await MapModule.canvasToBlob(strip);
        imgEl.src = URL.createObjectURL(blob);
        imgEl.style.display = 'block';
      }
      metaEl.textContent = `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`;
    }
  }

  /* ---------------- tags + contacts ---------------- */

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
      rm.innerHTML = '<svg class="icon" viewBox="0 0 24 24" style="width:12px;height:12px"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
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

  // Contact Picker API : disponible uniquement sur Chrome Android a ce
  // jour, jamais sur Safari iOS. On l'affiche seulement si le navigateur
  // la supporte reellement, plutot que de promettre une fonction qui ne
  // marcherait pas sur iPhone.
  const contactsBtn = $('#btn-pick-contacts');
  if ('contacts' in navigator && 'ContactsManager' in window){
    contactsBtn.style.display = 'flex';
    contactsBtn.addEventListener('click', async () => {
      try{
        const props = ['name'];
        const opts = { multiple: true };
        const contacts = await navigator.contacts.select(props, opts);
        contacts.forEach(c => {
          const name = (c.name && c.name[0]) || null;
          if (name) addTag(name);
        });
        refreshTagSuggestions();
      }catch(err){
        toast("Selection des contacts annulee ou indisponible.");
      }
    });
  }

  /* ---------------- sauvegarde / suppression ---------------- */

  $('#btn-save').addEventListener('click', async () => {
    if (!pendingSouvenir) return;
    pendingSouvenir.tags = [...currentTags];
    delete pendingSouvenir._rawBack;
    delete pendingSouvenir._rawFront;
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
    galleryMapMode = false;
    $('#gallery-grid').style.display = 'grid';
    $('#gallery-map').classList.remove('active');
    await renderGallery();
  });
  $('#btn-gallery-back').addEventListener('click', () => showView('capture'));

  $('#btn-toggle-map').addEventListener('click', async () => {
    galleryMapMode = !galleryMapMode;
    $('#gallery-grid').style.display = galleryMapMode ? 'none' : 'grid';
    $('#gallery-map').classList.toggle('active', galleryMapMode);
    if (galleryMapMode) await renderGalleryMap();
  });

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
        ? '<svg class="icon" viewBox="0 0 24 24"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>'
        : '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>';
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

  /* ---------------- carte des lieux ---------------- */

  function clusterByLocation(items){
    const clusters = [];
    items.filter(s => s.lat != null && s.lng != null).forEach(s => {
      let cluster = clusters.find(c => Math.abs(c.lat - s.lat) < 0.0015 && Math.abs(c.lng - s.lng) < 0.0015);
      if (!cluster){
        cluster = { lat: s.lat, lng: s.lng, items: [] };
        clusters.push(cluster);
      }
      cluster.items.push(s);
    });
    return clusters;
  }

  async function renderGalleryMap(){
    const mapEl = $('#gallery-map');
    const items = await Storage.getAll();
    const clusters = clusterByLocation(items);

    mapEl.innerHTML = '';
    if (!clusters.length){
      mapEl.innerHTML = '<div class="empty-state"><p>Aucun souvenir localise pour l\'instant.</p></div>';
      return;
    }

    const w = mapEl.clientWidth || 320;
    const h = mapEl.clientHeight || 400;
    const result = await MapModule.fetchBoundsImage(clusters, w, h);
    if (!result){
      mapEl.innerHTML = '<div class="empty-state"><p>Carte indisponible hors-ligne.</p></div>';
      return;
    }

    const img = document.createElement('img');
    img.src = result.canvas.toDataURL('image/webp', 0.85);
    mapEl.appendChild(img);

    clusters.forEach(cluster => {
      const pos = result.project(cluster.lat, cluster.lng);
      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'map-pin-btn';
      pinBtn.style.left = `${pos.x}px`;
      pinBtn.style.top = `${pos.y}px`;
      pinBtn.setAttribute('aria-label', `${cluster.items.length} souvenir(s) a ce lieu`);

      const representative = cluster.items[0];
      const thumbWrap = document.createElement('span');
      thumbWrap.className = 'pin-thumb';
      if (representative.kind === 'photo'){
        const im = document.createElement('img');
        im.src = URL.createObjectURL(representative.mediaBlob);
        thumbWrap.appendChild(im);
      } else {
        const vid = document.createElement('video');
        vid.src = URL.createObjectURL(representative.mediaBlob);
        vid.muted = true;
        thumbWrap.appendChild(vid);
      }
      pinBtn.appendChild(thumbWrap);

      if (cluster.items.length > 1){
        const count = document.createElement('span');
        count.className = 'pin-count';
        count.textContent = cluster.items.length;
        pinBtn.appendChild(count);
      }

      const tail = document.createElement('span');
      tail.className = 'pin-tail';
      pinBtn.appendChild(tail);

      pinBtn.addEventListener('click', () => openLocationSheet(cluster));
      mapEl.appendChild(pinBtn);
    });
  }

  /* ---------------- location sheet ---------------- */

  function openLocationSheet(cluster){
    const backdrop = $('#location-sheet-backdrop');
    const items = cluster.items.slice().sort((a, b) => b.createdAt - a.createdAt);
    const representative = items[0];

    const heroImg = $('#location-sheet-img');
    if (representative.kind === 'photo'){
      heroImg.src = URL.createObjectURL(representative.mediaBlob);
    } else {
      // pour une video, on affiche une image de la premiere frame via un
      // element video temporaire n'est pas trivial en agrandi ; on montre
      // la video elle-meme a la place de l'image.
      heroImg.style.display = 'none';
      const existingVid = $('#location-sheet-hero video');
      if (existingVid) existingVid.remove();
      const vid = document.createElement('video');
      vid.src = URL.createObjectURL(representative.mediaBlob);
      vid.controls = true;
      vid.playsInline = true;
      vid.style.width = '100%';
      vid.style.maxHeight = '200px';
      $('#location-sheet-hero').appendChild(vid);
    }
    if (representative.kind === 'photo') heroImg.style.display = 'block';

    const photoCount = items.filter(i => i.kind === 'photo').length;
    const videoCount = items.filter(i => i.kind === 'video').length;
    $('#location-sheet-coords').textContent = `${cluster.lat.toFixed(4)}, ${cluster.lng.toFixed(4)}`;
    const parts = [];
    if (photoCount) parts.push(`${photoCount} photo${photoCount > 1 ? 's' : ''}`);
    if (videoCount) parts.push(`${videoCount} video${videoCount > 1 ? 's' : ''}`);
    $('#location-sheet-count').textContent = parts.join(' · ');

    const grid = $('#location-mini-grid');
    grid.innerHTML = '';
    items.forEach(item => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'mini-item';
      const media = item.kind === 'photo'
        ? Object.assign(document.createElement('img'), { src: URL.createObjectURL(item.mediaBlob) })
        : Object.assign(document.createElement('video'), { src: URL.createObjectURL(item.mediaBlob), muted: true });
      cell.appendChild(media);
      cell.addEventListener('click', () => {
        closeLocationSheet();
        openDetail(item.id);
      });
      grid.appendChild(cell);
    });

    backdrop.classList.add('show');
  }

  function closeLocationSheet(){
    $('#location-sheet-backdrop').classList.remove('show');
    const existingVid = document.querySelector('#location-sheet-hero video');
    if (existingVid) existingVid.remove();
    $('#location-sheet-img').style.display = 'block';
  }

  $('#location-sheet-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLocationSheet();
  });

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
    if (item.kind === 'photo'){
      // la carte est deja fusionnee dans la photo elle-meme : le bandeau
      // separe ne sert plus qu'a acceder a la fiche du lieu
      mapStrip.style.display = item.lat != null ? 'block' : 'none';
      mapImg.removeAttribute('src');
      mapMeta.textContent = item.lat != null ? 'Carte integree · voir les autres souvenirs ici' : '';
    } else if (item.lat != null){
      mapStrip.style.display = 'block';
      mapMeta.textContent = `${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}`;
      MapModule.fetchMapImage(item.lat, item.lng).then(mosaic => {
        const strip = MapModule.cropToStrip(mosaic);
        if (strip) mapImg.src = strip.toDataURL('image/webp', 0.85);
      });
    } else {
      mapStrip.style.display = 'none';
    }

    mapStrip.onclick = async () => {
      if (item.lat == null) return;
      const all = await Storage.getAll();
      const clusters = clusterByLocation(all);
      const cluster = clusters.find(c => Math.abs(c.lat - item.lat) < 0.0015 && Math.abs(c.lng - item.lng) < 0.0015);
      if (cluster) openLocationSheet(cluster);
    };

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
    if (!galleryMapMode) await renderGallery();
    else await renderGalleryMap();
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
    await ShareModule.share([{ blob: item.mediaBlob, name: `simul-souvenir.${ext}` }], caption);
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
