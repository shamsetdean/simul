/* ==========================================================================
   simul — capture.js
   Tente une double capture simultanee (front + back) sur les appareils qui
   le supportent. Sur iOS (jamais compatible avec deux flux camera actifs),
   on saute directement l'essai et on bascule sur une capture rapide
   alternee (arriere puis avant, switch facingMode sur le meme flux).
   On ne pretend jamais un mode qui n'est pas reellement actif.
   ========================================================================== */

const Capture = {
  mode: null,          // 'simultane' | 'alterne'
  streamBack: null,
  streamFront: null,
  singleStream: null,
  recorder: null,
  recordedChunks: [],

  isIOS(){
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  /**
   * Essaie d'ouvrir les deux cameras en parallele.
   * iOS Safari ne permet jamais deux flux camera actifs a la fois : on saute
   * directement l'essai simultane pour eviter de laisser la camera arriere
   * dans un etat bloque le temps qu'iOS la libere (source du bug ou la
   * camera arriere restait indisponible juste apres l'echec du simultane).
   */
  async init(videoMainEl, videoPipEl){
    this.videoMain = videoMainEl;
    this.videoPip = videoPipEl;

    if (this.isIOS()){
      return this._initAlterne();
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
      // Simultane indisponible (deux flux refuses, ou un seul capteur exploitable)
      this._cleanupSimultane();
      await this._releaseDelay();
      return this._initAlterne();
    }
  },

  /** Petite pause pour laisser le temps au systeme (surtout iOS) de
   *  liberer completement une camera avant d'en rouvrir une autre. */
  _releaseDelay(ms = 350){
    return new Promise(r => setTimeout(r, ms));
  },

  /**
   * Ouvre un flux camera unique, avec repli automatique si la combinaison
   * camera+micro echoue (certains appareils/permissions bloquent le tout
   * si le micro pose probleme, alors que la camera seule fonctionnerait).
   * Reessaie une fois apres un court delai en cas d'echec transitoire
   * (typique d'iOS qui met du temps a liberer une camera precedente).
   */
  async _openStream(facing, wantAudio = true, attempt = 1){
    try{
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing }, audio: wantAudio
      });
    }catch(err){
      if (wantAudio && (err.name === 'NotReadableError' || err.name === 'OverconstrainedError')){
        try{
          // repli sans micro : isole si le probleme vient de l'audio
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

  /** Bascule avant/arriere en mode alterne (utilise pour la capture rapide). */
  async _switchFacing(){
    if (!this.singleStream) return;
    this.singleStream.getTracks().forEach(t => t.stop());
    this.currentFacing = this.currentFacing === 'environment' ? 'user' : 'environment';
    await this._releaseDelay(120); // laisse iOS liberer la camera precedente
    const stream = await this._openStream(this.currentFacing, false);
    this.singleStream = stream;
    this.videoMain.srcObject = stream;
    await this.videoMain.play();
  },

  /** Bascule manuelle appelee depuis le bouton "voir l'autre camera",
   *  pour cadrer avant de declencher. Retourne la facing active apres bascule. */
  async previewSwitch(){
    await this._switchFacing();
    return this.currentFacing;
  },

  /**
   * Capture une photo composite (PiP) a partir de l'etat courant.
   * En mode alterne : capture la camera actuellement previsualisee (qui
   * peut etre l'avant si l'utilisateur a bascule manuellement avant de
   * declencher), bascule vers l'autre, reprend, recompose toujours avec
   * l'arriere en fond et l'avant en PiP, puis revient a l'arriere pour
   * l'ecran.
   */
  async capturePhoto(){
    if (this.mode === 'simultane'){
      const back = this._grabFrame(this.videoMain);
      const front = this._grabFrame(this.videoPip);
      return this._composePiP(back, front);
    }
    // mode alterne : deux instantanes rapides sur le meme flux
    const startedOnBack = this.currentFacing === 'environment';
    const firstFrame = this._grabFrame(this.videoMain);
    await this._switchFacing();
    await new Promise(r => setTimeout(r, 180)); // laisser le capteur se stabiliser
    const secondFrame = this._grabFrame(this.videoMain);

    const back = startedOnBack ? firstFrame : secondFrame;
    const front = startedOnBack ? secondFrame : firstFrame;

    if (this.currentFacing !== 'environment'){
      await this._switchFacing(); // revient toujours a l'arriere pour l'ecran
    }
    return this._composePiP(back, front);
  },

  _grabFrame(videoEl){
    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth || 720;
    c.height = videoEl.videoHeight || 960;
    c.getContext('2d').drawImage(videoEl, 0, 0, c.width, c.height);
    return c;
  },

  _composePiP(backCanvas, frontCanvas){
    const out = document.createElement('canvas');
    out.width = backCanvas.width;
    out.height = backCanvas.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(backCanvas, 0, 0);

    const pipW = out.width * 0.32;
    const pipH = pipW * (frontCanvas.height / frontCanvas.width);
    const pad = out.width * 0.03;
    const x = out.width - pipW - pad;
    const y = pad;
    const radius = 18;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + pipW, y, x + pipW, y + pipH, radius);
    ctx.arcTo(x + pipW, y + pipH, x, y + pipH, radius);
    ctx.arcTo(x, y + pipH, x, y, radius);
    ctx.arcTo(x, y, x + pipW, y, radius);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(frontCanvas, x, y, pipW, pipH);
    ctx.restore();

    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(238,234,247,.9)';
    ctx.stroke();

    return out; // <canvas>, a exporter en blob par l'appelant
  },

  /** Demarre l'enregistrement video du flux principal (mode alterne)
   *  ou d'un canvas compose en temps reel (mode simultane). */
  startVideoRecording(){
    this.recordedChunks = [];
    let streamToRecord;

    if (this.mode === 'simultane'){
      streamToRecord = this._composedLiveStream();
    } else {
      streamToRecord = this.singleStream;
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
        resolve(blob);
      };
      this.recorder.stop();
    });
  },

  /** Compose en direct back+PiP sur un canvas, capture le flux du canvas
   *  pour l'enregistrement video en mode simultane. */
  _composedLiveStream(){
    const canvas = document.createElement('canvas');
    canvas.width = this.videoMain.videoWidth || 720;
    canvas.height = this.videoMain.videoHeight || 960;
    this._composeCanvas = canvas;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      const back = this._grabFrame(this.videoMain);
      const front = this._grabFrame(this.videoPip);
      const composed = this._composePiP(back, front);
      ctx.drawImage(composed, 0, 0, canvas.width, canvas.height);
      this._composeRAF = requestAnimationFrame(draw);
    };
    draw();

    const canvasStream = canvas.captureStream(30);
    // on rattache l'audio du flux arriere s'il existe
    const audioTrack = this.streamBack && this.streamBack.getAudioTracks()[0];
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
