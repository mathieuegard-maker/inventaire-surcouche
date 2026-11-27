// src/client/stores/social.store.ts
// Store Pinia Social : Foyer (join/regenerate), Amis suivis, Vitrine partagée & Réservation Cadeau anti-spoiler.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { apiRequest } from '../api/client';
import { useAuthStore, type AuthProfile } from './auth.store';
import { useLibraryStore } from './library.store';
import type { FamilyDetachPolicy } from '../../shared/types/domain.types';

export type GiftReservationStatus = 'available' | 'reserved_by_me' | 'reserved_by_other';

export interface FamilyDetachBookItem {
  id: string;
  title: string;
  seriesId: string | null;
  seriesName: string | null;
  volumeNumber: number | null;
  volumeLabel: string | null;
  isIntegral: boolean;
  includedVolumes: string[];
  authors: string[];
  mainCategory: string;
  genres: string[];
  coverUrl: string | null;
  ownershipStatus: 'owned' | 'wish';
  wishedByUserId: string | null;
  wishedByName: string | null;
  activeLoan: {
    borrowerName: string;
    loanedAt: string;
  } | null;
}

export interface FamilyDetachPreview {
  libraryId: string;
  libraryName: string;
  detachPolicy: FamilyDetachPolicy;
  isActorOwner: boolean;
  isSelfDetach: boolean;
  canTransferOwned: boolean;
  targetMember: {
    userId: string;
    username: string;
    role: 'owner' | 'member';
  };
  willTransferOwnershipTo: {
    userId: string;
    username: string;
  } | null;
  defaultNewLibraryName: string;
  preselectedBookIds: string[];
  books: FamilyDetachBookItem[];
}

export interface FamilyDetachResult {
  newLibraryId: string;
  newLibraryName: string;
  targetUserId: string;
  targetUsername: string;
  selfDetached: boolean;
  promotedOwnerUsername: string | null;
  mode: 'move' | 'copy';
  transferredOwnedCount: number;
  transferredWishCount: number;
  transferredLoansCount: number;
  keptAsFriends: boolean;
}

export interface FriendItem {
  libraryId: string;
  libraryName: string;
  ownerUsername: string;
  shareToken: string;
  connectedAt: string;
  deletedAt?: string | null;
  ownedCount: number;
  wishCount: number;
}

export interface SharedBookItem {
  id: string;
  title: string;
  seriesId: string | null;
  seriesName: string | null;
  volumeLabel: string | null;
  isIntegral: boolean;
  includedVolumes: string[];
  authors: string[];
  publisher: string | null;
  mainCategory: string;
  genres: string[];
  coverUrl: string | null;
  ownershipStatus: 'owned' | 'wish';
  isLent: boolean;
  giftReservation: GiftReservationStatus | null;
}

export interface SharedLibraryData {
  libraryId: string;
  libraryName: string;
  ownerUsername: string;
  isOwnLibrary: boolean;
  canReserveGifts: boolean;
  alreadyFriend: boolean;
  books: SharedBookItem[];
}

export const useSocialStore = defineStore('social', () => {
  const friends = ref<FriendItem[]>([]);
  const removedFriends = ref<FriendItem[]>([]);
  const loading = ref(false);

  async function fetchFriends(): Promise<FriendItem[]> {
    loading.value = true;
    try {
      const res = await apiRequest<{ ok: true; friends: FriendItem[]; removedFriends?: FriendItem[] }>('/api/social/friends');
      friends.value = res.friends;
      removedFriends.value = res.removedFriends ?? [];
      return res.friends;
    } finally {
      loading.value = false;
    }
  }

  async function addFriend(shareToken: string): Promise<{ libraryId: string; ownerUsername: string }> {
    const res = await apiRequest<{
      ok: true;
      libraryId: string;
      ownerUsername: string;
      friends: FriendItem[];
      removedFriends?: FriendItem[];
    }>('/api/social/friends', {
      method: 'POST',
      body: { shareToken }
    });
    friends.value = res.friends;
    removedFriends.value = res.removedFriends ?? [];
    return { libraryId: res.libraryId, ownerUsername: res.ownerUsername };
  }

  async function removeFriend(targetLibraryId: string): Promise<void> {
    const res = await apiRequest<{ ok: true; friends: FriendItem[]; removedFriends?: FriendItem[] }>(
      `/api/social/friends/${encodeURIComponent(targetLibraryId)}`,
      { method: 'DELETE' }
    );
    friends.value = res.friends;
    removedFriends.value = res.removedFriends ?? [];
  }

  async function restoreFriend(targetLibraryId: string): Promise<void> {
    const res = await apiRequest<{ ok: true; friends: FriendItem[]; removedFriends?: FriendItem[] }>(
      `/api/social/friends/${encodeURIComponent(targetLibraryId)}/restore`,
      { method: 'POST' }
    );
    friends.value = res.friends;
    removedFriends.value = res.removedFriends ?? [];
  }

  async function joinFamily(inviteCode: string): Promise<{ targetLibraryName: string }> {
    const authStore = useAuthStore();
    const libraryStore = useLibraryStore();
    const res = await apiRequest<{
      ok: true;
      targetLibraryId: string;
      targetLibraryName: string;
      profile: AuthProfile;
    }>('/api/social/family/join', {
      method: 'POST',
      body: { inviteCode }
    });
    authStore.hydrateProfile(res.profile);
    await libraryStore.syncNow({ forceFullPull: true });
    return { targetLibraryName: res.targetLibraryName };
  }

  async function updateFamilyPolicy(detachPolicy: FamilyDetachPolicy): Promise<FamilyDetachPolicy> {
    const authStore = useAuthStore();
    const res = await apiRequest<{
      ok: true;
      detachPolicy: FamilyDetachPolicy;
      profile: AuthProfile;
    }>('/api/social/family/policy', {
      method: 'PATCH',
      body: { detachPolicy }
    });
    authStore.hydrateProfile(res.profile);
    return res.detachPolicy;
  }

  async function fetchDetachPreview(targetUserId: string): Promise<FamilyDetachPreview> {
    const res = await apiRequest<{ ok: true; preview: FamilyDetachPreview }>(
      `/api/social/family/detach-preview/${encodeURIComponent(targetUserId)}`
    );
    return res.preview;
  }

  async function detachFamilyMember(payload: {
    targetUserId: string;
    mode: 'move' | 'copy';
    bookIds: string[];
    loanDecisions: Record<string, 'transfer' | 'return' | 'skip'>;
    keepAsFriends: boolean;
    newLibraryName?: string;
  }): Promise<FamilyDetachResult> {
    const authStore = useAuthStore();
    const libraryStore = useLibraryStore();
    const res = await apiRequest<{
      ok: true;
      result: FamilyDetachResult;
      profile: AuthProfile;
    }>('/api/social/family/detach', {
      method: 'POST',
      body: payload
    });
    authStore.hydrateProfile(res.profile);
    await libraryStore.syncNow({ forceFullPull: true });
    await fetchFriends().catch(() => undefined);
    return res.result;
  }

  async function regenerateToken(tokenType: 'family' | 'friend'): Promise<string> {
    const authStore = useAuthStore();
    const res = await apiRequest<{
      ok: true;
      newCode: string;
      profile: AuthProfile;
    }>('/api/social/tokens/regenerate', {
      method: 'POST',
      body: { tokenType }
    });
    authStore.hydrateProfile(res.profile);
    return res.newCode;
  }

  async function fetchSharedLibrary(token: string): Promise<SharedLibraryData> {
    const res = await apiRequest<{ ok: true; shared: SharedLibraryData }>(
      `/api/social/share/${encodeURIComponent(token)}`
    );
    return res.shared;
  }

  async function reserveGift(token: string, bookId: string): Promise<GiftReservationStatus> {
    const res = await apiRequest<{ ok: true; status: GiftReservationStatus }>(
      `/api/social/share/${encodeURIComponent(token)}/reserve/${encodeURIComponent(bookId)}`,
      { method: 'POST' }
    );
    return res.status;
  }

  async function cancelGiftReservation(token: string, bookId: string): Promise<GiftReservationStatus> {
    const res = await apiRequest<{ ok: true; status: GiftReservationStatus }>(
      `/api/social/share/${encodeURIComponent(token)}/reserve/${encodeURIComponent(bookId)}`,
      { method: 'DELETE' }
    );
    return res.status;
  }

  return {
    friends,
    removedFriends,
    loading,
    fetchFriends,
    addFriend,
    removeFriend,
    restoreFriend,
    joinFamily,
    updateFamilyPolicy,
    fetchDetachPreview,
    detachFamilyMember,
    regenerateToken,
    fetchSharedLibrary,
    reserveGift,
    cancelGiftReservation
  };
});
