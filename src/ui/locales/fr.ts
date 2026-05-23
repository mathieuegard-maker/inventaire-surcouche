// src/ui/locales/fr.ts

export const TEXTS = {
  app: {
    name: "Nom de l'application",
    description: "Description de l'application"
  },
  status: {
    initializing: "Chargement en cours...",
    offlineMode: "Mode hors-ligne actif"
  },
  onboarding: {
    title: "Bienvenue !",
    description: "Cette application est une surcouche optimisée et indépendante qui se connecte directement au service ouvert et citoyen Inventaire.io.",
    requirement: "Un compte sur Inventaire.io est indispensable pour pouvoir utiliser cette application et synchroniser vos livres.",
    actionLink: "Créer un compte sur Inventaire.io",
    actionClose: "J'ai compris"
  },
  login: {
    title: "Connexion",
    usernamePlaceholder: "Nom d'utilisateur",
    passwordPlaceholder: "Mot de passe",
    submitButton: "Se connecter",
    loading: "Connexion au serveur..."
  },
  scanner: {
    title: "Scanner le code-barres d'un livre",
    btnOpen: "📸 Scanner un livre",
    btnClose: "❌ Fermer le scanner",
    searching: "Analyse du code en cours...",
    errorPermission: "Impossible d'accéder à la caméra. Veuillez autoriser l'accès.",
    successDetected: "Recherche terminée",
    addInventorySuccess: "L'ouvrage a été ajouté à votre collection !",
    addWishlistSuccess: "L'ouvrage a été ajouté à votre liste d'envies !",
    errorGeneral: "Erreur lors du traitement de l'ouvrage.",
    errorQueue: "Erreur lors de la mise en file d'attente.",
    notFound: "Ouvrage introuvable sur les serveurs d'Inventaire.io."
  },
  pwa: {
    updateReady: "Une nouvelle version de l'application est disponible !",
    offlineReady: "L'application est prête à fonctionner hors-ligne.",
    btnReload: "Mettre à jour",
    btnClose: "Fermer"
  },
  bookCard: {
    owned: "Possédé",
    missing: "Absent",
    series: "Série",
    volume: "Tome",
    btnLend: "Prêter ce livre",
    btnReturn: "Livre rendu",
    btnAddInventory: "Ajouter à la collection",
    btnAddWishlist: "Ajouter à la liste d'envies",
    btnViewSeries: "Afficher toute la série",
    meta: {
      authors: "Auteur(s)",
      illustrators: "Dessinateur(s)",
      scriptwriters: "Scénariste(s)",
      publisher: "Éditeur",
      collection: "Collection",
      genres: "Genre(s)",
      publishDate: "Parution",
      pageCount: "Pages",
      language: "Langue",
      format: "Format"
    }
  },
  bookStatus: {
    owned: "Possédé",
    wish: "À avoir",
    lent: "Prêté",
    none: "Non possédé"
  },
  seriesView: {
    back: "Retour",
    selectedCount: "sélectionnés",
    btnReturnGroup: "Livre(s) rendu(s)",
    emptySelection: "Aucun tome sélectionné",
    loading: "Chargement des tomes...",
    mixedSelectionError: "Sélection mixte impossible : vous avez coché des tomes possédés et non possédés à la fois.",
    mixedSelectionAdvice: "Veuillez filtrer ou homogénéiser votre sélection pour appliquer une action groupée."
  },
  bookDetail: {
    missingId: "Identifiant du livre manquant.",
    cacheLog: "Non trouvé en cache, résolution réseau pour :",
    fetchError: "Impossible de récupérer les détails de cette édition.",
    loadError: "Une erreur est survenue lors de la récupération des données.",
    btnBack: "← Retour",
    btnSeries: "📚 Voir la saga",
    loadingSpec: "Chargement des spécifications de l'édition...",
    noCover: "Pas de couverture",
    synopsis: "Synopsis"
  },
  debugDbView: {
    title: "🛠 Laboratoire Local (Dexie DB)",
    placeholder: "Rechercher par titre, URI, wd:...",
    btnRefresh: "Rafraîchir",
    btnClear: "Vider le cache",
    loading: "Chargement de la base de données...",
    thCover: "Couverture",
    thTitle: "Titre",
    thSeries: "Série & N°",
    thEdition: "Édition (inv:)",
    thWork: "Œuvre (wd:)",
    totalInCache: "Total en cache :",
    clearConfirm: "Vider intégralement le cache local ?"
  },
  lendModal: {
  title: "📋 Prêter",
  instructionSingular: "Indiquez le nom de la personne à qui vous confiez cet exemplaire :",
  instructionPlural: "Indiquez le nom de la personne à qui vous confiez ces exemplaires :",
  placeholder: "Nom de l'emprunteur...",
  cancel: "Annuler",
  confirm: "Confirmer le prêt"
  },
  // À insérer à la racine de l'objet TEXTS :
collectionView: {
  title: "Ma Collection",
  modeBooks: "Tous les livres",
  modeSeries: "Mes Séries",
  modeOneShots: "Hors Série (One-Shots)",
  filterGenreLabel: "Filtrer par genre :",
  filterGenreAll: "Tous les genres",
  sortLabel: "Trier par :",
  sortByTitle: "Titre (A-Z)",
  sortByAuthor: "Premier auteur (A-Z)",
  sortByDate: "Derniers ajouts",
  emptyCollection: "Aucun ouvrage trouvé dans votre collection actuelle.",
  tomesOwned: "tome(s) possédé(s) dans la bibliothèque",
  noAuthor: "Auteur non spécifié"
},
// À insérer sous la clé "seriesView" ou à la racine de l'objet TEXTS :
batchActionBar: {
  selectedCount: "sélectionné(s)",
  emptySelection: "Aucun élément sélectionné",
  mixedSelectionError: "Sélection mixte impossible : vous cochez des éléments de statuts différents.",
  mixedSelectionAdvice: "Veuillez homogénéiser votre sélection pour appliquer une action groupée."
},
baseLoading: {
  message: "Chargement des données en cours..."
},
// À insérer à la racine de l'objet TEXTS :
wishlistView: {
  title: "Ma Wishlist",
  emptyWishlist: "Votre liste d'envies est actuellement vide.",
  filterAuthorLabel: "Filtrer par auteur :",
  filterAuthorAll: "Tous les auteurs",
  independentBooks: "Ouvrages indépendants",
  seriesSection: "Série : "
},
// À insérer à la racine de l'objet TEXTS :
loansView: {
  title: "Carnet de Prêts",
  modeBorrower: "Par Emprunteur",
  modeChronological: "Par Ancienneté",
  emptyLoans: "Aucun livre n'est actuellement confié à un proche.",
  borrowedCount: "livre(s) dehors",
  sinceLabel: "Prêté le :",
  friendLabel: "Emprunteur :"
}
};