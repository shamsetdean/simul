/* ==========================================================================
   simul — share.js
   Partage local uniquement : Web Share API (propose SMS parmi les options
   natives), avec repli sur un lien sms: si l'API est absente.
   Aucun serveur intermediaire. Supporte plusieurs fichiers a la fois
   (media + image de carte du lieu) pour que le contexte du souvenir
   voyage avec lui quand on le partage.
   ========================================================================== */

const ShareModule = {

  _toFiles(items){
    return items.map(({ blob, name }) => new File([blob], name, { type: blob.type }));
  },

  /**
   * Ouvre la feuille de partage native juste apres capture, ou
   * "Enregistrer l'image/la video" apparait comme option native —
   * le plus proche possible d'un enregistrement automatique dans la
   * phototheque, sans jamais l'ecrire silencieusement (aucun navigateur
   * ne l'autorise, question de confidentialite).
   * items : [{ blob, name }, ...] — media principal + carte du lieu si dispo.
   */
  async saveToLibrary(items){
    const files = this._toFiles(items);
    if (navigator.canShare && navigator.canShare({ files })){
      try{
        await navigator.share({ files });
        return true;
      }catch(err){
        return false;
      }
    }
    return false;
  },

  /** Partage via SMS (ou toute appli du systeme). items : [{blob,name}]. */
  async share(items, caption){
    const files = this._toFiles(items);
    if (navigator.canShare && navigator.canShare({ files })){
      try{
        await navigator.share({ files, text: caption || 'Un souvenir capture avec simul' });
        return true;
      }catch(err){
        if (err.name === 'AbortError') return false;
        return this._fallback(caption);
      }
    }
    return this._fallback(caption);
  },

  _fallback(caption){
    const body = encodeURIComponent(caption || 'Un souvenir capture avec simul');
    window.location.href = `sms:?body=${body}`;
    return true;
  }
};

window.ShareModule = ShareModule;
