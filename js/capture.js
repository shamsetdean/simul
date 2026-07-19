/* ==========================================================================
   simul — capture.js
   Tente une double capture simultanee (front + back). Si le navigateur/
   appareil ne le permet pas, bascule sur une capture rapide alternee
   (arriere puis avant, switch facingMode sur le meme flux).
   On ne pretend jamais un mode qui n'est pas reellement actif.
   ========================================================================== */

const Capture = {
  mode: null,          // 'simultane' | 'alterne'
  streamBack: null,
  streamFront: null,
  singleStream: null,
  recorder: null,
  recordedChunks: [],

  /**
   * Essaie d'ouvrir les deux cameras en parallele.
   * Retourne le mode reellement disponible.
   */
  async init(videoMainEl, videoPipEl){
    this.videoMain = videoMainEl;
    this.videoPip = videoPipEl;

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
      // Simultane indisponible (iOS Safari, ou un seul capteur exploitable)
      this._cleanupSimultane();
      return this._initAlterne();
    }
  },

  async _initAlterne(){
    this.videoPip.style.display = 'none';
    this.currentFacing = 'environment';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.currentFacing }, audio: true
    });
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
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.currentFacing }, audio: false
    });
    this.singleStream = stream;
    this.videoMain.srcObject = stream;
    await this.videoMain.play();
  },

  /**
   * Capture une photo composite (PiP) a partir de l'etat courant.
   * En mode alterne : prend l'arriere, bascule vers l'avant, reprend,
   * puis compose les deux images.
   */
  async capturePhoto(){
    if (this.mode === 'simultane'){
      const back = this._grabFrame(this.videoMain);
      const front = this._grabFrame(this.videoPip);
      return this._composePiP(back, front);
    }
    // mode alterne : deux instantanes rapides sur le meme flux
    const back = this._grabFrame(this.videoMain);
    await this._switchFacing();
    await new Promise(r => setTimeout(r, 180)); // laisser le capteur se stabiliser
    const front = this._grabFrame(this.videoMain);
    await this._switchFacing(); // revient a l'arriere pour l'ecran
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
