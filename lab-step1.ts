// lab-step1.ts
const SERIES_ID = 'wd:Q1508136';
const LOCAL_PROXY_URL = 'http://localhost:3000'; // Assure-toi que ton serveur local tourne sur ce port

async function runStep1() {
  console.log(`\n======================================================`);
  console.log(`=== ÉTAPE 1 : LE COLLECTEUR (Simulation seriesResolver) ===`);
  console.log(`======================================================\n`);
  
  console.log(`[ENTRÉE] Identifiant de la série : ${SERIES_ID}`);
  
  try {
    const targetUrl = `${LOCAL_PROXY_URL}/api/gateway?action=series-list&seriesId=${encodeURIComponent(SERIES_ID)}`;
    console.log(`[RÉSEAU] Interrogation de la gateway locale : ${targetUrl}\n`);
    
    const response = await fetch(targetUrl);
    
    if (!response.ok) {
      throw new Error(`Erreur réseau HTTP ${response.status} : ${response.statusText}`);
    }
    
    const data = await response.json();
    const tomeUris = data.uris || data.tomes || [];
    
    console.log(`[SORTIE BRUTE] Données renvoyées par la Gateway :`);
    console.log(JSON.stringify(data, null, 2));
    
    console.log(`\n[RÉSULTAT ÉTAPE 1]`);
    console.log(`-> Nombre d'œuvres (tomes) identifiées : ${tomeUris.length}`);
    console.log(`-> Liste des URIs :`, tomeUris);
    console.log(`\n======================================================\n`);

  } catch (error) {
    console.error(`[ERREUR FATALE] Le test a échoué :`, error);
  }
}

runStep1();