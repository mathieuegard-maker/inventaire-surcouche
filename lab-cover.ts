// lab-cover.ts
const TARGET_URI = 'inv:0888c0e93595f51c17f601eb6a95c1c3';

// Le "passeport" pour ne pas se faire bloquer par le pare-feu d'Inventaire
const REQUEST_OPTIONS = {
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'InventaireMobileOverlayLab/1.0 (mathieu.egard@gmail.com)'
  }
};

async function runCoverLab() {
  console.log(`\n🔍 ANALYSE DE COUVERTURE POUR : ${TARGET_URI}\n`);

  try {
    // 1. Analyse de l'édition elle-même
    const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${TARGET_URI}&attributes=info|labels|claims|image`, REQUEST_OPTIONS);
    const data = await res.json();
    const entity = data.entities[TARGET_URI];

    if (!entity) {
      console.log(`❌ Entité introuvable sur l'API.`);
      return;
    }

    console.log(`--- 1. DONNÉES DIRECTES DE L'ÉDITION ---`);
    console.log(`Propriété 'image' native :`, entity.image || '❌ ABSENTE');
    console.log(`Claim wdt:P18 (Image standard) :`, entity.claims?.['wdt:P18'] ? '✅ PRÉSENT' : '❌ ABSENT');
    if (entity.claims?.['wdt:P18']) {
       console.log(JSON.stringify(entity.claims['wdt:P18'], null, 2));
    }

    // 2. Recherche de l'oeuvre mère
    const workClaim = entity.claims?.['wdt:P629']?.[0];
    const workUri = typeof workClaim === 'string' ? workClaim : workClaim?.value;

    console.log(`\n--- 2. ANALYSE DE L'OEUVRE MÈRE ---`);
    if (!workUri) {
      console.log(`❌ Aucune oeuvre mère liée (wdt:P629). Le pillage est impossible.`);
      return;
    }
    console.log(`Oeuvre mère trouvée : ${workUri}`);

    const wRes = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${workUri}&attributes=info|labels|claims|image`, REQUEST_OPTIONS);
    const wData = await wRes.json();
    const workEntity = wData.entities[workUri];

    console.log(`Propriété 'image' sur l'oeuvre mère :`, workEntity?.image || '❌ ABSENTE');

    // 3. Simulation du Pillage (Scavenging) exhaustif
    console.log(`\n--- 3. TENTATIVE DE PILLAGE SUR LA FRATRIE ---`);
    const sibRes = await fetch(`https://inventaire.io/api/entities?action=reverse-claims&property=wdt:P629&value=${workUri}`, REQUEST_OPTIONS);
    const sibData = await sibRes.json();
    const siblingUris = (sibData.uris || []).filter((u: string) => u !== TARGET_URI);

    console.log(`Nombre total d'éditions soeurs : ${siblingUris.length}`);

    if (siblingUris.length > 0) {
      const imgRes = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(siblingUris.join('|'))}&attributes=image`, REQUEST_OPTIONS);
      const imgData = await imgRes.json();

      let foundCount = 0;
      let firstFoundIndex = -1;

      for (let i = 0; i < siblingUris.length; i++) {
        const sUri = siblingUris[i];
        if (imgData.entities?.[sUri]?.image) {
          foundCount++;
          if (firstFoundIndex === -1) firstFoundIndex = i;
          console.log(`✅ [Soeur n°${i + 1}] ${sUri} POSSÈDE une couverture.`);
        }
      }
      
      if (foundCount === 0) {
         console.log(`❌ AUCUNE soeur ne possède de couverture native.`);
      } else {
         console.log(`\n💡 BILAN DU PILLAGE : ${foundCount} couvertures disponibles sur ${siblingUris.length} soeurs.`);
         if (firstFoundIndex >= 10) {
             console.log(`⚠️ ALERTE : La première soeur avec une image est la n°${firstFoundIndex + 1}. Notre code actuel s'arrête à 10, voilà pourquoi il a échoué !`);
         } else {
             console.log(`✅ Le code actuel aurait dû trouver l'image sur la soeur n°${firstFoundIndex + 1}. Le problème vient d'ailleurs.`);
         }
      }
    }

  } catch (e) {
    console.error("Erreur durant l'analyse :", e);
  }
}

runCoverLab();