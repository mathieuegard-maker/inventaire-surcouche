// src/state/session.ts
export const sessionStore = {
  state: {
    user: null as { uri: string; username: string } | null,
  },
  
  setUser(data: any) {
    // Extraction de l'objet (parfois dans .user, parfois à la racine)
    const u = data.user || data;
    
    // LOG DE DÉBOGAGE : Affiche les clés disponibles dans la console du navigateur
    console.log('[DEBUG] Clés reçues de l’API :', Object.keys(u));
    console.log('[DEBUG] Objet complet :', u);

    // Recherche exhaustive de l'identifiant selon la doc [cite: 163, 263, 672]
    const finalUri = u.uri || u.id || u._id || u.acct || '';

    this.state.user = {
      uri: finalUri,
      username: u.username || u.label || u.name || 'Utilisateur',
    };
  },
  
  getUserUri() {
    return this.state.user?.uri;
  }
};