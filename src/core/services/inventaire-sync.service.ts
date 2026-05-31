// src/core/services/inventaire-sync.service.ts
import { fetchWithTimeout } from '../../state/connection';
import { isbnUtil } from '../utils/isbn.util';
import type { HumanizedBook } from '../types';

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
   * Crée une entité de type spécifié sur inventaire.io.
   */
  async createEntity(type: 'serie' | 'work' | 'edition' | 'human', label: string, claims: Record<string, any>): Promise<string> {
    const body: Record<string, any> = {
      claims
    };
    
    // Les éditions ne peuvent pas avoir de label selon l'API d'Inventaire
    if (type !== 'edition' && label) {
      body.labels = {
        fr: label
      };
    }
    
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
  async syncBookToInventaire(book: HumanizedBook): Promise<{ editionUri: string; workUri: string; seriesUri?: string }> {
    console.log(`[INVENTAIRE SYNC] Démarrage de la synchronisation de l'édition : ${book.title}`);
    
    // 1. GESTION DE LA SÉRIE
    let seriesUri: string | undefined = undefined;
    if (book.series?.trim()) {
      console.log(`[INVENTAIRE SYNC] Recherche de la série : ${book.series}`);
      seriesUri = await this.searchEntity(book.series, 'series');
      
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
        console.log(`[INVENTAIRE SYNC] Recherche de l'auteur : ${authorName}`);
        let authorUri = await this.searchEntity(authorName, 'humans');
        
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
        'wdt:P407': [ 'wd:Q150' ] // Langue de l'œuvre (français)
      };
      if (isbn) {
        const formattedIsbn = isbn.length === 13 ? isbn : isbnUtil.toIsbn13(isbn);
        // Ajout avec tirets si possible ou brut
        editionClaims['wdt:P212'] = [ formattedIsbn ];
      }
      if (book.publishDate) {
        editionClaims['wdt:P577'] = [ book.publishDate ];
      }
      
      editionUri = await this.createEntity('edition', book.title, editionClaims);
      console.log(`[INVENTAIRE SYNC] Édition créée avec succès : ${editionUri}`);
    }
    
    return { editionUri, workUri, seriesUri };
  }
};
