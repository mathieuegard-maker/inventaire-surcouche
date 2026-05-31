// scratch/run_lookup.ts
import { externalMetadataService } from '../src/core/services/external-metadata.service';

// Configuration du polyfill pour exécuter en Node avec URL absolue vers Vercel dev
const originalFetch = globalThis.fetch;
globalThis.fetch = function(url, options) {
  let finalUrl = url;
  if (typeof url === 'string' && url.startsWith('/api')) {
    finalUrl = 'http://localhost:3000' + url;
  }
  return originalFetch(finalUrl, options);
};

// Récupération de l'ISBN fourni en ligne de commande
const args = process.argv.slice(2);
const isbn = args[0] || '9782355848858'; // Exemple par défaut : Paula Hawkins - Celle qui brûle

async function main() {
  console.log(`\n==================================================`);
  console.log(`🔍 RECHERCHE EXPLOITATION MÉTADONNÉES EXTERNES`);
  console.log(`==================================================`);
  console.log(`ISBN Cible : ${isbn}`);
  console.log(`Serveur local Gateway ciblé : http://localhost:3000`);
  console.log(`--------------------------------------------------\n`);

  try {
    const result = await externalMetadataService.fetchFromExternalSources(isbn);

    if (!result) {
      console.log(`❌ Aucun résultat trouvé pour l'ISBN ${isbn} sur les sources externes (BNF et Open Library).`);
      return;
    }

    console.log(`🎉 RÉSULTAT AGRÉGÉ ET NETTOYÉ :`);
    console.log(JSON.stringify(result, null, 2));
    console.log(`\n--------------------------------------------------`);
    console.log(`💡 Renseignements humains :`);
    console.log(`Titre propre     : "${result.title}"`);
    console.log(`Auteur(s) propre : [${result.authors.map(a => `"${a}"`).join(', ')}]`);
    console.log(`Éditeur propre   : "${result.publisher || 'Non renseigné'}"`);
    console.log(`Date de pub.     : "${result.publishDate || 'Non renseignée'}"`);
    console.log(`Pages            : ${result.pageCount || 'Non renseigné'}`);
    console.log(`Couverture URL   : "${result.coverUrl || 'Aucune image'}"`);
    console.log(`==================================================\n`);
  } catch (error: any) {
    console.error(`💥 Erreur d'exécution :`, error.message);
    console.log(`💡 Assurez-vous que le serveur local (vercel dev) tourne bien sur le port 3000.`);
  }
}

main();
