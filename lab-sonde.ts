// lab-sonde.ts
async function runSonde() {
  console.log("Recherche de la structure exacte du titre...");
  const uri = 'inv:b4287eb063533479c35a81990e4e022a';
  
  try {
    const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${uri}`);
    const data = await res.json();
    const entity = data.entities[uri];
    
    console.log("\n=== STRUCTURE INTERNE DE WDT:P1476 ===");
    console.log(JSON.stringify(entity.claims['wdt:P1476'], null, 2));
    console.log("======================================\n");
  } catch (e) {
    console.error("Erreur :", e);
  }
}

runSonde();
