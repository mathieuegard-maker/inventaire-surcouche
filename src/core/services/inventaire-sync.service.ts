// src/core/services/inventaire-sync.service.ts
import { fetchWithTimeout } from '../../state/connection';
import { isbnUtil } from '../utils/isbn.util';
import type { HumanizedBook } from '../types';
import { getLevenshteinDistance } from '../utils/string.util';
import { databaseService } from '../database/database.service';

export const inventaireSyncService = {
  /**
   * Effectue une recherche textuelle sur inventaire.io pour trouver une entité correspondante par label et type.
   */
  async searchEntity(query: string, type: 'series' | 'works' | 'humans'): Promise<string | null> {
    try {
      const res = await fetchWithTimeout(`/api/gateway?action=search-text&q=${encodeURIComponent(query)}`);
      if (!res.ok) return null;
      const data = await res.json();
      
      const results = data.results || [];
      // On cherche un match exact (insensible à la casse) du label
      const match = results.find((r: any) => 
        r.type === type && r.label?.toLowerCase().trim() === query.toLowerCase().trim()
      );
      
      return match ? match.uri : null;
    } catch (e) {
      console.warn(`[INVENTAIRE SYNC] Erreur lors de la recherche de ${query} (${type}) :`, e);
      return null;
    }
  },

  /**
   * Crée une entité de type spécifié sur inventaire.io / D1.
   */
  async createEntity(
    type: 'serie' | 'work' | 'edition' | 'human',
    label: string,
    claims: Record<string, any>,
    extras?: {
      publisher?: string;
      genres?: string[];
      descriptions?: Record<string, string>;
    }
  ): Promise<string> {
    const body: Record<string, any> = {
      claims
    };
    
    // Les éditions ne peuvent pas avoir de label selon l'API d'Inventaire
    if (type !== 'edition' && label) {
      body.labels = {
        fr: label
      };
    }
    if (extras?.publisher) body.publisher = extras.publisher;
    if (Array.isArray(extras?.genres) && extras.genres.length > 0) {
      body.genres = extras.genres;
    }
    if (extras?.descriptions) body.descriptions = extras.descriptions;
    
    const res = await fetchWithTimeout('/api/gateway?action=entities-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Erreur lors de la création de l'entité ${type} (${label}) : ${text}`);
    }
    
    const data = await res.json();
    const uri = data.entity?.uri || data.uri;
    if (!uri) throw new Error(`URI manquante dans la réponse de création pour ${label}`);
    
    return uri;
  },

  /**
   * Synchronise un livre local vers inventaire.io en créant les entités dépendantes.
   * Retourne un objet contenant les identifiants créés ou résolus.
   */
  async syncBookToInventaire(
    book: HumanizedBook,
    chosenSeriesUri?: string,
    chosenAuthorUris?: Record<string, string>
  ): Promise<{ editionUri: string; workUri: string; seriesUri?: string }> {
    console.log(`[INVENTAIRE SYNC] Démarrage de la synchronisation de l'édition : ${book.title}`);
    
    // 1. GESTION DE LA SÉRIE
    let seriesUri = chosenSeriesUri;
    if (book.series?.trim() && !seriesUri) {
      console.log(`[INVENTAIRE SYNC] Recherche de la série : ${book.series}`);
      const searchRes = await this.searchEntity(book.series, 'series');
      seriesUri = searchRes || undefined;
      
      if (!seriesUri) {
        console.log(`[INVENTAIRE SYNC] Série non trouvée, création de la série : ${book.series}`);
        seriesUri = await this.createEntity('serie', book.series, {
          'wdt:P31': [ 'wd:Q14406742' ] // Instance de série de livres
        });
        console.log(`[INVENTAIRE SYNC] Série créée avec succès : ${seriesUri}`);
      } else {
        console.log(`[INVENTAIRE SYNC] Série existante trouvée : ${seriesUri}`);
      }
    }
    
    // 2. GESTION DES AUTEURS
    const authorUris: string[] = [];
    if (book.authors && book.authors.length > 0) {
      for (const authorName of book.authors) {
        if (!authorName.trim()) continue;
        
        let authorUri = chosenAuthorUris?.[authorName];
        if (!authorUri) {
          console.log(`[INVENTAIRE SYNC] Recherche de l'auteur : ${authorName}`);
          authorUri = await this.searchEntity(authorName, 'humans') || undefined;
        }
        
        if (!authorUri) {
          console.log(`[INVENTAIRE SYNC] Auteur non trouvé, création de l'entité humaine : ${authorName}`);
          authorUri = await this.createEntity('human', authorName, {
            'wdt:P31': [ 'wd:Q5' ] // Instance de humain
          });
          console.log(`[INVENTAIRE SYNC] Auteur créé : ${authorUri}`);
        } else {
          console.log(`[INVENTAIRE SYNC] Auteur existant trouvé : ${authorUri}`);
        }
        authorUris.push(authorUri);
      }
    }
    
    // 3. GESTION DE L'ŒUVRE (WORK)
    let workUri: string | undefined = undefined;
    console.log(`[INVENTAIRE SYNC] Recherche de l'œuvre : ${book.title}`);
    const candidateWorkUri = await this.searchEntity(book.title, 'works');
    if (candidateWorkUri) {
      try {
        const detailsRes = await fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(candidateWorkUri)}`);
        if (detailsRes.ok) {
          const details = await detailsRes.json();
          const entity = details.entities?.[candidateWorkUri];
          const workSeries = entity?.claims?.['wdt:P179']?.[0];
          
          if (!seriesUri || workSeries === seriesUri) {
            workUri = candidateWorkUri;
            console.log(`[INVENTAIRE SYNC] Œuvre existante valide trouvée : ${workUri}`);
          }
        }
      } catch (err) {
        console.warn(`[INVENTAIRE SYNC] Impossible de vérifier les claims de l'œuvre candidate :`, err);
      }
    }
    
    if (!workUri) {
      console.log(`[INVENTAIRE SYNC] Œuvre non trouvée, création de l'œuvre : ${book.title}`);
      const workClaims: Record<string, any> = {
        'wdt:P31': [ 'wd:Q47461344' ] // Instance d'œuvre littéraire
      };
      if (seriesUri) {
        workClaims['wdt:P179'] = [ seriesUri ];
        if (book.seriesNumber) {
          workClaims['wdt:P1545'] = [ book.seriesNumber ];
        }
      }
      if (authorUris.length > 0) {
        workClaims['wdt:P50'] = authorUris;
      }
      
      workUri = await this.createEntity('work', book.title, workClaims);
      console.log(`[INVENTAIRE SYNC] Œuvre créée : ${workUri}`);
    }
    
    // 4. CRÉATION DE L'ÉDITION
    const isbn = book.isbn13 || book.isbn10 || '';
    let editionUri: string | undefined = undefined;
    if (isbn) {
      try {
        const res = await fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent('isbn:' + isbn)}`);
        if (res.ok) {
          const data = await res.json();
          const redirect = data.redirects?.['isbn:' + isbn];
          if (redirect) {
            editionUri = redirect;
            console.log(`[INVENTAIRE SYNC] Édition existante trouvée sur inventaire.io via ISBN : ${editionUri}`);
          }
        }
      } catch (e) {
        console.warn(`[INVENTAIRE SYNC] Erreur lors de la vérification de l'ISBN d'édition :`, e);
      }
    }
    
    if (!editionUri) {
      console.log(`[INVENTAIRE SYNC] Création de l'édition : ${book.title}`);
      const editionClaims: Record<string, any> = {
        'wdt:P31': [ 'wd:Q3331189' ], // Instance d'édition de livre
        'wdt:P629': [ workUri ], // Édition de (l'œuvre)
        'wdt:P407': [ 'wd:Q150' ], // Langue de l'œuvre (français)
        'wdt:P1476': [ book.title ] // Titre (wdt:P1476) obligatoire pour une édition
      };
      if (isbn) {
        const formattedIsbn = isbn.length === 13 ? isbn : isbnUtil.toIsbn13(isbn);
        // Ajout avec tirets si possible ou brut
        editionClaims['wdt:P212'] = [ formattedIsbn ];
      }
      if (book.publishDate) {
        editionClaims['wdt:P577'] = [ book.publishDate ];
      }
      if (book.pageCount && Number.isFinite(book.pageCount)) {
        editionClaims['wdt:P1104'] = [ book.pageCount ];
      }
      if (book.coverUrl && !book.coverUrl.startsWith('data:')) {
        editionClaims['invp:P2'] = [ book.coverUrl ];
      }
      
      editionUri = await this.createEntity('edition', book.title, editionClaims, {
        publisher: book.publisher,
        genres: book.genres,
        descriptions: book.description ? { fr: book.description } : undefined
      });
      console.log(`[INVENTAIRE SYNC] Édition créée avec succès : ${editionUri}`);
    }
    
    return { editionUri, workUri, seriesUri };
  },

  /**
   * Met à jour une claim (propriété) d'une entité via le Gateway.
   */
  async updateClaim(uri: string, property: string, oldValue: any, newValue: any): Promise<void> {
    const res = await fetchWithTimeout('/api/gateway?action=entities-update-claim', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uri,
        property,
        'old-value': oldValue,
        'new-value': newValue
      })
    });
    if (!res.ok) {
      const text = await res.text();
      if (text.includes('already exist') || text.includes('already exists')) {
        console.log(`[INVENTAIRE SYNC] La valeur pour la propriété ${property} de ${uri} existe déjà sur le serveur. Erreur 400 ignorée.`);
        return;
      }
      throw new Error(`Erreur lors de la mise à jour de la propriété ${property} pour ${uri} : ${text}`);
    }
  },

  /**
   * Met à jour le label d'une entité via le Gateway.
   */
  async updateLabel(uri: string, lang: string, value: string): Promise<void> {
    const res = await fetchWithTimeout('/api/gateway?action=entities-update-label', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uri,
        lang,
        value
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Erreur lors de la mise à jour du label (${lang}) pour ${uri} : ${text}`);
    }
  },

  /**
   * Recherche des séries existantes proches sémantiquement du nom fourni.
   */
  async findSimilarSeries(seriesName: string): Promise<Array<{ name: string; uri: string; distance: number }>> {
    const normalizedTarget = seriesName.toLowerCase().trim();
    if (!normalizedTarget) return [];

    const candidates = new Map<string, string>(); // seriesId -> seriesName

    // 1. Recherche dans le cache local
    try {
      const localBooks = await databaseService.getAllCachedBooks();
      for (const book of localBooks) {
        if (book.series?.trim() && book.seriesId?.trim()) {
          candidates.set(book.seriesId.trim(), book.series.trim());
        }
      }
    } catch (e) {
      console.warn('[INVENTAIRE SYNC] Erreur lors du chargement des séries locales :', e);
    }

    // 2. Recherche en ligne
    try {
      const res = await fetchWithTimeout(`/api/gateway?action=search-text&q=${encodeURIComponent(seriesName)}`);
      if (res.ok) {
        const data = await res.json();
        const results = data.results || [];
        for (const r of results) {
          if (r.type === 'series' && r.label?.trim() && r.uri?.trim()) {
            const uri = r.uri.trim();
            const label = r.label.trim();
            const existing = candidates.get(uri);
            if (!existing) {
              candidates.set(uri, label);
            } else {
              const distNew = getLevenshteinDistance(normalizedTarget, label.toLowerCase());
              const distOld = getLevenshteinDistance(normalizedTarget, existing.toLowerCase());
              if (distNew < distOld) {
                candidates.set(uri, label);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[INVENTAIRE SYNC] Erreur lors de la recherche en ligne de la série :', e);
    }

    // 3. Filtrage par distance de Levenshtein
    const matches: Array<{ name: string; uri: string; distance: number }> = [];
    for (const [uri, name] of candidates.entries()) {
      const normalizedName = name.toLowerCase().trim();
      
      // Exclure le match exact de la recherche floue
      if (normalizedName === normalizedTarget) {
        continue;
      }
      
      const dist = getLevenshteinDistance(normalizedTarget, normalizedName);
      if (dist <= 4) {
        matches.push({ name, uri, distance: dist });
      }
    }

    return matches.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  },

  /**
   * Recherche des auteurs existants proches sémantiquement du nom fourni.
   */
  async findSimilarAuthors(authorName: string): Promise<Array<{ name: string; uri: string; distance: number }>> {
    const normalizedTarget = authorName.toLowerCase().trim();
    if (!normalizedTarget) return [];

    const candidates = new Map<string, string>(); // authorId -> authorName

    // Recherche en ligne
    try {
      const res = await fetchWithTimeout(`/api/gateway?action=search-text&q=${encodeURIComponent(authorName)}`);
      if (res.ok) {
        const data = await res.json();
        const results = data.results || [];
        for (const r of results) {
          if (r.type === 'humans' && r.label?.trim() && r.uri?.trim()) {
            const uri = r.uri.trim();
            const label = r.label.trim();
            const existing = candidates.get(uri);
            if (!existing) {
              candidates.set(uri, label);
            } else {
              const distNew = getLevenshteinDistance(normalizedTarget, label.toLowerCase());
              const distOld = getLevenshteinDistance(normalizedTarget, existing.toLowerCase());
              if (distNew < distOld) {
                candidates.set(uri, label);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[INVENTAIRE SYNC] Erreur lors de la recherche en ligne de l\'auteur :', e);
    }

    // Filtrage par distance de Levenshtein
    const matches: Array<{ name: string; uri: string; distance: number }> = [];
    for (const [uri, name] of candidates.entries()) {
      const normalizedName = name.toLowerCase().trim();
      
      // Exclure le match exact de la recherche floue
      if (normalizedName === normalizedTarget) {
        continue;
      }
      
      const dist = getLevenshteinDistance(normalizedTarget, normalizedName);
      if (dist <= 4) {
        matches.push({ name, uri, distance: dist });
      }
    }

    return matches.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  },

  /**
   * Résout une série par son nom ou la crée si absente.
   */
  async resolveOrCreateSeries(seriesName: string): Promise<string> {
    const trimmed = seriesName.trim();
    if (!trimmed) return '';
    const searchRes = await this.searchEntity(trimmed, 'series');
    if (searchRes) return searchRes;
    
    return await this.createEntity('serie', trimmed, {
      'wdt:P31': [ 'wd:Q14406742' ] // Instance de série de livres
    });
  },

  /**
   * Résout un auteur par son nom ou le crée si absent.
   */
  async resolveOrCreateAuthor(authorName: string): Promise<string> {
    const trimmed = authorName.trim();
    if (!trimmed) return '';
    const searchRes = await this.searchEntity(trimmed, 'humans');
    if (searchRes) return searchRes;
    
    return await this.createEntity('human', trimmed, {
      'wdt:P31': [ 'wd:Q5' ] // Instance de humain
    });
  },

  /**
   * Effectue les modifications sémantiques ordonnées en cascade sur inventaire.io.
   */
  async patchBookOnInventaire(
    originalBook: HumanizedBook,
    updatedData: {
      title: string;
      authors: string[];
      series: string;
      seriesNumber: string;
      publisher: string;
      publishDate: string;
      pageCount?: number;
      coverUrl: string;
      genres?: string[];
    },
    chosenSeriesUri?: string,
    chosenAuthorUris?: Record<string, string>
  ): Promise<{ editionUri: string; workUri: string; seriesUri?: string }> {
    const editionUri = originalBook.uri;
    let workUri = originalBook.workUri || '';

    // 1. Gérer la série
    let seriesUri = chosenSeriesUri;
    if (updatedData.series.trim() && !seriesUri) {
      seriesUri = await this.resolveOrCreateSeries(updatedData.series);
    }

    // 2. Gérer les auteurs (résolution/création d'URIs)
    const newAuthorUris: string[] = [];
    for (const author of updatedData.authors) {
      if (!author.trim()) continue;
      let aUri = chosenAuthorUris?.[author];
      if (!aUri) {
        aUri = await this.resolveOrCreateAuthor(author);
      }
      if (aUri) newAuthorUris.push(aUri);
    }

    // 3. Déterminer si le Work doit être cloné (si Wikidata ou absent)
    const isWorkWikidataOrAbsent = !workUri || workUri.startsWith('wd:');
    let finalWorkUri = workUri;

    if (isWorkWikidataOrAbsent) {
      console.log(`[INVENTAIRE SYNC] Le Work d'origine est Wikidata ou absent (${workUri}). Clonage en local...`);
      const workClaims: Record<string, any> = {
        'wdt:P31': [ 'wd:Q47461344' ]
      };
      if (seriesUri) {
        workClaims['wdt:P179'] = [ seriesUri ];
        if (updatedData.seriesNumber) {
          workClaims['wdt:P1545'] = [ updatedData.seriesNumber ];
        }
      }
      if (newAuthorUris.length > 0) {
        workClaims['wdt:P50'] = newAuthorUris;
      }

      finalWorkUri = await this.createEntity('work', updatedData.title, workClaims);
      console.log(`[INVENTAIRE SYNC] Nouveau Work local créé : ${finalWorkUri}`);

      // Lier l'édition à ce nouveau Work
      await this.updateClaim(editionUri, 'wdt:P629', workUri || undefined, finalWorkUri);
      console.log(`[INVENTAIRE SYNC] Édition ${editionUri} liée au nouveau Work local ${finalWorkUri}`);
    } else {
      console.log(`[INVENTAIRE SYNC] Le Work d'origine est local (${workUri}). Mise à jour des claims...`);
      
      // A. Titre (Label)
      if (originalBook.title !== updatedData.title) {
        await this.updateLabel(workUri, 'fr', updatedData.title);
      }

      // B. Série (wdt:P179)
      const oldSeriesUri = originalBook.seriesId || undefined;
      if (oldSeriesUri !== seriesUri) {
        await this.updateClaim(workUri, 'wdt:P179', oldSeriesUri, seriesUri || undefined);
      }

      // C. Numéro de tome (wdt:P1545)
      const oldSeriesNumber = originalBook.seriesNumber || undefined;
      const newSeriesNumber = updatedData.seriesNumber || undefined;
      if (oldSeriesNumber !== newSeriesNumber) {
        await this.updateClaim(workUri, 'wdt:P1545', oldSeriesNumber, newSeriesNumber);
      }

      // D. Auteurs (wdt:P50)
      let oldAuthorUris: string[] = [];
      try {
        const detailsRes = await fetchWithTimeout(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(workUri)}`);
        if (detailsRes.ok) {
          const details = await detailsRes.json();
          const entity = details.entities?.[workUri];
          oldAuthorUris = entity?.claims?.['wdt:P50'] || [];
        }
      } catch (err) {
        console.warn(`[INVENTAIRE SYNC] Impossible de récupérer les claims d'origine du Work :`, err);
      }

      // Supprimer les auteurs obsolètes
      for (const oldA of oldAuthorUris) {
        if (!newAuthorUris.includes(oldA)) {
          await this.updateClaim(workUri, 'wdt:P50', oldA, undefined);
        }
      }
      // Ajouter les nouveaux auteurs
      for (const newA of newAuthorUris) {
        if (!oldAuthorUris.includes(newA)) {
          await this.updateClaim(workUri, 'wdt:P50', undefined, newA);
        }
      }
    }

    // 4. Mettre à jour l'édition elle-même (Date de publication wdt:P577)
    const oldPublishDate = originalBook.publishDate || undefined;
    const newPublishDate = updatedData.publishDate || undefined;
    if (oldPublishDate !== newPublishDate) {
      await this.updateClaim(editionUri, 'wdt:P577', oldPublishDate, newPublishDate);
    }

    // 4b. Synchronisation complète de l'édition (éditeur, pages, couverture, série/numéro) sur D1
    const hasEditionMetaChanged =
      (updatedData.publisher || '') !== (originalBook.publisher || '') ||
      (updatedData.pageCount ?? null) !== (originalBook.pageCount ?? null) ||
      (updatedData.coverUrl || '') !== (originalBook.coverUrl || '') ||
      (updatedData.series || '') !== (originalBook.series || '') ||
      (updatedData.seriesNumber || '') !== (originalBook.seriesNumber || '') ||
      updatedData.title !== originalBook.title ||
      updatedData.authors.join('|') !== (originalBook.authors || []).join('|');

    if (hasEditionMetaChanged) {
      try {
        await fetchWithTimeout('/api/gateway?action=entities-patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            editionUri,
            workUri: finalWorkUri,
            title: updatedData.title,
            seriesUri: seriesUri || '',
            seriesNumber: updatedData.seriesNumber || '',
            authorUris: newAuthorUris,
            publisher: updatedData.publisher || '',
            publishDate: updatedData.publishDate || '',
            pageCount: updatedData.pageCount ?? null,
            coverUrl: updatedData.coverUrl || ''
          })
        });
      } catch (err) {
        console.warn('[INVENTAIRE SYNC] Échec entities-patch :', err);
      }
    }

    // 5. Mettre à jour les genres multiples si modifiés (propagé à toute la série côté D1)
    if (Array.isArray(updatedData.genres)) {
      const oldGenres = (originalBook.genres || []).join('|');
      const newGenres = updatedData.genres.join('|');
      if (oldGenres !== newGenres) {
        try {
          await fetchWithTimeout('/api/gateway?action=entities-update-genres', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              uri: editionUri,
              workUri: finalWorkUri,
              seriesUri: seriesUri || undefined,
              propagateSeries: Boolean(seriesUri || updatedData.series),
              genres: updatedData.genres
            })
          });
        } catch (err) {
          console.warn('[INVENTAIRE SYNC] Échec mise à jour genres :', err);
        }
      }
    }

    return { editionUri, workUri: finalWorkUri, seriesUri };
  }
};
