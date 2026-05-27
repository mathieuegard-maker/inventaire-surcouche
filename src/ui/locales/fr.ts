// src/ui/locales/fr.ts

export const TEXTS = {
  app: {
    name: "Inventaire PWA",
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
    usernameLabel: "Nom d'utilisateur / Mail",
    usernamePlaceholder: "Saisissez votre identifiant",
    passwordLabel: "Mot de passe",
    passwordPlaceholder: "Saisissez votre mot de passe",
    showPasswordLabel: "Afficher le mot de passe",
    noticeText: "Cette application n'est qu'une surcouche indépendante. Vous devez obligatoirement posséder un compte sur Inventaire.io pour pouvoir l'utiliser et synchroniser vos ouvrages.",
    noticeLink: "Visiter Inventaire.io",
    submitButton: "Se connecter",
    loading: "Connexion au serveur..."
  },
  scanner: {
    title: "Scanner le code-barres d'un livre",
    btnOpen: "Scanner un livre",
    btnClose: "Fermer le scanner",
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
    btnBack: "Retour",
    btnSeries: "Voir la saga",
    loadingSpec: "Chargement des spécifications de l'édition...",
    noCover: "Pas de couverture",
    synopsis: "Synopsis"
  },
  debugDbView: {
    title: "Laboratoire Local (Dexie DB)",
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
    title: "Prêter",
    instructionSingular: "Indiquez le nom de la personne à qui vous confiez cet exemplaire :",
    instructionPlural: "Indiquez le nom de la personne à qui vous confiez ces exemplaires :",
    placeholder: "Nom de l'emprunteur...",
    cancel: "Annuler",
    confirm: "Confirmer le prêt"
  },
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
  batchActionBar: {
    selectedCount: "sélectionné(s)",
    emptySelection: "Tout sélectionner", /* FIX : Message explicite pour guider l'utilisateur au repos */
    mixedSelectionError: "Sélection globale mixte impossible.",
    mixedSelectionAdvice: "La sélection doit être strictement homogène pour permettre des actions. Il ne peut pas y avoir plusieurs types d'états sélectionnés en même temps afin de garantir la cohérence des opérations.",
    btnReturnGroup: "Confirmer le Retour de Lot",
    btnAddInventoryGroup: "Ajouter le Lot à ma Collection",
    btnAddWishlistGroup: "Ajouter à ma Wishlist",
    btnLendGroup: "Prêter le Lot Sélectionné",
    btnToggleWishlistGroup: "Basculer vers la Wishlist"
  },
  baseLoading: {
    message: "Chargement des données en cours...",
    seriesHydration: "Découverte d'une nouvelle saga... Récupération de l'intégralité des tomes sur le serveur sémantique..."
  },
  wishlistView: {
    title: "Ma Wishlist",
    emptyWishlist: "Votre liste d'envies est actuellement vide.",
    filterAuthorLabel: "Filtrer par auteur :",
    filterAuthorAll: "Tous les auteurs",
    independentBooks: "Ouvrages indépendants",
    seriesSection: "Série : "
  },
  loansView: {
    title: "Carnet de Prêts",
    modeBorrower: "Par Emprunteur",
    modeChronological: "Par Ancienneté",
    emptyLoans: "Aucun livre n'est actuellement confié à un proche.",
    borrowedCount: "livre(s) dehors",
    sinceLabel: "Prêté le :",
    friendLabel: "Emprunteur :"
  },
  seriesProgress: {
    loadingTitle: "Téléchargement de la saga",
    statusLabel: "Statut :",
    pedagogicNotice: "Cette série n'a pas encore été consultée. Elle est en cours de rapatriement depuis le serveur sémantique. Une fois cette étape franchie, son affichage sera instantané pour tous vos prochains usages.",
    completeSuccess: "Téléchargement terminé."
  },
  searchBar: {
    placeholder: "ENTREZ UN ISBN OU DES MOTS-CLÉS",
    btnScanner: "SCANNER",
    btnFermer: "FERMER",
    btnSearch: "RECHERCHER"
  },
  searchResults: {
    title: "RÉSULTATS DE RECHERCHE",
    emptyResults: "AUCUN RÉSULTAT CORRESPONDANT À VOS MOTS-CLÉS SUR LES SERVEURS SÉMANTIQUES.",
    errorEmptyQuery: "LA REQUÊTE DE RECHERCHE EST VIDE.",
    errorFetch: "IMPOSSIBLE DE RÉCUPÉRER LES RÉSULTATS DEPUIS LE SERVEUR.",
    errorNoPhysicalEdition: "CETTE ŒUVRE EXISTE MAIS AUCUNE ÉDITION PHYSIQUE DISPOSANT D'UN ISBN VALIDE N'A PU ÊTRE TROUVÉE POUR LE PIVOT.",
    errorPivot: "ERREUR TECHNIQUE LORS DU CALCUL DU PIVOT SÉMANTIQUE VERS L'ISBN.",
    sectionSeries: "SAGAS & SÉRIES DÉTECTÉES",
    sectionAuthors: "AUTEURS & CRÉATEURS DÉTECTÉS",
    sectionWorks: "ALBUMS & ŒUVRES ISOLÉES",
    badgeSeries: "SAGA",
    badgeAuthor: "AUTR",
    badgeWork: "ALBM"
  },
  authorView: {
    title: "PROFIL AUTEUR",
    errorFetch: "IMPOSSIBLE DE CHARGER LES DONNÉES DE L'AUTEUR.",
    emptyWorks: "AUCUNE ŒUVRE TROUVÉE POUR CET AUTEUR.",
    sectionWorks: "ŒUVRES DE CET AUTEUR",
    badgeWork: "ALBM",
    unknownTitle: "TITRE INCONNU"
  },
  home: {
    title: "Inventaire PWA - Accueil"
  }
};