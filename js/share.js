/* ==========================================================================
   simul — share.js
   Partage local uniquement : Web Share API (propose SMS parmi les options
   natives), avec repli sur un lien sms: si l'API est absente.
   Aucun serveur intermediaire.
   ========================================================================== */

const ShareModule = {

  /**
   * Ouvre la feuille de partage native juste apres capture, ou
   * "Enregistrer l'image/la video" apparait comme option native —
   * le plus proche possible d'un enregistrement automatique dans la
   * phototheque, sans jamais l'ecrire silencieusement (aucun navigateur
   * ne l'autorise, question de confidentialite).
   */
  async saveToLibrary(blob, filename){
    if (navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] })){
      try{
        await navigator.share({ files: [new File([blob], filename, { type: blob.type })] });
        return true;
      }catch(err){
        return false; // annule ou indisponible : le bouton manuel du detail reste disponible
      }
    }
    return false;
  },

  async share(blob, filename, caption){
    if (navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] })){
      try{
        await navigator.share({
          files: [new File([blob], filename, { type: blob.type })],
          text: caption || 'Un souvenir capture avec simul'
        });
        return true;
      }catch(err){
        if (err.name === 'AbortError') return false; // annule par l'utilisateur
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
