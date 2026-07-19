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

  /** Projection Web Mercator en pixels globaux (tuiles 256px) a un zoom donne. */
  _project(lat, lng, zoom){
    const scale = 256 * Math.pow(2, zoom);
    const x = (lng + 180) / 360 * scale;
    const rad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * scale;
    return { x, y };
  },

  /**
   * Compose une mosaique de tuiles ajustee a l'emprise (bbox) d'un ensemble
   * de points, aux dimensions cible exactes (pas de recadrage cote CSS).
   * Retourne { canvas, project(lat,lng) -> {x,y} en pixels dans ce canvas }.
   */
  async fetchBoundsImage(points, targetW, targetH, paddingRatio = 0.22){
    if (!navigator.onLine || !points.length) return null;
    try{
      let minLat = Math.min(...points.map(p => p.lat));
      let maxLat = Math.max(...points.map(p => p.lat));
      let minLng = Math.min(...points.map(p => p.lng));
      let maxLng = Math.max(...points.map(p => p.lng));
      if (minLat === maxLat){ minLat -= 0.004; maxLat += 0.004; }
      if (minLng === maxLng){ minLng -= 0.004; maxLng += 0.004; }
      const latPad = (maxLat - minLat) * paddingRatio;
      const lngPad = (maxLng - minLng) * paddingRatio;
      minLat -= latPad; maxLat += latPad; minLng -= lngPad; maxLng += lngPad;

      let zoom = 17;
      for (; zoom >= 2; zoom--){
        const tl = this._project(maxLat, minLng, zoom);
        const br = this._project(minLat, maxLng, zoom);
        if ((br.x - tl.x) <= targetW && (br.y - tl.y) <= targetH) break;
      }

      const centerLat = (minLat + maxLat) / 2;
      const centerLng = (minLng + maxLng) / 2;
      const centerPx = this._project(centerLat, centerLng, zoom);
      const originX = centerPx.x - targetW / 2;
      const originY = centerPx.y - targetH / 2;

      const canvas = document.createElement('canvas');
      canvas.width = targetW; canvas.height = targetH;
      const ctx = canvas.getContext('2d');

      const firstTileX = Math.floor(originX / 256);
      const firstTileY = Math.floor(originY / 256);
      const lastTileX = Math.floor((originX + targetW) / 256);
      const lastTileY = Math.floor((originY + targetH) / 256);

      const loads = [];
      for (let tx = firstTileX; tx <= lastTileX; tx++){
        for (let ty = firstTileY; ty <= lastTileY; ty++){
          const url = `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
          const dx = tx * 256 - originX;
          const dy = ty * 256 - originY;
          loads.push(this._loadTile(url).then(img => {
            if (img) ctx.drawImage(img, dx, dy, 256, 256);
          }));
        }
      }
      await Promise.all(loads);

      const project = (lat, lng) => {
        const p = this._project(lat, lng, zoom);
        return { x: p.x - originX, y: p.y - originY };
      };

      return { canvas, project, zoom };
    }catch(err){
      return null;
    }
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
