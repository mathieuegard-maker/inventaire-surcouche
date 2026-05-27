<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseHeader from '../components/BaseHeader.vue';
import BaseTitle from '../components/BaseTitle.vue';
import BaseLoading from '../components/BaseLoading.vue';
import BaseBanner from '../components/BaseBanner.vue';
import { TEXTS } from '../locales/fr';
import { inventaireSearchProvider } from '../../core/providers/inventaire-search.provider';
import { workUriResolver } from '../../core/resolvers/workUri.resolver';

const route = useRoute();
const router = useRouter();

const isLoading = ref(true);
const errorMessage = ref('');
const authorName = ref('');
const works = ref<{ uri: string; label: string; description?: string }[]>([]);

onMounted(async () => {
  const authorId = route.params.id as string;
  if (!authorId) {
    errorMessage.value = TEXTS.authorView.errorFetch;
    isLoading.value = false;
    return;
  }

  try {
    // 1. Récupération des métadonnées de l'auteur pour afficher son identité textuelle
    const authorRes = await fetch(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(authorId)}`);
    if (authorRes.ok) {
      const authorData = await authorRes.json();
      const entity = authorData.entities?.[authorId];
      authorName.value = entity?.label || entity?.labels?.fr || entity?.labels?.en || authorId;
    } else {
      authorName.value = authorId;
    }

    // 2. Récupération asynchrone des URIs d'œuvres sémantiques rattachées
    const workUris = await inventaireSearchProvider.fetchAuthorWorks(authorId);
    if (workUris.length === 0) {
      isLoading.value = false;
      return;
    }

    // 3. Aspiration des fiches descriptives par paquets (chunks) de 50 pour éviter la saturation
    const CHUNK_SIZE = 50;
    const fetchedWorks: { uri: string; label: string; description?: string }[] = [];

    for (let i = 0; i < workUris.length; i += CHUNK_SIZE) {
      const chunk = workUris.slice(i, i + CHUNK_SIZE);
      const res = await fetch(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(chunk.join('|'))}`);
      if (res.ok) {
        const data = await res.json();
        const entities = data.entities || {};
        chunk.forEach(uri => {
          const ent = entities[uri];
          if (ent) {
            fetchedWorks.push({
              uri,
              label: ent.label || ent.labels?.fr || ent.labels?.en || TEXTS.authorView.unknownTitle,
              description: ent.description || ent.descriptions?.fr || undefined
            });
          }
        });
      }
    }

    works.value = fetchedWorks;
  } catch (error) {
    console.error('[AUTHOR VIEW] Échec du chargement du profil de l\'auteur :', error);
    errorMessage.value = TEXTS.authorView.errorFetch;
  } finally {
    isLoading.value = false;
  }
});

const handleSelectWork = async (uri: string) => {
  isLoading.value = true;
  try {
    // Déclenchement de l'entonnoir d'élection canonique (Levenshtein + Langue + JUNK_REGEX) pour extraire l'ISBN physique
    const isbn = await workUriResolver.resolveIsbnFromWorkUri(uri);
    if (isbn) {
      router.push(`/book/${encodeURIComponent(isbn)}`);
    } else {
      alert(TEXTS.searchResults.errorNoPhysicalEdition);
      isLoading.value = false;
    }
  } catch (error) {
    console.error('[AUTHOR VIEW] Échec du calcul du pivot ISBN :', error);
    alert(TEXTS.searchResults.errorPivot);
    isLoading.value = false;
  }
};
</script>

<template>
  <div class="view-container">
    <BaseHeader />
    <BaseTitle :text="authorName || TEXTS.authorView.title" level="h2" />

    <BaseLoading v-if="isLoading" />

    <div v-else class="main-content-wrapper">
      <BaseBanner v-if="errorMessage" type="error" :message="errorMessage" />
      
      <BaseBanner 
        v-if="!works.length && !errorMessage" 
        type="error" 
        :message="TEXTS.authorView.emptyWorks" 
      />

      <div v-if="works.length" class="semantic-bucket-section">
        <div class="wishlist-section-header">{{ TEXTS.authorView.sectionWorks }}</div>
        <div class="wireframe-table-container">
          <div 
            v-for="work in works" 
            :key="work.uri" 
            class="mini-card-row card-row-clickable"
            @click="handleSelectWork(work.uri)"
          >
            <div class="row-cover-container row-macaron-container">
              <span class="row-macaron-label">{{ TEXTS.authorView.badgeWork }}</span>
            </div>
            <div class="row-info-content">
              <p class="row-title">{{ work.label }}</p>
              <p v-if="work.description" class="row-series-meta">{{ work.description }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>