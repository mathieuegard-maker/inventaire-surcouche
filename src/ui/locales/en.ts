// src/ui/locales/en.ts

export const TEXTS = {
  app: {
    name: "Inventaire PWA",
    description: "Application description",
    offlineGlobalBanner: "OFFLINE MODE ACTIVE (READ-ONLY)"
  },
  status: {
    initializing: "Loading...",
    offlineMode: "Offline mode active"
  },
  onboarding: {
    title: "Welcome!",
    description: "This application is an optimized and independent wrapper that connects directly to the open, citizen-led Inventaire.io service.",
    requirement: "An account on Inventaire.io is required to use this application and sync your books.",
    actionLink: "Create an account on Inventaire.io",
    actionClose: "I understand"
  },
  login: {
    title: "Login",
    usernameLabel: "Username / Email",
    usernamePlaceholder: "Enter your username",
    passwordLabel: "Password",
    passwordPlaceholder: "Enter your password",
    showPasswordLabel: "Show password",
    noticeText: "This application is only an independent wrapper. You must have an account on Inventaire.io to use it and sync your books.",
    noticeLink: "Visit Inventaire.io",
    submitButton: "Log in",
    loading: "Connecting to server...",
    errorInvalid: "Invalid credentials or unknown account.",
    errorServer: "Unable to reach the synchronization server."
  },
  scanner: {
    title: "Scan a book barcode",
    btnOpen: "Scan a book",
    btnClose: "Close scanner",
    searching: "Analyzing code...",
    errorPermission: "Unable to access the camera. Please authorize access.",
    successDetected: "Search completed",
    addInventorySuccess: "The book has been added to your collection!",
    addWishlistSuccess: "The book has been added to your wishlist!",
    errorGeneral: "Error processing the book.",
    errorQueue: "Error queuing the action.",
    notFound: "Book not found on Inventaire.io servers."
  },
  pwa: {
    updateReady: "A new version of the app is available!",
    offlineReady: "The application is ready to work offline.",
    btnReload: "Update",
    btnClose: "Close"
  },
  bookCard: {
    owned: "Owned",
    missing: "Missing",
    series: "Series",
    volume: "Volume",
    btnLend: "Lend this book",
    btnReturn: "Book returned",
    btnAddInventory: "Add to collection",
    btnAddWishlist: "Add to wishlist",
    btnViewSeries: "Show entire series",
    offlineActionsBlocked: "Modification not possible in offline mode.",
    meta: {
      authors: "Author(s)",
      illustrators: "Illustrator(s)",
      scriptwriters: "Writer(s)",
      publisher: "Publisher",
      collection: "Collection",
      genres: "Genre(s)",
      publishDate: "Published",
      pageCount: "Pages",
      language: "Language",
      format: "Format"
    }
  },
  bookStatus: {
    owned: "Owned",
    wish: "To get",
    lent: "Lent",
    none: "Not owned"
  },
  seriesView: {
    back: "Back",
    selectedCount: "selected",
    btnReturnGroup: "Book(s) returned",
    emptySelection: "No volumes selected",
    loading: "Loading volumes...",
    mixedSelectionError: "Mixed selection impossible: you have selected both owned and unowned volumes.",
    mixedSelectionAdvice: "Please filter or make your selection uniform to perform a batch action."
  },
  bookDetail: {
    missingId: "Missing book identifier.",
    cacheLog: "Not found in cache, network resolution for:",
    fetchError: "Unable to retrieve this edition's details.",
    loadError: "An error occurred while retrieving data.",
    btnBack: "Back",
    btnSeries: "View saga",
    loadingSpec: "Loading edition specifications...",
    noCover: "No cover",
    synopsis: "Synopsis"
  },
  debugDbView: {
    title: "Local Lab (Dexie DB)",
    placeholder: "Search by title, URI, wd:...",
    btnRefresh: "Refresh",
    btnClear: "Clear cache",
    loading: "Loading database...",
    thCover: "Cover",
    thTitle: "Title",
    thSeries: "Series & No.",
    thEdition: "Edition (inv:)",
    thWork: "Work (wd:)",
    totalInCache: "Total in cache:",
    clearConfirm: "Completely clear local cache?"
  },
  lendModal: {
    title: "Lend",
    instructionSingular: "Enter the name of the person you are lending this copy to:",
    instructionPlural: "Enter the name of the person you are lending these copies to:",
    placeholder: "Borrower name...",
    cancel: "Cancel",
    confirm: "Confirm loan"
  },
  collectionView: {
    title: "My Collection",
    modeBooks: "All Books",
    modeSeries: "My Series",
    modeOneShots: "One-Shots (Standalone)",
    filterGenreLabel: "Filter by genre:",
    filterGenreAll: "All genres",
    sortLabel: "Sort by:",
    sortByTitle: "Title (A-Z)",
    sortByAuthor: "First author (A-Z)",
    sortByDate: "Recently added",
    emptyCollection: "No books found in your current collection.",
    tomesOwned: "volume(s) owned in library",
    noAuthor: "Author not specified"
  },
  batchActionBar: {
    selectedCount: "selected",
    emptySelection: "Select all",
    mixedSelectionError: "Mixed global selection impossible.",
    mixedSelectionAdvice: "The selection must be strictly uniform to perform actions. You cannot select multiple state types at the same time to ensure operation consistency.",
    btnReturnGroup: "Confirm Batch Return",
    btnAddInventoryGroup: "Add Batch to Collection",
    btnAddWishlistGroup: "Add to Wishlist",
    btnLendGroup: "Lend Selected Batch",
    btnToggleWishlistGroup: "Toggle to Wishlist",
    offlineActionsBlocked: "Batch actions are disabled in offline mode."
  },
  baseLoading: {
    message: "Loading data...",
    seriesHydration: "Discovering a new saga... Retrieving all volumes from the semantic server..."
  },
  wishlistView: {
    title: "My Wishlist",
    emptyWishlist: "Your wishlist is currently empty.",
    filterAuthorLabel: "Filter by author:",
    filterAuthorAll: "All authors",
    independentBooks: "Standalone books",
    seriesSection: "Series: "
  },
  loansView: {
    title: "Loan Tracker",
    modeBorrower: "By Borrower",
    modeChronological: "By Date",
    emptyLoans: "No books are currently lent to anyone.",
    borrowedCount: "book(s) out",
    sinceLabel: "Lent on:",
    friendLabel: "Borrower:",
    unknownFriend: "Unknown",
    unknownFriendWeb: "Unknown (Web add)",
    unknownFriendRestored: "Unknown (Restored)"
  },
  seriesProgress: {
    loadingTitle: "Downloading saga",
    statusLabel: "Status:",
    pedagogicNotice: "This series has not been loaded yet. It is being downloaded from the semantic server. Once complete, it will load instantly for all future visits.",
    completeSuccess: "Download completed."
  },
  searchBar: {
    placeholder: "ENTER AN ISBN OR KEYWORDS",
    btnScanner: "SCAN",
    btnFermer: "CLOSE",
    btnSearch: "SEARCH"
  },
  searchResults: {
    title: "SEARCH RESULTS",
    emptyResults: "NO RESULTS MATCHING YOUR KEYWORDS ON SEMANTIC SERVERS.",
    errorEmptyQuery: "SEARCH QUERY IS EMPTY.",
    errorFetch: "UNABLE TO FETCH RESULTS FROM SERVER.",
    errorNoPhysicalEdition: "THIS WORK EXISTS BUT NO PHYSICAL EDITION WITH A VALID ISBN COULD BE FOUND.",
    errorPivot: "TECHNICAL ERROR WHILE RESOLVING SEMANTIC PIVOT TO ISBN.",
    sectionSeries: "DETECTED SAGAS & SERIES",
    sectionAuthors: "DETECTED AUTHORS & CREATORS",
    sectionWorks: "DETECTED ALBUMS & STANDALONE WORKS",
    badgeSeries: "SAGA",
    badgeAuthor: "AUTH",
    badgeWork: "ALBM"
  },
  authorView: {
    title: "AUTHOR PROFILE",
    errorFetch: "UNABLE TO LOAD AUTHOR DATA.",
    emptyWorks: "NO WORKS FOUND FOR THIS AUTHOR.",
    sectionWorks: "WORKS BY THIS AUTHOR",
    badgeWork: "ALBM",
    unknownTitle: "UNKNOWN TITLE"
  },
  home: {
    title: "Inventaire PWA - Home"
  },
  header: {
    back: "BACK",
    collection: "COLLECTION",
    wishlist: "WISHLIST",
    loans: "LOANS",
    home: "HOME",
    menu: "MENU",
    closeMenu: "CLOSE MENU"
  },
  pagination: {
    placeholder: "Search for an album or series (e.g., Asterix)...",
    selectAll: "Select all",
    selectedCount: "selected",
    perPage: "per page",
    previous: "PREVIOUS",
    page: "PAGE",
    next: "NEXT"
  }
};
