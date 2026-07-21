/* ==========================================================================
   simul — capture.js
   Tente une double capture simultanee (front + back) sur les appareils qui
   le supportent. Sur iOS (jamais compatible avec deux flux camera actifs
   en meme temps — limitation materielle/logicielle de la plateforme, pas
   contournable en web), on bascule en mode alterne :
     - la camera principale (arriere) reste en direct en permanence
     - un petit PiP est rempli une fois au demarrage, puis actualisable
       manuellement (bouton), via une bascule furtive (switch, capture,
       retour).
   IMPORTANT : pas de bascule automatique en boucle. iOS met du temps a
   liberer une camera ; enchainer les bascules en continu (teste plus tot
   avec un minuteur toutes les 3s) finit par bloquer le sous-systeme
   camera et casse l'aperçu entierement. Chaque bascule est donc une
   action ponctuelle, jamais un cycle perpetuel.
   ========================================================================== */

const Capture = {
  mode: null,          // 'simultane' | 'alterne'
  streamBack: null,
  streamFront: null,
  singleStream: null,
  recorder: null,
  recordedChunks: [],
  currentFacing: null,
  pipFrame: null,       // <canvas> : derniere capture de l'autre camera (mode alterne)
  onPipUpdate: null,    // callback(canvas, facing) fourni par l'appelant
  onPreviewFlicker: null, // callback(bool) : vrai pendant une bascule furtive
  _pipBusy: false,
  _recording: false,

  isIOS(){
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  async init(videoMainEl, videoPipEl){
    this.videoMain = videoMainEl;
    this.videoPip = videoPipEl;

    if (this.isIOS()){
      const mode = await this._initAlterne();
      // un seul remplissage initial du PiP, pas de cycle automatique
      setTimeout(() => this._refreshPipOnce(), 900);
      return mode;
    }

    try{
      const [back, front] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: 'environment' } }, audio: true
        }),
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: 'user' } }, audio: false
        })
      ]);
      this.streamBack = back;
      this.streamFront = front;
      this.videoMain.srcObject = back;
      this.videoPip.srcObject = front;
      this.videoPip.style.display = 'block';
      await Promise.all([this.videoMain.play(), this.videoPip.play()]);
      this.mode = 'simultane';
      return this.mode;
    }catch(err){
      this._cleanupSimultane();
      await this._releaseDelay();
      const mode = await this._initAlterne();
      setTimeout(() => this._refreshPipOnce(), 900);
      return mode;
    }
  },

  _releaseDelay(ms = 350){
    return new Promise(r => setTimeout(r, ms));
  },

  async _openStream(facing, wantAudio = true, attempt = 1){
    try{
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing }, audio: wantAudio
      });
    }catch(err){
      if (wantAudio && (err.name === 'NotReadableError' || err.name === 'OverconstrainedError')){
        try{
          return await navigator.mediaDevices.getUserMedia({
            video: { facingMode: facing }, audio: false
          });
        }catch(err2){
          if (attempt < 2){
            await this._releaseDelay(500);
            return this._openStream(facing, wantAudio, attempt + 1);
          }
          throw err2;
        }
      }
      if (attempt < 2){
        await this._releaseDelay(500);
        return this._openStream(facing, wantAudio, attempt + 1);
      }
      throw err;
    }
  },

  async _initAlterne(){
    this.videoPip.style.display = 'none';
    this.currentFacing = 'environment';
    const stream = await this._openStream(this.currentFacing, true);
    this.singleStream = stream;
    this.videoMain.srcObject = stream;
    await this.videoMain.play();
    this.mode = 'alterne';
    return this.mode;
  },

  _cleanupSimultane(){
    [this.streamBack, this.streamFront].forEach(s => {
      if (s) s.getTracks().forEach(t => t.stop());
    });
    this.streamBack = null;
    this.streamFront = null;
  },

  /**
   * Bascule avant/arriere sur le flux unique (mode alterne).
   * Robuste : si la reouverture de l'autre camera echoue, on revient
   * explicitement sur la camera precedente plutot que de laisser
   * l'apercu sans aucun flux.
   */
  async _switchFacing(){
    if (!this.singleStream) return;
    const previousFacing = this.currentFacing;
    const previousStream = this.singleStream;
    previousStream.getTracks().forEach(t => t.stop());
    const nextFacing = previousFacing === 'environment' ? 'user' : 'environment';
    await this._releaseDelay(300);

    try{
      const stream = await this._openStream(nextFacing, false);
      this.currentFacing = nextFacing;
      this.singleStream = stream;
      this.videoMain.srcObject = stream;
      await this.videoMain.play();
    }catch(err){
      // echec d'ouverture de l'autre camera : on retente de revenir sur
      // la camera precedente pour ne jamais rester sans aucun flux
      await this._releaseDelay(300);
      const fallback = await this._openStream(previousFacing, false);
      this.currentFacing = previousFacing;
      this.singleStream = fallback;
      this.videoMain.srcObject = fallback;
      await this.videoMain.play();
      throw err;
    }
  },

  /** Actualise le PiP une fois (bouton manuel, ou premier remplissage). */
  async refreshPipNow(){
    return this._refreshPipOnce();
  },

  async _refreshPipOnce(){
    if (this.mode !== 'alterne' || this._pipBusy || this._recording) return;
    this._pipBusy = true;
    if (this.onPreviewFlicker) this.onPreviewFlicker(true);
    try{
      await this._switchFacing();
      await new Promise(r => setTimeout(r, 180));
      const frame = this._grabFrame(this.videoMain);
      this.pipFrame = frame;
      if (this.onPipUpdate) this.onPipUpdate(frame, this.currentFacing);
      await this._switchFacing();
    }catch(err){
      console.warn('simul: actualisation PiP echouee', err);
    }finally{
      if (this.onPreviewFlicker) this.onPreviewFlicker(false);
      this._pipBusy = false;
    }
  },

  /**
   * Capture une photo a partir de l'etat courant. Retourne les canvas
   * bruts (back/front) en plus d'un composite interimaire simple (utilise
   * pour l'affichage immediat en revue, avant que la carte soit prete —
   * la composition finale complete se fait ensuite via composeFinalLayout).
   * En mode alterne : capture precisement les deux cameras au moment du
   * declenchement, independamment du PiP affiche a l'ecran.
   */
  async capturePhoto(){
    if (this.mode === 'simultane'){
      const back = this._grabFrame(this.videoMain);
      const front = this._grabFrame(this.videoPip);
      return { back, front, composed: this._composePiP(back, front) };
    }

    const startedOnBack = this.currentFacing === 'environment';
    const firstFrame = this._grabFrame(this.videoMain);
    await this._switchFacing();
    await new Promise(r => setTimeout(r, 180));
    const secondFrame = this._grabFrame(this.videoMain);

    const back = startedOnBack ? firstFrame : secondFrame;
    const front = startedOnBack ? secondFrame : firstFrame;

    this.pipFrame = front;
    if (this.onPipUpdate) this.onPipUpdate(front, 'user');

    if (this.currentFacing !== 'environment'){
      await this._switchFacing();
    }
    return { back, front, composed: this._composePiP(back, front) };
  },

  /** Dessine une image en mode "cover" dans un rectangle donne, recadree
   *  au centre si les proportions ne correspondent pas exactement. */
  _drawCover(ctx, img, x, y, w, h){
    const scale = Math.max(w / img.width, h / img.height);
    const sw = w / scale;
    const sh = h / scale;
    const sx = (img.width - sw) / 2;
    const sy = (img.height - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  },

  /** Fond plein cadre : carte floutee, legerement assombrie pour que le
   *  premier plan ressorte. Surdimensionnee pour eviter toute frange
   *  transparente due au flou sur les bords. */
  _drawBlurredMapBackground(ctx, canvas, mapCanvas){
    const overscan = canvas.width * 0.06;
    ctx.save();
    ctx.filter = `blur(${Math.round(canvas.width * 0.026)}px)`;
    this._drawCover(ctx, mapCanvas, -overscan, -overscan, canvas.width + overscan * 2, canvas.height + overscan * 2);
    ctx.restore();
    ctx.fillStyle = 'rgba(8,8,12,.22)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  },

  /**
   * Composition finale complete, hierarchie :
   *  1. Fond : carte floutee plein cadre
   *  2. Premier plan : photo arriere, en grande carte arrondie inseree
   *     (pas plein bord — la carte floutee reste visible en bordure)
   *  3. Haut-droite : photo avant en incrustation, sans contour
   *  4. Bas : bandeau carte nette, pleine largeur de la carte principale,
   *     avec point GPS exact
   * Retourne un nouveau canvas — image unique, aucun fichier separe.
   */
  composeFinalLayout(backCanvas, frontCanvas, bgMapCanvas, bandMapCanvas){
    const out = document.createElement('canvas');
    out.width = backCanvas.width;
    out.height = backCanvas.height;
    const ctx = out.getContext('2d');

    // 1. fond
    if (bgMapCanvas){
      this._drawBlurredMapBackground(ctx, out, bgMapCanvas);
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, out.width, out.height);
    }

    // 2. carte principale (photo arriere), inseree avec marge
    const margin = out.width * 0.045;
    const mainX = margin, mainY = margin;
    const mainW = out.width - margin * 2;
    const mainH = out.height - margin * 2;
    const mainRadius = out.width * 0.06;

    this._drawRoundedShadow(ctx, mainX, mainY, mainW, mainH, mainRadius, out.width * 1.4);
    ctx.save();
    this._roundedRectPath(ctx, mainX, mainY, mainW, mainH, mainRadius);
    ctx.clip();
    this._drawCover(ctx, backCanvas, mainX, mainY, mainW, mainH);
    ctx.restore();

    // 3. PiP avant, haut-droite de la carte principale, sans contour
    if (frontCanvas){
      const pipW = mainW * 0.32;
      const pipH = pipW * (frontCanvas.height / frontCanvas.width);
      const pipPad = mainW * 0.035;
      const px = mainX + mainW - pipW - pipPad;
      const py = mainY + pipPad;
      const pipRadius = out.width * 0.028;

      this._drawRoundedShadow(ctx, px, py, pipW, pipH, pipRadius, out.width);
      ctx.save();
      this._roundedRectPath(ctx, px, py, pipW, pipH, pipRadius);
      ctx.clip();
      this._drawCover(ctx, frontCanvas, px, py, pipW, pipH);
      ctx.restore();
    }

    // 4. bandeau carte nette, bas de la carte principale, pleine largeur
    if (bandMapCanvas){
      const bandPad = mainW * 0.035;
      const bandW = mainW - bandPad * 2;
      const bandH = bandMapCanvas.height * (bandW / bandMapCanvas.width);
      const bx = mainX + bandPad;
      const by = mainY + mainH - bandH - bandPad;
      const bandRadius = out.width * 0.028;

      this._drawRoundedShadow(ctx, bx, by, bandW, bandH, bandRadius, out.width);
      ctx.save();
      this._roundedRectPath(ctx, bx, by, bandW, bandH, bandRadius);
      ctx.clip();
      this._drawCover(ctx, bandMapCanvas, bx, by, bandW, bandH);
      ctx.restore();

      const cx = bx + bandW / 2;
      const cy = by + bandH / 2;

      ctx.beginPath();
      ctx.arc(cx, cy, bandW * 0.028, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(47,111,237,.22)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, bandW * 0.013, 0, Math.PI * 2);
      ctx.fillStyle = '#2f6fed';
      ctx.fill();
      ctx.lineWidth = bandW * 0.005;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.stroke();
    }

    return out;
  },

  _grabFrame(videoEl){
    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth || 720;
    c.height = videoEl.videoHeight || 960;
    c.getContext('2d').drawImage(videoEl, 0, 0, c.width, c.height);
    return c;
  },

  _roundedRectPath(ctx, x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },

  /** Ombre douce sous une forme arrondie — delimite sans tracer de trait.
   *  Necessaire quand avant/arriere se ressemblent (ex. un seul capteur
   *  disponible en test desktop) : sans elle, l'incrustation peut devenir
   *  invisible a l'oeil si le contenu est proche. */
  _drawRoundedShadow(ctx, x, y, w, h, r, scale){
    ctx.save();
    ctx.shadowColor = 'rgba(15,15,20,.32)';
    ctx.shadowBlur = scale * 0.022;
    ctx.shadowOffsetY = scale * 0.006;
    ctx.fillStyle = '#000';
    this._roundedRectPath(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.restore();
  },

  /** Photo avant incrustee, sans contour trace — juste une ombre douce
   *  pour la detacher proprement du fond. */
  _drawPipOverlay(ctx, canvas, frontCanvas){
    const pipW = canvas.width * 0.32;
    const pipH = pipW * (frontCanvas.height / frontCanvas.width);
    const pad = canvas.width * 0.035;
    const x = canvas.width - pipW - pad;
    const y = pad;
    const radius = canvas.width * 0.028;

    this._drawRoundedShadow(ctx, x, y, pipW, pipH, radius, canvas.width);

    ctx.save();
    this._roundedRectPath(ctx, x, y, pipW, pipH, radius);
    ctx.clip();
    ctx.drawImage(frontCanvas, x, y, pipW, pipH);
    ctx.restore();
  },

  _composePiP(backCanvas, frontCanvas){
    const out = document.createElement('canvas');
    out.width = backCanvas.width;
    out.height = backCanvas.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(backCanvas, 0, 0);
    this._drawPipOverlay(ctx, out, frontCanvas);
    return out;
  },

  /* ---------------- video ---------------- */

  async startVideoRecording(){
    this.recordedChunks = [];
    let streamToRecord;

    if (this.mode === 'simultane'){
      streamToRecord = this._composedLiveStream();
    } else {
      // garantit qu'il y a bien quelque chose a incruster : si le premier
      // remplissage automatique n'a pas encore eu le temps de se terminer
      // (enregistrement lance tres vite apres l'ouverture de l'app), on
      // force une capture avant de commencer, sinon la video n'aurait
      // que l'arriere, sans aucune trace de l'avant.
      if (!this.pipFrame){
        try{ await this._refreshPipOnce(); }catch(err){ /* on tente quand meme */ }
      }
      this._recording = true;
      streamToRecord = this._composedAlterneLiveStream();
    }

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    this.recorder = new MediaRecorder(streamToRecord, { mimeType: mime });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.recorder.start();
  },

  stopVideoRecording(){
    return new Promise((resolve) => {
      if (!this.recorder){ resolve(null); return; }
      this.recorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        if (this._composeCanvas) cancelAnimationFrame(this._composeRAF);
        this._recording = false;
        resolve(blob);
      };
      this.recorder.stop();
    });
  },

  /** Mode simultane : compose en direct back+PiP front (les deux flux
   *  sont reellement live, tous les deux ouverts en parallele). */
  _composedLiveStream(){
    const canvas = document.createElement('canvas');
    canvas.width = this.videoMain.videoWidth || 720;
    canvas.height = this.videoMain.videoHeight || 960;
    this._composeCanvas = canvas;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      ctx.drawImage(this.videoMain, 0, 0, canvas.width, canvas.height);
      const frontFrame = this._grabFrame(this.videoPip);
      this._drawPipOverlay(ctx, canvas, frontFrame);
      this._composeRAF = requestAnimationFrame(draw);
    };
    draw();

    const canvasStream = canvas.captureStream(30);
    const audioTrack = this.streamBack && this.streamBack.getAudioTracks()[0];
    if (audioTrack) canvasStream.addTrack(audioTrack);
    return canvasStream;
  },

  /** Mode alterne : la camera arriere reste live pendant tout
   *  l'enregistrement (jamais interrompue), et le dernier PiP avant
   *  connu (fige au moment ou l'enregistrement demarre) est incruste
   *  en continu. iOS ne permet pas d'avoir les deux cameras ouvertes
   *  en parallele, donc impossible de faire mieux en web sur iPhone. */
  _composedAlterneLiveStream(){
    const canvas = document.createElement('canvas');
    canvas.width = this.videoMain.videoWidth || 720;
    canvas.height = this.videoMain.videoHeight || 960;
    this._composeCanvas = canvas;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      ctx.drawImage(this.videoMain, 0, 0, canvas.width, canvas.height);
      if (this.pipFrame){
        this._drawPipOverlay(ctx, canvas, this.pipFrame);
      }
      this._composeRAF = requestAnimationFrame(draw);
    };
    draw();

    const canvasStream = canvas.captureStream(30);
    const audioTrack = this.singleStream && this.singleStream.getAudioTracks()[0];
    if (audioTrack) canvasStream.addTrack(audioTrack);
    return canvasStream;
  },

  stopAll(){
    [this.streamBack, this.streamFront, this.singleStream].forEach(s => {
      if (s) s.getTracks().forEach(t => t.stop());
    });
  }
};

window.Capture = Capture;
