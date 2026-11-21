// src/core/utils/editorial-collection.util.ts
// Détection partagée des collections éditoriales génériques (poches, maisons d'édition, labels de collection)
// qui ne doivent jamais être élues en tant que Série narrative ni fournir leur n° de collection comme tome.

const PAPERBACK_AND_PUBLISHER_COLLECTION_RE =
  /^(?:(?:la\s+)?collection\s+|editions?\s+|éditions?\s+)?(?:folio(?:\s+bd|\s+cadets|\s+junior|\s+sf|\s+policier|\s+2\s*euros|\s+essai|\s+classique|\s+histoire|\s+actuel|\s+plus)?|livre\s+de\s+poche(?:\s+jeunesse)?|le\s+livre\s+de\s+poche(?:\s+jeunesse)?|pocket(?:\s+bd|\s+classiques?|\s+terreur|\s+sf|\s+jeunesse)?|j['’]?\s*ai\s+lu(?:\s+poche|\s+bien[- ]être|\s+nouvel\s+mill[ée]naire|\s+science[- ]fiction|\s+aventure|\s+policier)?|10\/18|10\s*18|points(?:\s+seuil|\s+signatures?|\s+poche|\s+po[ée]sie)?|babel(?:\s+noir)?|actes\s+sud(?:\s+babel)?|librio|libretto|rivages(?:\s+poche|\s+noir)?|m[ée]t[ée]ores|un\s+endroit\s+o[ùu]\s+aller|milan\s+poche(?:\s+cadet|\s+junior|\s+benjamin)?|zo[ée]\s+poche|picquier\s+poche|motifs|la\s+pl[ée]iade|biblioth[èe]que\s+de\s+la\s+pl[ée]iade|bouquins|omnibus|le\s+masque|s[ée]rie\s+noire|flammarion|gallimard(?:\s+jeunesse)?|fayard|seuil|grasset|albin\s+michel|calmann[- ]l[ée]vy|marabout|harlequin|milady|bragelonne|dupuis|dargaud|le\s+lombard|gl[ée]nat|delcourt|soleil|casterman|hachette|rombaldi|france\s+loisirs|aire\s+libre|long\s+courrier|sign[ée]|rep[ée]rages|troisi[èe]me\s+vague|poisson\s+pilote|poche)$/i;

function normalizeEditorialText(raw: string): string {
  return (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’".,:;!?()\[\]/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Détecte les noms de collections éditoriales génériques (ex: "Folio", "J'ai lu", "Librio", "Rivages poche")
 * qui ne doivent jamais être élues en tant que Série narrative ni fournir leur n° de collection comme tome.
 */
export function isEditorialPaperbackCollectionName(raw?: string): boolean {
  const cleaned = (raw || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return false;
  if (PAPERBACK_AND_PUBLISHER_COLLECTION_RE.test(cleaned)) return true;
  const norm = normalizeEditorialText(cleaned);
  return PAPERBACK_AND_PUBLISHER_COLLECTION_RE.test(norm);
}

/**
 * Vérifie qu'un numéro de tome de repli (hors notice d'ensemble explicite) est plausible
 * pour une série éditoriale, afin d'écarter les n° de collections poche (ex: 7304, 12281, 14456).
 */
export function isPlausibleFallbackSeriesNumber(rawVol?: string): boolean {
  const trimmed = (rawVol || '')
    .trim()
    .replace(/^(?:tome|volume|vol|t|n°|no)\.?\s*/i, '')
    .trim();
  if (!trimmed) return false;
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n > 0 && n <= 150;
  }
  return trimmed.length <= 6;
}
