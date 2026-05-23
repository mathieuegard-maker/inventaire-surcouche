// lab-step2-v2.ts
const missingWorks = [
  'wd:Q2877799',
  'wd:Q3222978',
  'wd:Q3222526',
  'wd:Q2943496',
  'wd:Q3225306',
  'wd:Q3209391'
];

function getEditDistance(a: string, b: string): number {
  if (!a) return b ? b.length : 0;
  if (!b) return a ? a.length : 0;
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

function extractEntityTitle(entity: any, uri: string): string {
  if (!entity) return 'SANS_TITRE_ENTITE_NULLE';
  
  let title = '';

  // 1. Recherche dans les claims (Format Inventaire natif)
  if (entity.claims && entity.claims['wdt:P1476']) {
    const p1476 = entity.claims['wdt:P1476'][0];
    // On fouille dans les différentes architectures possibles du JSON
    title = p1476?.mainsnak?.datavalue?.value?.text || p1476?.datavalue?.value?.text || p1476?.value;
    if (title && typeof title === 'string') return title;
  }

  // 2. Recherche dans les labels (Format Wikidata)
  if (entity.labels) {
    if (entity.labels.fr) title = typeof entity.labels.fr === 'string' ? entity.labels.fr : entity.labels.fr.value;
    if (!title && entity.labels.en) title = typeof entity.labels.en === 'string' ? entity.labels.en : entity.labels.en.value;
    if (title && typeof title === 'string') return title;
  }
  
  if (entity.label) return entity.label;

  // SONDE PROFONDE : Si on arrive ici, c'est qu'on n'a pas trouvé le titre
  console.log(`\n    ⚠️ ATTENTION : Impossible de trouver le titre pour ${uri}. Voici la structure brute de ses claims :`);
  console.log(`    ${JSON.stringify(entity.claims ? Object.keys(entity.claims) : 'Aucun claim', null, 2)}`);
  
  return 'SANS_TITRE';
}

async function runStep2() {
  console.log(`\n======================================================`);
  console.log(`=== ÉTAPE 2 (V2) : LE TAMIS (Avec extracteur de titres) ===`);
  console.log(`======================================================\n`);

  const physicalUris: string[] = [];
  const workToEditionsMap: Record<string, string[]> = {};
  const allEditionUrisToFetch = new Set<string>();

  console.log(`[1/4] Récupération des éditions liées...`);
  for (const workUri of missingWorks) {
    try {
      const res = await fetch(`https://inventaire.io/api/entities?action=reverse-claims&property=wdt:P629&value=${workUri}`);
      const data = await res.json();
      const uris = data.uris || [];
      workToEditionsMap[workUri] = uris;
      uris.forEach((u: string) => allEditionUrisToFetch.add(u));
    } catch (e) {
      workToEditionsMap[workUri] = [];
    }
  }

  console.log(`[2/4] Récupération des données complètes des ${allEditionUrisToFetch.size} éditions...`);
  const editionDataMap: Record<string, any> = {};
  const urisArray = Array.from(allEditionUrisToFetch);
  for (let i = 0; i < urisArray.length; i += 50) {
    const chunk = urisArray.slice(i, i + 50);
    // ATTENTION : On a bien retiré &attributes=labels ici pour tout récupérer !
    const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}`);
    const data = await res.json();
    Object.assign(editionDataMap, data.entities || {});
  }

  console.log(`[3/4] Récupération des données des ${missingWorks.length} oeuvres...`);
  const workDataMap: Record<string, any> = {};
  for (let i = 0; i < missingWorks.length; i += 50) {
    const chunk = missingWorks.slice(i, i + 50);
    const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}`);
    const data = await res.json();
    Object.assign(workDataMap, data.entities || {});
  }

  const JUNK_REGEX = /intégrale|coffret|box\s*set|pack|compilation/i;

  console.log(`\n[4/4] ÉLECTION DE L'ÉDITION CANONIQUE\n`);
  for (const workUri of missingWorks) {
    console.log(`------------------------------------------------------`);
    const workLabel = extractEntityTitle(workDataMap[workUri], workUri);
    console.log(`Oeuvre analysée : ${workUri} ("${workLabel}")`);

    const editions = workToEditionsMap[workUri] || [];
    let validEditions = editions.filter(edUri => {
      const edData = editionDataMap[edUri];
      const edLabel = extractEntityTitle(edData, edUri);
      return !JUNK_REGEX.test(edLabel);
    });
    
    let targetEditions = validEditions.length > 0 ? validEditions : editions;
    const nativeEditions = targetEditions.filter(edUri => edUri.startsWith('inv:'));
    if (nativeEditions.length > 0) targetEditions = nativeEditions;

    if (targetEditions.length === 1) {
       console.log(`  ✅ FAST-PATH : 1 seul candidat -> ${targetEditions[0]}`);
       physicalUris.push(targetEditions[0]);
       continue;
    }

    let bestUri = targetEditions[0];
    let bestScore = Infinity;
    
    console.log(`  Bataille Levenshtein :`);
    for (const edUri of targetEditions) {
      const edData = editionDataMap[edUri];
      const edLabel = extractEntityTitle(edData, edUri);
      const score = getEditDistance(workLabel, edLabel);
      console.log(`    - ${edUri} ("${edLabel}") -> Score: ${score}`);
      if (score < bestScore) {
        bestScore = score;
        bestUri = edUri;
      }
    }
    
    console.log(`  ✅ ÉLECTION : Meilleur score pour -> ${bestUri}`);
    physicalUris.push(bestUri);
  }

  console.log(`\n======================================================`);
  console.log(`[RÉSULTAT FINAL ÉTAPE 2 V2]`);
  console.log(physicalUris);
  console.log(`======================================================\n`);
}

runStep2();