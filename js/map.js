/* ==========================================================================
   simul — map.js
   Recupere une tuile OSM statique pour ancrer le souvenir a un lieu.
   Aucune dependance (pas de Leaflet) : on dessine directement l'image
   de tuile sur un canvas. Fonctionne en degrade si hors-ligne :
   on garde alors juste les coordonnees, sans image.
   ========================================================================== */

const MapModule = {

  async getPosition(){
    if (!('geolocation' in navigator)) return null;
    try{
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 60000
        });
      });
      return { lat: pos.coords.latitude, lng: pos.coords.longitude };
    }catch(err){
      return null; // permission refusee ou indisponible : souvenir "sans lieu"
    }
  },

  _lonToTileX(lon, zoom){
    return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
  },
  _latToTileY(lat, zoom){
    const rad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, zoom));
  },

  /** Construit une mosaique 3x3 de tuiles centree sur lat/lng pour avoir
   *  une image de fond assez large, puis la recadre. */
  async fetchMapImage(lat, lng, zoom = 15){
    if (!navigator.onLine) return null;
    try{
      const size = 256;
      const cx = this._lonToTileX(lng, zoom);
      const cy = this._latToTileY(lat, zoom);
      const canvas = document.createElement('canvas');
      canvas.width = size * 3;
      canvas.height = size * 3;
      const ctx = canvas.getContext('2d');

      const loads = [];
      for (let dx = -1; dx <= 1; dx++){
        for (let dy = -1; dy <= 1; dy++){
          const x = cx + dx, y = cy + dy;
          const url = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
          loads.push(this._loadTile(url).then(img => {
            if (img) ctx.drawImage(img, (dx + 1) * size, (dy + 1) * size, size, size);
          }));
        }
      }
      await Promise.all(loads);
      return canvas;
    }catch(err){
      return null;
    }
  },

  _loadTile(url){
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  },

  /** Recadre la mosaique en bande large + assombrie/floutee pour servir
   *  de fond discret derriere le composite photo/video. */
  cropToStrip(mosaicCanvas, outW = 600, outH = 200){
    if (!mosaicCanvas) return null;
    const out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const ctx = out.getContext('2d');
    const sx = (mosaicCanvas.width - outW) / 2;
    const sy = (mosaicCanvas.height - outH) / 2;
    ctx.drawImage(mosaicCanvas, sx, sy, outW, outH, 0, 0, outW, outH);
    ctx.fillStyle = 'rgba(14,15,26,.35)';
    ctx.fillRect(0, 0, outW, outH);
    return out;
  },

  canvasToBlob(canvas, type = 'image/webp', quality = 0.85){
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
  }
};

window.MapModule = MapModule;
