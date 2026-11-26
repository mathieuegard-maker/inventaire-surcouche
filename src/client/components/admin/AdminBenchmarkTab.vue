<!-- src/client/components/admin/AdminBenchmarkTab.vue -->
<!-- Composant temporaire isolé (100 % Admin, supprimable en 1 commit après la phase de recette). -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import BaseModal from '../base/BaseModal.vue';
import PaginationBar from '../base/PaginationBar.vue';
import { apiRequest, ApiClientError } from '../../api/client';
import { useJobsStore } from '../../stores/jobs.store';
import { useLibraryStore } from '../../stores/library.store';
import { useUiStore } from '../../stores/ui.store';
import { t } from '../../../shared/locales';
import type {
  AdminBenchmarkGradedReport,
  AdminBenchmarkJobView,
  AdminBenchmarkLiveItem,
  BackgroundJobStatus,
  BackgroundJobView,
  BenchmarkCheckField,
  BenchmarkGradedItem,
  BenchmarkWarningCode,
  CollectionImportComparisonSnapshot,
  CollectionImportResolutionChannel,
  ImportInputProfileCode
} from '../../../shared/types/domain.types';

type VerdictFilter = 'all' | 'warning' | 'failed' | 'no_cover' | 'flagged_down' | 'flagged_up' | 'ok';
type InputModeFilter = 'all' | 'with_isbn' | 'without_isbn';

interface HumanReviewEntry {
  vote: 'up' | 'down' | null;
  note: string;
}

const REVIEWS_STORAGE_PREFIX = 'biblio_admin_bench_reviews_v1:';

const uiStore = useUiStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();

const loading = ref(false);
const activeCatalogJobsCount = ref(0);
const benchmarkJobs = ref<AdminBenchmarkJobView[]>([]);
const selectedJobId = ref<string>('');

// Upload CSV d'entrée (sujet)
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

// Upload CSV de correction (vérité terrain) & rapport Markdown généré
const gtFileInputRef = ref<HTMLInputElement | null>(null);
const gradingBusy = ref(false);
const gradedReport = ref<AdminBenchmarkGradedReport | null>(null);
const gradedMarkdown = ref<string>('');
const latestReportFilename = ref<string | null>(null);

// Filtres & pagination (fluide sur 1 080+ lignes)
const verdictFilter = ref<VerdictFilter>('all');
const inputModeFilter = ref<InputModeFilter>('all');
const categoryFilter = ref('');
const profileFilter = ref('');
const failedFieldFilter = ref<'' | BenchmarkCheckField>('');
const searchQuery = ref('');
const currentPage = ref(1);
const pageSize = ref(50);

// Revue humaine locale par job (localStorage)
const reviewsByRow = ref<Record<number, HumanReviewEntry>>({});

// Modale Reset DB livres
const resetModalOpen = ref(false);
const resetConfirmText = ref('');
const resetBusy = ref(false);

const selectedJob = computed<AdminBenchmarkJobView | null>(() => {
  if (benchmarkJobs.value.length === 0) return null;
  return benchmarkJobs.value.find((j) => j.id === selectedJobId.value) ?? benchmarkJobs.value[0];
});

const liveImportJob = computed(() => jobsStore.latestCollectionImportJob);
const isLiveImportRunning = computed(
  () => liveImportJob.value?.status === 'pending' || liveImportJob.value?.status === 'running'
);

// Index O(1) des résultats notés par rowNumber
const gradedByRowNumber = computed<Map<number, BenchmarkGradedItem>>(() => {
  const map = new Map<number, BenchmarkGradedItem>();
  if (gradedReport.value) {
    for (const item of gradedReport.value.items) {
      map.set(item.rowNumber, item);
    }
  }
  return map;
});

const availableCategories = computed<string[]>(() => {
  const set = new Set<string>();
  if (gradedReport.value) {
    for (const b of gradedReport.value.byCategory) set.add(b.key);
  }
  const job = selectedJob.value;
  if (job) {
    for (const item of job.items) {
      if (item.input.testCategory) set.add(item.input.testCategory);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'));
});

const availableProfiles = computed<string[]>(() => {
  if (!gradedReport.value) return [];
  return gradedReport.value.byProfile.map((b) => b.key);
});

const flaggedDownCount = computed(() => {
  const job = selectedJob.value;
  if (!job) return 0;
  return job.items.filter((item) => reviewsByRow.value[item.rowNumber]?.vote === 'down').length;
});

const flaggedUpCount = computed(() => {
  const job = selectedJob.value;
  if (!job) return 0;
  return job.items.filter((item) => reviewsByRow.value[item.rowNumber]?.vote === 'up').length;
});

const okCountDisplay = computed(() =>
  gradedReport.value ? gradedReport.value.totals.perfectRows : (selectedJob.value?.summary.okCount ?? 0)
);

const warningCountDisplay = computed(() =>
  gradedReport.value ? gradedReport.value.totals.partialRows : (selectedJob.value?.summary.warningCount ?? 0)
);

const failedCountDisplay = computed(() =>
  gradedReport.value ? gradedReport.value.totals.failedRows : (selectedJob.value?.summary.unmatchedCount ?? 0)
);

const filteredItems = computed<AdminBenchmarkLiveItem[]>(() => {
  const job = selectedJob.value;
  if (!job) return [];

  const q = searchQuery.value.trim().toLowerCase();
  const gtMap = gradedByRowNumber.value;
  const hasGrade = Boolean(gradedReport.value);

  return job.items.filter((item) => {
    const rev = reviewsByRow.value[item.rowNumber];
    const graded = gtMap.get(item.rowNumber);

    if (verdictFilter.value === 'ok') {
      if (hasGrade) {
        if (graded?.verdict !== 'perfect') return false;
      } else if (item.verdict !== 'ok') {
        return false;
      }
    } else if (verdictFilter.value === 'warning') {
      if (hasGrade) {
        if (graded?.verdict !== 'partial') return false;
      } else if (item.verdict !== 'warning') {
        return false;
      }
    } else if (verdictFilter.value === 'failed') {
      if (hasGrade) {
        if (graded?.verdict !== 'failed') return false;
      } else if (item.verdict !== 'failed') {
        return false;
      }
    } else if (verdictFilter.value === 'no_cover') {
      if (!item.warnings.includes('missing_cover')) return false;
    } else if (verdictFilter.value === 'flagged_down') {
      if (rev?.vote !== 'down') return false;
    } else if (verdictFilter.value === 'flagged_up') {
      if (rev?.vote !== 'up') return false;
    }

    const hasInputIsbn = Boolean(item.input.isbn && item.input.isbn.trim());
    if (inputModeFilter.value === 'with_isbn' && !hasInputIsbn) return false;
    if (inputModeFilter.value === 'without_isbn' && hasInputIsbn) return false;

    if (categoryFilter.value) {
      const rowCat = graded?.expected.categorie ?? item.input.testCategory ?? '';
      if (rowCat !== categoryFilter.value) return false;
    }

    if (profileFilter.value) {
      const rowProf = graded?.expected.profilEntree ?? item.input.inputProfile ?? '';
      if (rowProf !== profileFilter.value) return false;
    }

    if (failedFieldFilter.value) {
      if (!graded || !graded.failedFields.includes(failedFieldFilter.value)) return false;
    }

    if (q) {
      const eff = getEffectiveOutput(item);
      const haystack = [
        String(item.rowNumber),
        graded ? String(graded.dataLineNumber) : null,
        graded?.expected.fichierOrigine,
        graded?.expected.categorie,
        graded?.expected.profilEntree,
        graded?.expected.titreAttendu,
        graded?.expected.serieAttendue,
        graded?.expected.auteurAttendu,
        graded?.expected.editeurAttendu,
        graded?.expected.collectionEditoriale,
        graded?.expected.regleVerification,
        item.input.isbn,
        item.input.title,
        item.input.series,
        item.input.author,
        item.input.publisher,
        item.input.testCategory,
        item.input.notes,
        item.resolvedIsbn13,
        eff?.title,
        eff?.seriesName,
        eff?.publisher,
        ...(eff?.authors ?? []),
        rev?.note
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredItems.value.length / pageSize.value)));

const paginatedItems = computed<AdminBenchmarkLiveItem[]>(() => {
  const safePage = Math.min(currentPage.value, totalPages.value);
  const start = (safePage - 1) * pageSize.value;
  return filteredItems.value.slice(start, start + pageSize.value);
});

const tableCssVars = computed(() => ({
  '--bench-col-input': `"${t('admin.benchmarkColInput').replace(/"/g, '\\"')}"`,
  '--bench-col-output': `"${t('admin.benchmarkColOutput').replace(/"/g, '\\"')}"`,
  '--bench-col-verdict': `"${t('admin.benchmarkColVerdict').replace(/"/g, '\\"')}"`
}));

function getEffectiveOutput(item: AdminBenchmarkLiveItem): CollectionImportComparisonSnapshot | null {
  return item.live ?? item.snapshot;
}

function getProfileLabel(code: ImportInputProfileCode): string {
  return t(`admin.benchmarkProfile_${code}`);
}

function getWarningLabel(code: BenchmarkWarningCode): string {
  return t(`admin.benchmarkWarn_${code}`);
}

function getFieldCheckLabel(field: BenchmarkCheckField): string {
  return t(`admin.benchmarkFieldCheck_${field}`);
}

function getChannelLabel(channel: CollectionImportResolutionChannel): string {
  if (channel === 'isbn_direct') return t('admin.benchmarkChannelIsbn');
  if (channel === 'search_to_isbn') return t('admin.benchmarkChannelSearch');
  if (channel === 'cache') return t('admin.benchmarkChannelCache');
  return t('admin.benchmarkChannelUnmatched');
}

function getJobStatusLabel(status: BackgroundJobStatus): string {
  return t(`admin.benchmarkJobStatus_${status}`);
}

function getRowVisualState(item: AdminBenchmarkLiveItem): 'ok' | 'warning' | 'failed' {
  const graded = gradedByRowNumber.value.get(item.rowNumber);
  if (graded) {
    if (graded.verdict === 'perfect') return 'ok';
    if (graded.verdict === 'partial') return 'warning';
    return 'failed';
  }
  return item.verdict;
}

function loadReviewsForJob(jobId: string): void {
  if (!jobId) {
    reviewsByRow.value = {};
    return;
  }
  try {
    const raw = localStorage.getItem(`${REVIEWS_STORAGE_PREFIX}${jobId}`);
    if (!raw) {
      reviewsByRow.value = {};
      return;
    }
    const parsed = JSON.parse(raw) as Record<string, HumanReviewEntry>;
    const normalized: Record<number, HumanReviewEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const rowNum = Number(k);
      if (Number.isFinite(rowNum) && v && typeof v === 'object') {
        normalized[rowNum] = {
          vote: v.vote === 'up' || v.vote === 'down' ? v.vote : null,
          note: typeof v.note === 'string' ? v.note : ''
        };
      }
    }
    reviewsByRow.value = normalized;
  } catch {
    reviewsByRow.value = {};
  }
}

function persistReviews(): void {
  const jobId = selectedJob.value?.id;
  if (!jobId) return;
  try {
    localStorage.setItem(`${REVIEWS_STORAGE_PREFIX}${jobId}`, JSON.stringify(reviewsByRow.value));
  } catch {
    // ignore quota localStorage
  }
}

function toggleVote(rowNumber: number, vote: 'up' | 'down'): void {
  const existing = reviewsByRow.value[rowNumber] ?? { vote: null, note: '' };
  const nextVote = existing.vote === vote ? null : vote;
  reviewsByRow.value = {
    ...reviewsByRow.value,
    [rowNumber]: { ...existing, vote: nextVote }
  };
  persistReviews();
}

function updateNote(rowNumber: number, note: string): void {
  const existing = reviewsByRow.value[rowNumber] ?? { vote: null, note: '' };
  reviewsByRow.value = {
    ...reviewsByRow.value,
    [rowNumber]: { ...existing, note }
  };
  persistReviews();
}

function getReview(rowNumber: number): HumanReviewEntry {
  return reviewsByRow.value[rowNumber] ?? { vote: null, note: '' };
}

async function loadExistingGradeForJob(jobId: string): Promise<void> {
  if (!jobId) {
    gradedReport.value = null;
    gradedMarkdown.value = '';
    latestReportFilename.value = null;
    return;
  }
  try {
    const res = await apiRequest<{
      ok: true;
      hasGroundTruth: boolean;
      report?: AdminBenchmarkGradedReport;
      markdown?: string;
      reportFilename?: string;
    }>(`/api/admin/import-benchmarks/${encodeURIComponent(jobId)}/grade`);
    if (res.hasGroundTruth && res.report) {
      gradedReport.value = res.report;
      gradedMarkdown.value = res.markdown ?? '';
      latestReportFilename.value = res.reportFilename ?? null;
    } else {
      gradedReport.value = null;
      gradedMarkdown.value = '';
      latestReportFilename.value = null;
    }
  } catch {
    gradedReport.value = null;
    gradedMarkdown.value = '';
    latestReportFilename.value = null;
  }
}

async function loadBenchmarks(preferJobId?: string): Promise<void> {
  loading.value = true;
  try {
    const res = await apiRequest<{
      ok: true;
      activeCatalogJobsCount: number;
      jobs: AdminBenchmarkJobView[];
    }>('/api/admin/import-benchmarks?limit=15');
    activeCatalogJobsCount.value = res.activeCatalogJobsCount;
    benchmarkJobs.value = res.jobs;

    if (preferJobId && res.jobs.some((j) => j.id === preferJobId)) {
      selectedJobId.value = preferJobId;
    } else if (!selectedJobId.value || !res.jobs.some((j) => j.id === selectedJobId.value)) {
      selectedJobId.value = res.jobs[0]?.id ?? '';
    }

    if (selectedJobId.value) {
      const current = res.jobs.find((j) => j.id === selectedJobId.value);
      if (current?.hasGroundTruth) {
        await loadExistingGradeForJob(selectedJobId.value);
      } else {
        gradedReport.value = null;
        gradedMarkdown.value = '';
        latestReportFilename.value = null;
      }
    }
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    loading.value = false;
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

function triggerFilePicker(): void {
  fileInputRef.value?.click();
}

function triggerGroundTruthPicker(): void {
  gtFileInputRef.value?.click();
}

async function handleFileSelected(event: Event): Promise<void> {
  const inputEl = event.target as HTMLInputElement;
  const file = inputEl.files?.[0] ?? null;
  inputEl.value = '';
  if (!file) return;

  const lower = file.name.toLowerCase();
  if (
    !lower.endsWith('.csv') &&
    !lower.endsWith('.tsv') &&
    !lower.endsWith('.txt') &&
    !lower.endsWith('.json') &&
    !lower.endsWith('.xlsx')
  ) {
    uiStore.pushToast(t('profile.importUnsupportedExt'), 'danger');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    uiStore.pushToast(t('profile.importFileTooLarge'), 'danger');
    return;
  }

  uploading.value = true;
  try {
    const contentBase64 = await readFileAsBase64(file);
    const res = await apiRequest<{
      ok: true;
      job: BackgroundJobView;
      totalRows: number;
      skippedCount: number;
    }>('/api/me/import', {
      method: 'POST',
      body: {
        filename: file.name,
        contentBase64,
        defaultStatus: 'owned'
      }
    });
    jobsStore.upsertJob(res.job);
    uiStore.pushToast(t('profile.importStartedToast', { count: res.totalRows }), 'info');
    verdictFilter.value = 'all';
    categoryFilter.value = '';
    profileFilter.value = '';
    failedFieldFilter.value = '';
    searchQuery.value = '';
    currentPage.value = 1;
    await loadBenchmarks(res.job.id);
  } catch (err) {
    const message = err instanceof ApiClientError ? err.message : t('app.retry');
    uiStore.pushToast(t('profile.importErrorPrefix', { message }), 'danger');
  } finally {
    uploading.value = false;
  }
}

async function handleGroundTruthSelected(event: Event): Promise<void> {
  const inputEl = event.target as HTMLInputElement;
  const file = inputEl.files?.[0] ?? null;
  inputEl.value = '';
  const job = selectedJob.value;
  if (!file || !job) return;

  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.csv') && !lower.endsWith('.tsv') && !lower.endsWith('.txt')) {
    uiStore.pushToast(t('admin.benchmarkGradeCsvOnlyError'), 'danger');
    return;
  }

  gradingBusy.value = true;
  try {
    const contentBase64 = await readFileAsBase64(file);
    const res = await apiRequest<{
      ok: true;
      report: AdminBenchmarkGradedReport;
      markdown: string;
      reportFilename: string;
      archiveFilename: string;
    }>(`/api/admin/import-benchmarks/${encodeURIComponent(job.id)}/grade`, {
      method: 'POST',
      body: {
        filename: file.name,
        contentBase64
      },
      timeoutMs: 60000
    });
    gradedReport.value = res.report;
    gradedMarkdown.value = res.markdown;
    latestReportFilename.value = res.archiveFilename || res.reportFilename;
    currentPage.value = 1;
    uiStore.pushToast(
      t('admin.benchmarkGradedSuccessToast', {
        resolved: res.report.totals.resolvedRatePct,
        perfect: res.report.totals.perfectRatePct,
        reportFile: res.archiveFilename
      }),
      'success'
    );
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    gradingBusy.value = false;
  }
}

async function handleRegrade(): Promise<void> {
  const job = selectedJob.value;
  if (!job) return;
  gradingBusy.value = true;
  try {
    const res = await apiRequest<{
      ok: true;
      report: AdminBenchmarkGradedReport;
      markdown: string;
      reportFilename: string;
      archiveFilename: string;
    }>(`/api/admin/import-benchmarks/${encodeURIComponent(job.id)}/regrade`, {
      method: 'POST',
      timeoutMs: 60000
    });
    gradedReport.value = res.report;
    gradedMarkdown.value = res.markdown;
    latestReportFilename.value = res.archiveFilename || res.reportFilename;
    activeCatalogJobsCount.value = res.report.activeCatalogJobsCount;
    uiStore.pushToast(
      t('admin.benchmarkGradedSuccessToast', {
        resolved: res.report.totals.resolvedRatePct,
        perfect: res.report.totals.perfectRatePct,
        reportFile: res.archiveFilename
      }),
      'success'
    );
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    gradingBusy.value = false;
  }
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    return true;
  } catch {
    return false;
  }
}

async function handleCopyGradedMarkdown(): Promise<void> {
  if (!gradedMarkdown.value) return;
  const ok = await copyTextToClipboard(gradedMarkdown.value);
  uiStore.pushToast(
    ok ? t('admin.benchmarkReportCopiedToast') : t('admin.benchmarkCopyErrorToast'),
    ok ? 'success' : 'danger'
  );
}

function handleDownloadGradedMarkdown(): void {
  const job = selectedJob.value;
  if (!job) return;
  window.location.href = `/api/admin/import-benchmarks/${encodeURIComponent(job.id)}/report.md`;
}

function buildAnomaliesMarkdown(job: AdminBenchmarkJobView): { count: number; markdown: string } {
  const anomalyRows = job.items.filter((item) => {
    const rev = reviewsByRow.value[item.rowNumber];
    return item.verdict !== 'ok' || rev?.vote === 'down' || Boolean(rev?.note.trim());
  });

  if (anomalyRows.length === 0) {
    return { count: 0, markdown: '' };
  }

  const lines: string[] = [
    `## Rapport d'anomalies — ${job.filename}`,
    `- **Job ID :** \`${job.id}\` (${job.createdAt.slice(0, 19).replace('T', ' ')})`,
    `- **Résumé :** ${job.summary.totalRows} lignes | ${job.summary.okCount} OK | ${job.summary.warningCount} à vérifier | ${job.summary.unmatchedCount} non trouvés | ${job.summary.missingCoverCount} sans couverture | ${flaggedDownCount.value} signalé(s) 👎`,
    `- **Canaux :** ${job.summary.resolvedByIsbnCount} ISBN · ${job.summary.resolvedBySearchCount} Recherche texte · moy. ${job.summary.avgDurationMs} ms/ligne`,
    ''
  ];

  for (const item of anomalyRows) {
    const rev = reviewsByRow.value[item.rowNumber];
    const eff = getEffectiveOutput(item);
    const flags: string[] = [item.verdict.toUpperCase()];
    if (rev?.vote === 'down') flags.push('👎 BUG');
    else if (rev?.vote === 'up') flags.push('👍');
    const profileTag = getProfileLabel(item.input.inputProfile);
    const catPart = item.input.testCategory ? ` · ${item.input.testCategory}` : '';

    lines.push(`### Ligne #${item.rowNumber} — [${flags.join(' | ')}] (${profileTag}${catPart})`);

    const inputParts: string[] = [];
    if (item.input.isbn) inputParts.push(`ISBN=${item.input.isbn}`);
    if (item.input.title) inputParts.push(`Titre="${item.input.title}"`);
    if (item.input.series) inputParts.push(`Série="${item.input.series}"`);
    if (item.input.volumeNumber) inputParts.push(`Tome=${item.input.volumeNumber}`);
    if (item.input.author) inputParts.push(`Auteur="${item.input.author}"`);
    if (item.input.publisher) inputParts.push(`Éditeur="${item.input.publisher}"`);
    if (item.input.isIntegral !== null) inputParts.push(`Intégrale=${item.input.isIntegral ? 'Oui' : 'Non'}`);
    if (item.input.includedVolumes.length > 0) inputParts.push(`Inclus=[${item.input.includedVolumes.join(',')}]`);
    lines.push(`- **Entrée CSV :** ${inputParts.join(' | ') || '—'}`);

    if (item.status === 'unmatched' || !eff) {
      lines.push(`- **Résultat :** NON TROUVÉ (\`${item.unmatchedReason ?? 'unknown'}\`, ${item.durationMs} ms)`);
    } else {
      const seriesStr = eff.seriesName
        ? `${eff.seriesName}${item.live ? ` (${item.live.seriesTotalVolumes} tomes, id=${eff.seriesId})` : ''}`
        : 'Aucune (One-shot)';
      const volStr = eff.isIntegral
        ? `Intégrale [${eff.includedVolumes.join(',')}]`
        : eff.volumeNumber !== null
          ? `T.${eff.volumeNumber}`
          : '—';
      lines.push(
        `- **Résultat :** "${eff.title}" | Série: ${seriesStr} | ${volStr} | Auteurs: ${eff.authors.join(', ') || '—'} | Éditeur: ${eff.publisher || '—'} | Cat.: ${eff.mainCategory}`
      );
      lines.push(
        `- **Technique :** \`bookId=${item.resolvedBookId}\` | \`isbn13=${item.resolvedIsbn13 ?? '—'}\` | Couverture: ${eff.coverUrl ? 'OK' : 'MANQUANTE'} | Canal: ${getChannelLabel(item.resolutionChannel)} (${item.durationMs} ms)`
      );
    }

    if (item.warnings.length > 0) {
      lines.push(`- **Alertes auto :** ${item.warnings.map((w) => getWarningLabel(w)).join(', ')}`);
    }
    if (rev?.note.trim()) {
      lines.push(`- **Note admin :** ${rev.note.trim()}`);
    }
    lines.push('');
  }

  return { count: anomalyRows.length, markdown: lines.join('\n') };
}

async function handleCopyAnomalies(): Promise<void> {
  if (gradedMarkdown.value) {
    await handleCopyGradedMarkdown();
    return;
  }
  const job = selectedJob.value;
  if (!job) return;
  const { count, markdown } = buildAnomaliesMarkdown(job);
  if (count === 0) {
    uiStore.pushToast(t('admin.benchmarkCopyAllOkToast'), 'success');
    return;
  }
  const ok = await copyTextToClipboard(markdown);
  uiStore.pushToast(
    ok ? t('admin.benchmarkCopySuccessToast', { count }) : t('admin.benchmarkCopyErrorToast'),
    ok ? 'success' : 'danger'
  );
}

function handleExportJson(): void {
  const job = selectedJob.value;
  if (!job) return;
  const payload = {
    ...job,
    gradedReport: gradedReport.value,
    humanReviews: reviewsByRow.value
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `benchmark-${job.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function openResetModal(): void {
  resetConfirmText.value = '';
  resetModalOpen.value = true;
}

async function confirmResetCatalog(): Promise<void> {
  if (resetConfirmText.value.trim() !== 'VIDER') return;
  resetBusy.value = true;
  try {
    const res = await apiRequest<{
      ok: true;
      deletedBooks: number;
      deletedSeries: number;
      deletedCoverFiles: number;
      resetAt: string;
    }>('/api/admin/reset-book-catalog', {
      method: 'POST',
      body: { confirmation: 'VIDER' }
    });
    await libraryStore.clearCache();
    await jobsStore.refreshJobs();
    resetModalOpen.value = false;
    benchmarkJobs.value = [];
    selectedJobId.value = '';
    gradedReport.value = null;
    gradedMarkdown.value = '';
    latestReportFilename.value = null;
    activeCatalogJobsCount.value = 0;
    uiStore.pushToast(
      t('admin.benchmarkResetSuccessToast', {
        books: res.deletedBooks,
        series: res.deletedSeries,
        covers: res.deletedCoverFiles
      }),
      'success'
    );
  } catch (err) {
    uiStore.pushToast(err instanceof ApiClientError ? err.message : t('app.retry'), 'danger');
  } finally {
    resetBusy.value = false;
  }
}

function filterByFailedField(field: BenchmarkCheckField): void {
  failedFieldFilter.value = failedFieldFilter.value === field ? '' : field;
  if (failedFieldFilter.value && verdictFilter.value === 'ok') {
    verdictFilter.value = 'all';
  }
  currentPage.value = 1;
}

function filterByCategoryBucket(catKey: string): void {
  categoryFilter.value = categoryFilter.value === catKey ? '' : catKey;
  currentPage.value = 1;
}

function filterByProfileBucket(profKey: string): void {
  profileFilter.value = profileFilter.value === profKey ? '' : profKey;
  currentPage.value = 1;
}

watch(
  selectedJobId,
  (id) => {
    categoryFilter.value = '';
    profileFilter.value = '';
    failedFieldFilter.value = '';
    currentPage.value = 1;
    loadReviewsForJob(id);
    void loadExistingGradeForJob(id);
  },
  { immediate: true }
);

watch([verdictFilter, inputModeFilter, categoryFilter, profileFilter, failedFieldFilter, searchQuery, pageSize], () => {
  currentPage.value = 1;
});

// Rafraîchissement automatique en douceur pendant qu'un import CSV tourne via SSE
watch(
  () => [liveImportJob.value?.id, liveImportJob.value?.status, liveImportJob.value?.progressDone] as const,
  ([id, status, done], prev) => {
    if (!id) return;
    const prevStatus = prev?.[1];
    const prevDone = prev?.[2] ?? 0;
    if (status === 'done' && prevStatus !== 'done') {
      void loadBenchmarks(id);
    } else if (status === 'running' && typeof done === 'number' && done > prevDone && done % 10 === 0) {
      void loadBenchmarks(selectedJobId.value || id);
    }
  }
);

onMounted(() => {
  void loadBenchmarks();
});
</script>

<template>
  <div class="ds-stack">
    <!-- Barre d'actions & sélection de lot -->
    <div class="ds-card ds-stack">
      <div class="ds-row ds-row--between bench-header">
        <div class="ds-stack bench-title-group">
          <div class="ds-row">
            <h2>{{ t('admin.benchmarkTitle') }}</h2>
            <span class="ds-badge ds-badge--accent">{{ t('admin.benchmarkTempBadge') }}</span>
          </div>
          <p class="ds-text-muted">{{ t('admin.benchmarkSubtitle') }}</p>
        </div>

        <div class="ds-row bench-actions">
          <input
            ref="fileInputRef"
            type="file"
            accept=".csv,.tsv,.txt,.json,.xlsx"
            class="bench-hidden-input"
            @change="handleFileSelected"
          />
          <input
            ref="gtFileInputRef"
            type="file"
            accept=".csv,.tsv,.txt"
            class="bench-hidden-input"
            @change="handleGroundTruthSelected"
          />
          <button
            type="button"
            class="ds-btn ds-btn--primary ds-btn--sm"
            :disabled="uploading"
            @click="triggerFilePicker"
          >
            {{ uploading ? t('admin.benchmarkUploadingBtn') : t('admin.benchmarkUploadBtn') }}
          </button>
          <button
            v-if="selectedJob && selectedJob.items.length > 0"
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="gradingBusy"
            @click="triggerGroundTruthPicker"
          >
            {{ gradingBusy ? t('admin.benchmarkGradingBtn') : t('admin.benchmarkUploadGroundTruthBtn') }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="loading"
            @click="loadBenchmarks()"
          >
            {{ loading ? t('app.loading') : t('admin.benchmarkRefreshBtn') }}
          </button>
          <button
            v-if="selectedJob && selectedJob.items.length > 0"
            type="button"
            class="ds-btn ds-btn--sm"
            @click="handleCopyAnomalies"
          >
            {{ gradedReport ? t('admin.benchmarkCopyFullReportBtn') : t('admin.benchmarkCopyAnomaliesBtn') }}
          </button>
          <button
            v-if="selectedJob && selectedJob.items.length > 0"
            type="button"
            class="ds-btn ds-btn--ghost ds-btn--sm"
            @click="handleExportJson"
          >
            {{ t('admin.benchmarkExportJsonBtn') }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--danger ds-btn--sm"
            @click="openResetModal"
          >
            {{ t('admin.benchmarkResetDbBtn') }}
          </button>
        </div>
      </div>

      <!-- Sélecteur de lot -->
      <div v-if="benchmarkJobs.length > 0" class="ds-row bench-batch-row">
        <label for="admin-bench-batch-select" class="ds-label">{{ t('admin.benchmarkBatchLabel') }}</label>
        <select id="admin-bench-batch-select" v-model="selectedJobId" class="ds-input bench-batch-select">
          <option v-for="job in benchmarkJobs" :key="job.id" :value="job.id">
            {{
              t('admin.benchmarkBatchOption', {
                filename: job.filename,
                done: job.progressDone,
                total: job.progressTotal,
                status: getJobStatusLabel(job.status)
              })
            }}
            — {{ job.createdAt.slice(0, 16).replace('T', ' ') }}
          </option>
        </select>
      </div>

      <!-- Bandeau progression import SSE -->
      <div v-if="isLiveImportRunning && liveImportJob" class="ds-banner ds-banner--warning bench-progress-banner">
        <div class="ds-row ds-row--between">
          <strong>
            {{
              t('admin.benchmarkImportProgress', {
                done: liveImportJob.progressDone,
                total: liveImportJob.progressTotal || 1
              })
            }}
          </strong>
          <span>
            {{ Math.round((liveImportJob.progressDone / Math.max(1, liveImportJob.progressTotal)) * 100) }}%
          </span>
        </div>
        <progress
          class="bench-progress-bar"
          :value="liveImportJob.progressDone"
          :max="Math.max(1, liveImportJob.progressTotal)"
        />
      </div>

      <!-- Bandeau enrichissement séries/couvertures en cours -->
      <div v-if="activeCatalogJobsCount > 0" class="ds-banner ds-banner--success">
        {{ t('admin.benchmarkBackgroundEnriching', { count: activeCatalogJobsCount }) }}
      </div>

      <!-- Indice corrigé si non chargé -->
      <p v-if="selectedJob && selectedJob.items.length > 0 && !gradedReport" class="ds-text-muted">
        {{ t('admin.benchmarkGradeHintNoFile') }}
      </p>
    </div>

    <!-- Panneau Correction Automatique (lorsqu'un CSV corrigé est chargé) -->
    <div v-if="gradedReport" class="ds-card ds-stack">
      <div class="ds-row ds-row--between bench-header">
        <div class="ds-stack bench-title-group">
          <h3>{{ t('admin.benchmarkGradedTitle') }}</h3>
          <p class="ds-text-muted">
            {{
              t('admin.benchmarkGradedMeta', {
                filename: gradedReport.groundTruthFilename,
                mode:
                  gradedReport.alignmentMode === 'fichier_origine'
                    ? t('admin.benchmarkAlignByFile')
                    : t('admin.benchmarkAlignByLine'),
                date: gradedReport.generatedAt.slice(0, 19).replace('T', ' '),
                reportFile: latestReportFilename ?? `report-${gradedReport.jobId}.md`
              })
            }}
          </p>
        </div>

        <div class="ds-row bench-actions">
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :disabled="gradingBusy"
            @click="handleRegrade"
          >
            {{ gradingBusy ? t('admin.benchmarkGradingBtn') : t('admin.benchmarkRegradeBtn') }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--primary ds-btn--sm"
            @click="handleCopyGradedMarkdown"
          >
            {{ t('admin.benchmarkCopyFullReportBtn') }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            @click="handleDownloadGradedMarkdown"
          >
            {{ t('admin.benchmarkDownloadReportBtn') }}
          </button>
        </div>
      </div>

      <div class="bench-kpi-grid">
        <div class="ds-panel bench-kpi bench-kpi--static">
          <span class="ds-text-muted">{{ t('admin.benchmarkScoreResolved') }}</span>
          <strong>{{ gradedReport.totals.resolvedRatePct }}%</strong>
          <span class="ds-text-muted">
            {{ gradedReport.totals.resolvedRows }} / {{ gradedReport.totals.evaluatedRows }}
          </span>
        </div>
        <div class="ds-panel bench-kpi bench-kpi--ok bench-kpi--static">
          <span class="ds-text-muted">{{ t('admin.benchmarkScorePerfect') }}</span>
          <strong>{{ gradedReport.totals.perfectRatePct }}%</strong>
          <span class="ds-text-muted">
            {{ gradedReport.totals.perfectRows }} / {{ gradedReport.totals.evaluatedRows }}
          </span>
        </div>
        <div class="ds-panel bench-kpi bench-kpi--static">
          <span class="ds-text-muted">{{ t('admin.benchmarkScoreFieldAccuracy') }}</span>
          <strong>{{ gradedReport.totals.fieldAccuracyPct }}%</strong>
        </div>
        <div class="ds-panel bench-kpi bench-kpi--warning bench-kpi--static">
          <span class="ds-text-muted">{{ t('admin.benchmarkScorePartial') }}</span>
          <strong>{{ gradedReport.totals.partialRows }}</strong>
        </div>
        <div class="ds-panel bench-kpi bench-kpi--danger bench-kpi--static">
          <span class="ds-text-muted">{{ t('admin.benchmarkScoreFailed') }}</span>
          <strong>{{ gradedReport.totals.failedRows }}</strong>
        </div>
      </div>

      <!-- Précision par champ (cliquable pour filtrer par champ en écart) -->
      <details open class="ds-panel">
        <summary class="bench-details-summary">
          {{
            t('admin.benchmarkBreakdownFieldsTitle', {
              count: gradedReport.fieldStats.filter((f) => f.evaluated > 0).length
            })
          }}
        </summary>
        <div class="bench-breakdown-grid">
          <button
            v-for="fs in gradedReport.fieldStats.filter((f) => f.evaluated > 0)"
            :key="fs.field"
            type="button"
            class="bench-stat-chip"
            :class="{
              'bench-stat-chip--active': failedFieldFilter === fs.field,
              'bench-stat-chip--ok': fs.failed === 0,
              'bench-stat-chip--warn': fs.failed > 0
            }"
            @click="filterByFailedField(fs.field)"
          >
            <span>{{ getFieldCheckLabel(fs.field) }}</span>
            <strong>{{ fs.passRatePct }}%</strong>
            <span class="ds-text-muted">{{ fs.passed }}/{{ fs.evaluated }}</span>
          </button>
        </div>
      </details>

      <!-- Résultats par catégorie -->
      <details class="ds-panel">
        <summary class="bench-details-summary">
          {{ t('admin.benchmarkBreakdownCategoriesTitle', { count: gradedReport.byCategory.length }) }}
        </summary>
        <div class="bench-breakdown-grid">
          <button
            v-for="cat in gradedReport.byCategory"
            :key="cat.key"
            type="button"
            class="bench-stat-chip"
            :class="{ 'bench-stat-chip--active': categoryFilter === cat.key }"
            @click="filterByCategoryBucket(cat.key)"
          >
            <span>{{ cat.label }}</span>
            <strong>{{ cat.perfectRatePct }}% / {{ cat.resolvedRatePct }}%</strong>
            <span class="ds-text-muted">
              {{ cat.perfect }}✓ · {{ cat.partial }}⚠ · {{ cat.failed }}✕ ({{ cat.total }})
            </span>
          </button>
        </div>
      </details>

      <!-- Résultats par profil d'entrée -->
      <details class="ds-panel">
        <summary class="bench-details-summary">
          {{ t('admin.benchmarkBreakdownProfilesTitle', { count: gradedReport.byProfile.length }) }}
        </summary>
        <div class="bench-breakdown-grid">
          <button
            v-for="prof in gradedReport.byProfile"
            :key="prof.key"
            type="button"
            class="bench-stat-chip"
            :class="{ 'bench-stat-chip--active': profileFilter === prof.key }"
            @click="filterByProfileBucket(prof.key)"
          >
            <span class="bench-mono">{{ prof.key }}</span>
            <strong>{{ prof.perfectRatePct }}% / {{ prof.resolvedRatePct }}%</strong>
            <span class="ds-text-muted">
              {{ prof.perfect }}✓ · {{ prof.partial }}⚠ · {{ prof.failed }}✕ ({{ prof.total }})
            </span>
          </button>
        </div>
      </details>
    </div>

    <!-- État vide -->
    <div v-if="!loading && benchmarkJobs.length === 0" class="ds-card ds-stack">
      <strong>{{ t('admin.benchmarkEmptyTitle') }}</strong>
      <p class="ds-text-muted">{{ t('admin.benchmarkEmptyHint') }}</p>
    </div>

    <!-- Tableau de bord du lot sélectionné -->
    <template v-else-if="selectedJob">
      <!-- KPIs cliquables -->
      <div class="bench-kpi-grid">
        <button
          type="button"
          class="ds-card bench-kpi"
          :class="{ 'bench-kpi--active': verdictFilter === 'all' }"
          @click="verdictFilter = 'all'"
        >
          <span class="ds-text-muted">{{ t('admin.benchmarkKpiTotal') }}</span>
          <strong>{{ selectedJob.summary.totalRows }}</strong>
        </button>

        <button
          type="button"
          class="ds-card bench-kpi bench-kpi--ok"
          :class="{ 'bench-kpi--active': verdictFilter === 'ok' }"
          @click="verdictFilter = verdictFilter === 'ok' ? 'all' : 'ok'"
        >
          <span class="ds-text-muted">{{ gradedReport ? t('admin.benchmarkVerdictPerfect') : t('admin.benchmarkKpiOk') }}</span>
          <strong>{{ okCountDisplay }}</strong>
        </button>

        <button
          type="button"
          class="ds-card bench-kpi bench-kpi--warning"
          :class="{ 'bench-kpi--active': verdictFilter === 'warning' }"
          @click="verdictFilter = verdictFilter === 'warning' ? 'all' : 'warning'"
        >
          <span class="ds-text-muted">{{ gradedReport ? t('admin.benchmarkScorePartial') : t('admin.benchmarkKpiWarning') }}</span>
          <strong>{{ warningCountDisplay }}</strong>
        </button>

        <button
          type="button"
          class="ds-card bench-kpi bench-kpi--danger"
          :class="{ 'bench-kpi--active': verdictFilter === 'failed' }"
          @click="verdictFilter = verdictFilter === 'failed' ? 'all' : 'failed'"
        >
          <span class="ds-text-muted">{{ t('admin.benchmarkKpiFailed') }}</span>
          <strong>{{ failedCountDisplay }}</strong>
        </button>

        <button
          type="button"
          class="ds-card bench-kpi bench-kpi--warning"
          :class="{ 'bench-kpi--active': verdictFilter === 'no_cover' }"
          @click="verdictFilter = verdictFilter === 'no_cover' ? 'all' : 'no_cover'"
        >
          <span class="ds-text-muted">{{ t('admin.benchmarkKpiNoCover') }}</span>
          <strong>{{ selectedJob.summary.missingCoverCount }}</strong>
        </button>

        <button
          type="button"
          class="ds-card bench-kpi bench-kpi--danger"
          :class="{ 'bench-kpi--active': verdictFilter === 'flagged_down' }"
          @click="verdictFilter = verdictFilter === 'flagged_down' ? 'all' : 'flagged_down'"
        >
          <span class="ds-text-muted">{{ t('admin.benchmarkKpiFlagged') }}</span>
          <strong>{{ flaggedDownCount }}</strong>
        </button>

        <div class="ds-card bench-kpi bench-kpi--static">
          <span class="ds-text-muted">{{ t('admin.benchmarkKpiChannels') }}</span>
          <strong>{{ selectedJob.summary.resolvedByIsbnCount }} / {{ selectedJob.summary.resolvedBySearchCount }}</strong>
        </div>

        <div class="ds-card bench-kpi bench-kpi--static">
          <span class="ds-text-muted">{{ t('admin.benchmarkKpiAvgMs') }}</span>
          <strong>{{ selectedJob.summary.avgDurationMs }} ms</strong>
        </div>
      </div>

      <!-- Barre de filtres -->
      <div class="ds-card ds-stack">
        <div class="ds-chips">
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :class="{ 'ds-btn--primary': verdictFilter === 'all' }"
            @click="verdictFilter = 'all'"
          >
            {{ t('admin.benchmarkFilterAll', { count: selectedJob.items.length }) }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :class="{ 'ds-btn--primary': verdictFilter === 'warning' }"
            @click="verdictFilter = 'warning'"
          >
            {{ t('admin.benchmarkFilterWarning', { count: warningCountDisplay }) }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :class="{ 'ds-btn--primary': verdictFilter === 'failed' }"
            @click="verdictFilter = 'failed'"
          >
            {{ t('admin.benchmarkFilterFailed', { count: failedCountDisplay }) }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :class="{ 'ds-btn--primary': verdictFilter === 'no_cover' }"
            @click="verdictFilter = 'no_cover'"
          >
            {{ t('admin.benchmarkFilterNoCover', { count: selectedJob.summary.missingCoverCount }) }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :class="{ 'ds-btn--primary': verdictFilter === 'flagged_down' }"
            @click="verdictFilter = 'flagged_down'"
          >
            {{ t('admin.benchmarkFilterFlaggedDown', { count: flaggedDownCount }) }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :class="{ 'ds-btn--primary': verdictFilter === 'flagged_up' }"
            @click="verdictFilter = 'flagged_up'"
          >
            {{ t('admin.benchmarkFilterFlaggedUp', { count: flaggedUpCount }) }}
          </button>
          <button
            type="button"
            class="ds-btn ds-btn--sm"
            :class="{ 'ds-btn--primary': verdictFilter === 'ok' }"
            @click="verdictFilter = 'ok'"
          >
            {{ t('admin.benchmarkFilterOk', { count: okCountDisplay }) }}
          </button>
        </div>

        <div class="ds-row bench-filter-inputs">
          <input
            v-model="searchQuery"
            type="search"
            class="ds-input bench-search-input"
            :placeholder="t('admin.benchmarkSearchPlaceholder')"
          />

          <select v-model="inputModeFilter" class="ds-input bench-select">
            <option value="all">{{ t('admin.benchmarkInputModeAll') }}</option>
            <option value="with_isbn">{{ t('admin.benchmarkInputModeWithIsbn') }}</option>
            <option value="without_isbn">{{ t('admin.benchmarkInputModeWithoutIsbn') }}</option>
          </select>

          <select v-if="availableCategories.length > 0" v-model="categoryFilter" class="ds-input bench-select">
            <option value="">{{ t('admin.benchmarkCategoryAll') }}</option>
            <option v-for="cat in availableCategories" :key="cat" :value="cat">{{ cat }}</option>
          </select>

          <select v-if="availableProfiles.length > 0" v-model="profileFilter" class="ds-input bench-select">
            <option value="">{{ t('admin.benchmarkFilterProfileAll') }}</option>
            <option v-for="prof in availableProfiles" :key="prof" :value="prof">{{ prof }}</option>
          </select>

          <select v-if="gradedReport" v-model="failedFieldFilter" class="ds-input bench-select">
            <option value="">{{ t('admin.benchmarkFilterFailedFieldAll') }}</option>
            <option
              v-for="fs in gradedReport.fieldStats.filter((f) => f.failed > 0)"
              :key="fs.field"
              :value="fs.field"
            >
              {{ getFieldCheckLabel(fs.field) }} ({{ fs.failed }})
            </option>
          </select>

          <select v-model.number="pageSize" class="ds-input bench-select-sm">
            <option :value="25">{{ t('admin.benchmarkPageSizeOption', { size: 25 }) }}</option>
            <option :value="50">{{ t('admin.benchmarkPageSizeOption', { size: 50 }) }}</option>
            <option :value="100">{{ t('admin.benchmarkPageSizeOption', { size: 100 }) }}</option>
            <option :value="250">{{ t('admin.benchmarkPageSizeOption', { size: 250 }) }}</option>
          </select>

          <span class="ds-text-muted">
            {{ t('admin.benchmarkShownCount', { shown: filteredItems.length, total: selectedJob.items.length }) }}
          </span>
        </div>
      </div>

      <!-- Import antérieur sans trace détaillée -->
      <div v-if="selectedJob.items.length === 0 && selectedJob.status === 'done'" class="ds-card ds-text-muted">
        {{ t('admin.benchmarkLegacyJobHint') }}
      </div>

      <!-- Aucune ligne correspondant aux filtres -->
      <div v-else-if="filteredItems.length === 0" class="ds-card ds-text-muted">
        {{ t('admin.benchmarkFilteredEmpty') }}
      </div>

      <!-- Tableau comparatif responsive (sticky headers + passage en cartes via @container) -->
      <template v-else>
        <PaginationBar :page="currentPage" :total-pages="totalPages" @update:page="currentPage = $event" />

        <div class="ds-card bench-table-card">
          <div
            tabindex="0"
            role="region"
            aria-labelledby="admin-benchmark-table-caption"
            class="bench-table-wrapper"
          >
            <table class="bench-table" :style="tableCssVars">
              <caption id="admin-benchmark-table-caption" class="bench-sr-only">
                {{ t('admin.benchmarkTableCaption') }}
              </caption>
              <thead>
                <tr>
                  <th scope="col" class="bench-col-num">{{ t('admin.benchmarkColRow') }}</th>
                  <th scope="col" class="bench-col-input">{{ t('admin.benchmarkColInput') }}</th>
                  <th scope="col" class="bench-col-output">{{ t('admin.benchmarkColOutput') }}</th>
                  <th scope="col" class="bench-col-verdict">{{ t('admin.benchmarkColVerdict') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="item in paginatedItems"
                  :key="item.rowNumber"
                  class="bench-row"
                  :class="`bench-row--${getRowVisualState(item)}`"
                >
                  <th scope="row" class="bench-cell-num">
                    <div>#{{ gradedByRowNumber.get(item.rowNumber)?.dataLineNumber ?? item.rowNumber }}</div>
                    <div
                      v-if="gradedByRowNumber.get(item.rowNumber)?.expected.fichierOrigine"
                      class="bench-origin-sub"
                    >
                      {{ gradedByRowNumber.get(item.rowNumber)?.expected.fichierOrigine }}:{{
                        gradedByRowNumber.get(item.rowNumber)?.expected.ligneFichier ?? '?'
                      }}
                    </div>
                  </th>

                  <!-- Colonne 1 : Entrée CSV + Attendu (Corrigé) -->
                  <td class="bench-cell-input">
                    <div class="bench-badges-row">
                      <span class="ds-badge ds-badge--accent">
                        {{
                          gradedByRowNumber.get(item.rowNumber)?.expected.profilEntree ??
                          getProfileLabel(item.input.inputProfile)
                        }}
                      </span>
                      <span
                        v-if="gradedByRowNumber.get(item.rowNumber)?.expected.categorie || item.input.testCategory"
                        class="ds-badge"
                      >
                        {{ gradedByRowNumber.get(item.rowNumber)?.expected.categorie || item.input.testCategory }}
                      </span>
                      <span v-if="gradedByRowNumber.get(item.rowNumber)?.expected.media" class="ds-badge">
                        {{ gradedByRowNumber.get(item.rowNumber)?.expected.media }}
                      </span>
                      <span v-if="item.input.isIntegral === true" class="ds-badge bench-badge--integral">
                        {{ t('admin.benchmarkIntegralBadge') }}
                      </span>
                    </div>

                    <dl class="bench-dl">
                      <template v-if="item.input.isbn">
                        <dt>{{ t('admin.benchmarkFieldIsbn') }}</dt>
                        <dd class="bench-mono">{{ item.input.isbn }}</dd>
                      </template>
                      <template v-if="item.input.title">
                        <dt>{{ t('admin.benchmarkFieldTitle') }}</dt>
                        <dd><strong>{{ item.input.title }}</strong></dd>
                      </template>
                      <template v-if="item.input.series">
                        <dt>{{ t('admin.benchmarkFieldSeries') }}</dt>
                        <dd>{{ item.input.series }}</dd>
                      </template>
                      <template v-if="item.input.volumeNumber">
                        <dt>{{ t('admin.benchmarkFieldVolume') }}</dt>
                        <dd>{{ item.input.volumeNumber }}</dd>
                      </template>
                      <template v-if="item.input.author">
                        <dt>{{ t('admin.benchmarkFieldAuthor') }}</dt>
                        <dd>{{ item.input.author }}</dd>
                      </template>
                      <template v-if="item.input.publisher">
                        <dt>{{ t('admin.benchmarkFieldPublisher') }}</dt>
                        <dd>{{ item.input.publisher }}</dd>
                      </template>
                      <template v-if="item.input.includedVolumes.length > 0">
                        <dt>{{ t('admin.benchmarkFieldIncluded') }}</dt>
                        <dd>{{ item.input.includedVolumes.join(', ') }}</dd>
                      </template>
                    </dl>

                    <!-- Bloc Attendu (si CSV de correction chargé) -->
                    <div v-if="gradedByRowNumber.get(item.rowNumber)" class="bench-expected-box">
                      <div class="bench-expected-title">{{ t('admin.benchmarkExpectedHeader') }}</div>
                      <dl class="bench-dl">
                        <template v-if="gradedByRowNumber.get(item.rowNumber)?.expected.titreAttendu">
                          <dt>{{ t('admin.benchmarkFieldTitle') }}</dt>
                          <dd>{{ gradedByRowNumber.get(item.rowNumber)?.expected.titreAttendu }}</dd>
                        </template>
                        <template v-if="gradedByRowNumber.get(item.rowNumber)?.expected.serieAttendue">
                          <dt>{{ t('admin.benchmarkFieldSeries') }}</dt>
                          <dd>{{ gradedByRowNumber.get(item.rowNumber)?.expected.serieAttendue }}</dd>
                        </template>
                        <template v-if="gradedByRowNumber.get(item.rowNumber)?.expected.tomeAttendu">
                          <dt>{{ t('admin.benchmarkFieldVolume') }}</dt>
                          <dd>{{ gradedByRowNumber.get(item.rowNumber)?.expected.tomeAttendu }}</dd>
                        </template>
                        <template v-if="gradedByRowNumber.get(item.rowNumber)?.expected.auteurAttendu">
                          <dt>{{ t('admin.benchmarkFieldAuthor') }}</dt>
                          <dd>{{ gradedByRowNumber.get(item.rowNumber)?.expected.auteurAttendu }}</dd>
                        </template>
                        <template v-if="gradedByRowNumber.get(item.rowNumber)?.expected.editeurAttendu">
                          <dt>{{ t('admin.benchmarkFieldPublisher') }}</dt>
                          <dd>{{ gradedByRowNumber.get(item.rowNumber)?.expected.editeurAttendu }}</dd>
                        </template>
                        <template v-if="gradedByRowNumber.get(item.rowNumber)?.expected.collectionEditoriale">
                          <dt>{{ t('admin.benchmarkCollectionTrapLabel') }}</dt>
                          <dd>{{ gradedByRowNumber.get(item.rowNumber)?.expected.collectionEditoriale }}</dd>
                        </template>
                      </dl>
                      <p
                        v-if="gradedByRowNumber.get(item.rowNumber)?.expected.regleVerification"
                        class="bench-qa-rule"
                      >
                        <strong>{{ t('admin.benchmarkQaRuleLabel') }} :</strong>
                        {{ gradedByRowNumber.get(item.rowNumber)?.expected.regleVerification }}
                      </p>
                    </div>
                  </td>

                  <!-- Colonne 2 : Résultat algorithme (live DB) -->
                  <td class="bench-cell-output">
                    <div v-if="item.status === 'unmatched' || !getEffectiveOutput(item)" class="bench-unmatched">
                      <span class="ds-badge bench-badge--danger">
                        {{
                          item.unmatchedReason === 'isbn_not_found'
                            ? t('admin.benchmarkReasonIsbnNotFound')
                            : t('admin.benchmarkReasonCatalogNotFound')
                        }}
                      </span>
                      <span class="ds-text-muted bench-mono">{{ item.durationMs }} ms</span>
                    </div>

                    <div v-else class="bench-output-layout">
                      <div class="bench-cover-slot">
                        <img
                          v-if="getEffectiveOutput(item)?.coverUrl"
                          :src="getEffectiveOutput(item)?.coverUrl ?? ''"
                          :alt="getEffectiveOutput(item)?.title ?? ''"
                          class="bench-cover-img"
                          loading="lazy"
                        />
                        <div v-else class="bench-cover-missing">
                          {{ t('admin.benchmarkNoCoverLabel') }}
                        </div>
                      </div>

                      <div class="bench-output-details">
                        <div class="bench-output-title-line">
                          <router-link
                            v-if="item.resolvedBookId"
                            :to="`/book/${item.resolvedBookId}`"
                            target="_blank"
                            rel="noopener"
                            class="bench-book-link"
                          >
                            {{ getEffectiveOutput(item)?.title }}
                          </router-link>
                          <strong v-else>{{ getEffectiveOutput(item)?.title }}</strong>
                        </div>

                        <div class="bench-badges-row">
                          <router-link
                            v-if="getEffectiveOutput(item)?.seriesId && getEffectiveOutput(item)?.seriesName"
                            :to="`/series/${getEffectiveOutput(item)?.seriesId}`"
                            target="_blank"
                            rel="noopener"
                            class="ds-badge ds-badge--accent bench-series-link"
                          >
                            {{ getEffectiveOutput(item)?.seriesName }}
                            <template v-if="item.live">
                              · {{ t('admin.benchmarkSeriesCountBadge', { count: item.live.seriesTotalVolumes }) }}
                              <template v-if="item.live.seriesExpanded">
                                · {{ t('admin.benchmarkSeriesExpandedBadge') }}
                              </template>
                            </template>
                          </router-link>

                          <span
                            v-if="getEffectiveOutput(item)?.isIntegral"
                            class="ds-badge bench-badge--integral"
                          >
                            {{ t('admin.benchmarkIntegralBadge') }}
                            <template v-if="(getEffectiveOutput(item)?.includedVolumes.length ?? 0) > 0">
                              ({{ getEffectiveOutput(item)?.includedVolumes.join(', ') }})
                            </template>
                          </span>
                          <span
                            v-else-if="getEffectiveOutput(item)?.volumeNumber !== null"
                            class="ds-badge"
                          >
                            {{ t('admin.benchmarkVolumeBadge', { vol: getEffectiveOutput(item)?.volumeNumber ?? '' }) }}
                          </span>

                          <span class="ds-badge">{{ getEffectiveOutput(item)?.mainCategory }}</span>
                        </div>

                        <div class="bench-meta-line ds-text-muted">
                          <span v-if="(getEffectiveOutput(item)?.authors.length ?? 0) > 0">
                            {{ getEffectiveOutput(item)?.authors.join(', ') }}
                          </span>
                          <span v-if="getEffectiveOutput(item)?.publisher">
                            · {{ getEffectiveOutput(item)?.publisher }}
                          </span>
                        </div>

                        <div class="bench-tech-line ds-text-muted">
                          <span v-if="item.resolvedIsbn13" class="bench-mono">{{ item.resolvedIsbn13 }}</span>
                          <span>· {{ getChannelLabel(item.resolutionChannel) }}</span>
                          <span class="bench-mono">· {{ item.durationMs }} ms</span>
                          <span v-if="item.live && item.live.editionsCount > 1">
                            · {{ t('admin.benchmarkEditionsCount', { count: item.live.editionsCount }) }}
                          </span>
                        </div>
                      </div>
                    </div>
                  </td>

                  <!-- Colonne 3 : Verdict, écarts champ par champ & revue humaine -->
                  <td class="bench-cell-verdict">
                    <div class="bench-verdict-stack">
                      <div class="bench-badges-row">
                        <span
                          class="ds-badge"
                          :class="{
                            'bench-badge--ok': getRowVisualState(item) === 'ok',
                            'bench-badge--warning': getRowVisualState(item) === 'warning',
                            'bench-badge--danger': getRowVisualState(item) === 'failed'
                          }"
                        >
                          <template v-if="gradedByRowNumber.get(item.rowNumber)">
                            {{
                              gradedByRowNumber.get(item.rowNumber)?.verdict === 'perfect'
                                ? t('admin.benchmarkVerdictPerfect')
                                : gradedByRowNumber.get(item.rowNumber)?.verdict === 'partial'
                                  ? t('admin.benchmarkVerdictPartial', {
                                      passed: gradedByRowNumber.get(item.rowNumber)?.passedChecksCount ?? 0,
                                      total: gradedByRowNumber.get(item.rowNumber)?.evaluatedChecksCount ?? 0
                                    })
                                  : t('admin.benchmarkVerdictFailed')
                            }}
                          </template>
                          <template v-else>
                            {{
                              item.verdict === 'ok'
                                ? t('admin.benchmarkVerdictOk')
                                : item.verdict === 'warning'
                                  ? t('admin.benchmarkVerdictWarning')
                                  : t('admin.benchmarkVerdictFailed')
                            }}
                          </template>
                        </span>
                      </div>

                      <!-- Écarts détaillés (mode Corrigé) -->
                      <div
                        v-if="gradedByRowNumber.get(item.rowNumber)"
                        class="bench-diffs-list"
                      >
                        <div
                          v-for="chk in gradedByRowNumber
                            .get(item.rowNumber)!
                            .checks.filter((c) => c.status === 'fail')"
                          :key="chk.field"
                          class="bench-diff-item"
                        >
                          <strong>{{ getFieldCheckLabel(chk.field) }}</strong>
                          <div>
                            {{ t('admin.benchmarkDiffExpectedShort') }}: {{ chk.expected }}
                          </div>
                          <div>
                            {{ t('admin.benchmarkDiffActualShort') }}: {{ chk.actual }}
                          </div>
                        </div>
                      </div>

                      <!-- Alertes heuristiques (mode sans corrigé) -->
                      <div v-else-if="item.warnings.length > 0" class="bench-warnings-list">
                        <span
                          v-for="w in item.warnings"
                          :key="w"
                          class="ds-badge bench-badge--warning"
                        >
                          {{ getWarningLabel(w) }}
                        </span>
                      </div>

                      <div class="bench-review-controls">
                        <button
                          type="button"
                          class="ds-btn ds-btn--sm bench-vote-btn"
                          :class="{ 'bench-vote-btn--up': getReview(item.rowNumber).vote === 'up' }"
                          :title="t('admin.benchmarkThumbUpTitle')"
                          :aria-pressed="getReview(item.rowNumber).vote === 'up'"
                          @click="toggleVote(item.rowNumber, 'up')"
                        >
                          👍
                        </button>
                        <button
                          type="button"
                          class="ds-btn ds-btn--sm bench-vote-btn"
                          :class="{ 'bench-vote-btn--down': getReview(item.rowNumber).vote === 'down' }"
                          :title="t('admin.benchmarkThumbDownTitle')"
                          :aria-pressed="getReview(item.rowNumber).vote === 'down'"
                          @click="toggleVote(item.rowNumber, 'down')"
                        >
                          👎
                        </button>
                      </div>

                      <input
                        type="text"
                        class="ds-input bench-note-input"
                        :value="getReview(item.rowNumber).note"
                        :placeholder="t('admin.benchmarkNotePlaceholder')"
                        @input="updateNote(item.rowNumber, ($event.target as HTMLInputElement).value)"
                      />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <PaginationBar :page="currentPage" :total-pages="totalPages" @update:page="currentPage = $event" />
      </template>
    </template>

    <!-- Modale double confirmation : Vider la DB livres -->
    <BaseModal
      :open="resetModalOpen"
      :title="t('admin.benchmarkResetModalTitle')"
      @close="resetModalOpen = false"
    >
      <div class="ds-stack">
        <div class="ds-banner ds-banner--danger">
          {{ t('admin.benchmarkResetModalWarning') }}
        </div>
        <p class="ds-text-muted">{{ t('admin.benchmarkResetModalPreserved') }}</p>
        <p v-if="activeCatalogJobsCount > 0 || isLiveImportRunning" class="ds-banner ds-banner--warning">
          {{
            t('admin.benchmarkResetModalActiveJobsHint', {
              count: activeCatalogJobsCount + (isLiveImportRunning ? 1 : 0)
            })
          }}
        </p>

        <div class="ds-field">
          <label for="admin-bench-reset-confirm" class="ds-label">
            {{ t('admin.benchmarkResetConfirmLabel') }}
          </label>
          <input
            id="admin-bench-reset-confirm"
            v-model="resetConfirmText"
            type="text"
            class="ds-input"
            autocomplete="off"
            :placeholder="t('admin.benchmarkResetConfirmPlaceholder')"
          />
        </div>
      </div>

      <template #footer>
        <button type="button" class="ds-btn" :disabled="resetBusy" @click="resetModalOpen = false">
          {{ t('app.cancel') }}
        </button>
        <button
          type="button"
          class="ds-btn ds-btn--danger"
          :disabled="resetBusy || resetConfirmText.trim() !== 'VIDER'"
          @click="confirmResetCatalog"
        >
          {{ resetBusy ? t('app.loading') : t('admin.benchmarkResetConfirmBtn') }}
        </button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.bench-header {
  align-items: flex-start;
  gap: var(--space-4);
}

.bench-title-group {
  gap: var(--space-1);
  flex: 1;
  min-width: 240px;
}

.bench-actions {
  gap: var(--space-2);
}

.bench-hidden-input {
  display: none;
}

.bench-batch-row {
  gap: var(--space-3);
}

.bench-batch-select {
  flex: 1;
  min-width: 220px;
}

.bench-progress-banner {
  margin-bottom: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.bench-progress-bar {
  width: 100%;
  height: 8px;
  accent-color: var(--accent);
}

.bench-details-summary {
  cursor: pointer;
  font-weight: 700;
  color: var(--text-primary);
}

.bench-breakdown-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.bench-stat-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 0.82rem;
  text-align: left;
  cursor: pointer;
}

.bench-stat-chip--ok strong {
  color: var(--success-text);
}

.bench-stat-chip--warn strong {
  color: var(--warning-text);
}

.bench-stat-chip--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.bench-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: var(--space-2);
}

.bench-kpi {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.bench-kpi--static {
  cursor: default;
}

.bench-kpi strong {
  font-size: 1.25rem;
  color: var(--accent);
}

.bench-kpi--ok strong {
  color: var(--success-text);
}

.bench-kpi--warning strong {
  color: var(--warning-text);
}

.bench-kpi--danger strong {
  color: var(--danger);
}

.bench-kpi--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.bench-filter-inputs {
  gap: var(--space-2);
}

.bench-search-input {
  flex: 1;
  min-width: 200px;
}

.bench-select {
  width: auto;
  min-width: 170px;
}

.bench-select-sm {
  width: auto;
  min-width: 115px;
}

.bench-table-card {
  padding: 0;
  overflow: hidden;
}

.bench-table-wrapper {
  overflow: auto;
  max-inline-size: 100%;
  max-block-size: min(74dvh, 780px);
  container-type: inline-size;
}

.bench-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.bench-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.9rem;
}

.bench-table thead {
  position: sticky;
  inset-block-start: 0;
  z-index: 2;
}

.bench-table thead th {
  text-align: left;
  padding: var(--space-3);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 0.82rem;
  font-weight: 700;
  border-bottom: 1px solid var(--border-strong);
  white-space: nowrap;
}

.bench-table tbody th,
.bench-table tbody td {
  padding: var(--space-3);
  vertical-align: top;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
}

.bench-table tbody th {
  position: sticky;
  inset-inline-start: 0;
  z-index: 1;
  width: 66px;
  font-family: var(--font-mono);
  font-size: 0.82rem;
  color: var(--text-muted);
  text-align: left;
}

.bench-origin-sub {
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: 2px;
  word-break: break-all;
}

.bench-row--warning th,
.bench-row--warning td {
  background: var(--bg-surface);
}

.bench-row--failed th,
.bench-row--failed td {
  background: var(--danger-soft);
}

.bench-col-input {
  width: 34%;
}

.bench-col-output {
  width: 38%;
}

.bench-col-verdict {
  width: 24%;
}

.bench-badges-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
}

.bench-dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--space-2);
  margin: 0;
  font-size: 0.84rem;
}

.bench-dl dt {
  color: var(--text-muted);
  font-weight: 600;
  white-space: nowrap;
}

.bench-dl dd {
  margin: 0;
  color: var(--text-primary);
  word-break: break-word;
}

.bench-expected-box {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
}

.bench-expected-title {
  font-size: 0.74rem;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin-bottom: var(--space-1);
}

.bench-qa-rule {
  margin: var(--space-2) 0 0;
  font-size: 0.78rem;
  color: var(--text-secondary);
  line-height: 1.35;
}

.bench-mono {
  font-family: var(--font-mono);
  font-size: 0.8rem;
}

.bench-output-layout {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}

.bench-cover-slot {
  flex-shrink: 0;
  width: 48px;
  height: 68px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
}

.bench-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.bench-cover-missing {
  font-size: 0.68rem;
  font-weight: 600;
  text-align: center;
  color: var(--warning-text);
  background: var(--warning-bg);
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
}

.bench-output-details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.bench-output-title-line {
  font-weight: 700;
  color: var(--text-primary);
  word-break: break-word;
}

.bench-book-link {
  color: var(--accent);
  text-decoration: none;
}

.bench-book-link:hover {
  text-decoration: underline;
}

.bench-series-link {
  text-decoration: none;
}

.bench-meta-line,
.bench-tech-line {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  font-size: 0.82rem;
}

.bench-unmatched {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}

.bench-verdict-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.bench-warnings-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.bench-diffs-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.bench-diff-item {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--warning-bg);
  color: var(--warning-text);
  font-size: 0.78rem;
  line-height: 1.3;
  word-break: break-word;
}

.bench-badge--ok {
  background: var(--success-bg);
  color: var(--success-text);
  border-color: transparent;
}

.bench-badge--warning {
  background: var(--warning-bg);
  color: var(--warning-text);
  border-color: transparent;
}

.bench-badge--danger {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: transparent;
}

.bench-badge--integral {
  background: var(--status-integral-bg);
  color: var(--status-integral-text);
  border-color: transparent;
}

.bench-review-controls {
  display: flex;
  gap: var(--space-2);
}

.bench-vote-btn {
  min-width: 40px;
}

.bench-vote-btn--up {
  background: var(--success-bg);
  border-color: var(--success-text);
  color: var(--success-text);
}

.bench-vote-btn--down {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: var(--danger);
}

.bench-note-input {
  padding: 0.4rem 0.6rem;
  font-size: 0.82rem;
}

@container (width < 760px) {
  .bench-table,
  .bench-table thead,
  .bench-table tbody,
  .bench-table tr,
  .bench-table th,
  .bench-table td {
    display: block;
    width: auto;
  }

  .bench-table thead {
    display: none;
  }

  .bench-table tbody tr {
    margin: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .bench-table tbody th {
    position: sticky;
    inset-block-start: 0;
    z-index: 2;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border-subtle);
    padding: var(--space-2) var(--space-3);
  }

  .bench-table tbody td {
    border-bottom: 1px solid var(--border-subtle);
  }

  .bench-table tbody td:last-child {
    border-bottom: none;
  }

  .bench-table tbody td:nth-child(2)::before {
    content: var(--bench-col-input);
    display: block;
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    text-transform: uppercase;
  }

  .bench-table tbody td:nth-child(3)::before {
    content: var(--bench-col-output);
    display: block;
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    text-transform: uppercase;
  }

  .bench-table tbody td:nth-child(4)::before {
    content: var(--bench-col-verdict);
    display: block;
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    text-transform: uppercase;
  }
}
</style>
