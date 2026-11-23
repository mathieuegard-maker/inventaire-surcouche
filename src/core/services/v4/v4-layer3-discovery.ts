// src/core/services/v4/v4-layer3-discovery.ts
// Couche 3 V4 : Extraction InterMarc BnF et découverte multi-sources parallèle (BnF, Inventaire.io, OpenLibrary, Wikidata, Google Books).

import {
  cleanAuthor,
  cleanPublishDate,
  cleanPublisher,
  cleanSeriesName,
  cleanTitle,
  isBookOrPressEan13,
  isFrancophoneBookIsbn13,
  isNonBookMarcType,
  normalizeSeriesNumber,
  normalizeTextKey,
  parseSeriesFromTitle
} from '../../resolvers/bnf.resolver';
import { parseMarcFields as parseMarcFieldsFromXml } from '../../bibliographic/intermarc-parser';
import { isEditorialOrPublisherCollection } from '../../bibliographic/work-identity';
import { isbnUtil } from '../../utils/isbn.util';
import { getLevenshteinDistance } from '../../utils/string.util';
import { isEditorialPaperbackCollectionName, stripEditorialCollectionSuffixes } from '../../utils/series-matcher.util';
import { PipelineTracer } from '../pipeline-logger.service';
import {
  USER_AGENT_BASE,
  extractAuthorLastNameForBnfCql,
  fetchWithTimeoutAndRetry,
  isGoogleBooksCircuitOpen,
  isIntegralCandidateTitleOrPages,
  isPlausibleVolumeNumberStr,
  isStrictFrenchLanguage,
  tripGoogleBooksCircuit,
  type SeriesVoteCandidate,
  type SisterEditionCandidate,
  type StagingPayload
} from './v4-shared';

export function extractMarcRecordMetadata(
  recXml: string,
  fallbackIsbn?: string
): (SisterEditionCandidate & { _isIntegral?: boolean }) | null {
  const fields = parseMarcFieldsFromXml(recXml);
  if (!fields.length) return null;

  let isbn13 = fallbackIsbn || '';
  let hasPrimaryIsbn = false;
  let title = '';
  let series245 = '';
  let vol245 = '';
  let series460 = '';
  let vol460 = '';
  let ensId460 = '';
  let unnumberedEns = '';
  let unnumberedEnsId = '';
  let series290 = '';
  let vol290 = '';
  let series410 = '';
  let vol410 = '';
  let collectionRaw = '';
  let publisher = '';
  let publishDate = '';
  let pageCount: number | undefined;
  let coverUrl = '';
  let language = '';
  const authors: string[] = [];
  let isDualPages = false;
  let secondTitleHint = '';
  let explicitIntegralTag245 = false;
  let integralOrd245 = '';

  // En INTERMARC-B BnF (intermarcxchange), le code langue (ex: 'fre') se trouve aux positions 31..34 de la zone 008
  const cf008Match = /<(?:[\w-]+:)?controlfield\s+[^>]*tag="008"[^>]*>([^<]*)<\/(?:[\w-]+:)?controlfield>/i.exec(recXml);
  const cf008 = cf008Match ? cf008Match[1] : '';
  if (cf008.length >= 34) {
    const lang008 = cf008.substring(31, 34).trim().toLowerCase();
    if (/^[a-z]{3}$/.test(lang008)) language = lang008;
  }

  for (const f of fields) {
    const getSf = (c: string) => f.subfields.find((s) => s.code === c)?.value || '';
    if (f.tag === '020' || f.tag === '038' || f.tag === '010' || f.tag === '073') {
      const rawIsbn = isbnUtil.normalize(getSf('a'));
      const conv = rawIsbn.length === 10 ? isbnUtil.toIsbn13(rawIsbn) : rawIsbn;
      if (isbnUtil.isValidBookBarcode(conv) && isBookOrPressEan13(conv)) {
        if (!hasPrimaryIsbn || f.tag === '038' || f.tag === '073') {
          isbn13 = conv;
          hasPrimaryIsbn = true;
        }
      }
    } else if (f.tag === '041' || f.tag === '101') {
      const lang = getSf('a').trim().toLowerCase();
      if (/^[a-z]{3}$/.test(lang) && !language) language = lang;
    } else if (f.tag === '950') {
      const coverId = getSf('a');
      if (coverId) {
        coverUrl = `https://catalogue.bnf.fr/couverture?idImage=${coverId}&couverture=1&appName=NE`;
      }
    } else if (f.tag === '245' || f.tag === '200') {
      if (isNonBookMarcType(getSf('d') || getSf('b'))) {
        return null;
      }
      const a = cleanTitle(getSf('a'));
      const b = cleanTitle(getSf('b'));
      const e = cleanTitle(getSf('e'));
      const h = cleanTitle(getSf('h'));
      const i = cleanTitle(getSf('i'));
      const p = cleanTitle(getSf('p'));
      const n = getSf('n');
      const u = getSf('u');
      if (b) secondTitleHint = b;
      const integralSource245 = `${e} ${b} ${i}`.trim();
      if (/\b(?:l['’]?\s*int[ée]grale|int[ée]grale|coffret|omnibus|compil)\b/i.test(integralSource245) && !/\b(?:texte|version)\s+int[ée]grale?\b/i.test(integralSource245)) {
        explicitIntegralTag245 = true;
        integralOrd245 = normalizeSeriesNumber(h || u || n || '');
      }
      if ((p || (i && !explicitIntegralTag245 && normalizeTextKey(i) !== normalizeTextKey(a))) && a) {
        const subTitle = p || i;
        series245 = series245 || cleanSeriesName(a);
        title = subTitle;
        if (n || u || (!explicitIntegralTag245 && h)) {
          vol245 = vol245 || normalizeSeriesNumber(n || u || h);
        }
      } else {
        title = title || a;
        if (explicitIntegralTag245 && title && !/\b(?:int[ée]grale|coffret|omnibus)\b/i.test(title)) {
          title =
            integralOrd245 && /^\d+$/.test(integralOrd245)
              ? `${title} — Intégrale ${integralOrd245}`
              : `${title} — Intégrale`;
        }
        if (u || n || (!explicitIntegralTag245 && h)) {
          vol245 = vol245 || normalizeSeriesNumber(u || n || h);
        }
        if (e && /^(?:(?:tome|vol\.?|volume|épisode|n°)\s*\d+|\d{1,3})$/i.test(e.trim())) {
          vol245 = vol245 || normalizeSeriesNumber(e);
        }
      }
    } else if (f.tag === '460' || f.tag === '461') {
      const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
      const sVol = normalizeSeriesNumber(getSf('v'));
      const rawDigitsEns = getSf('3').replace(/\D/g, '');
      const sEnsId = rawDigitsEns.length >= 8 ? rawDigitsEns.slice(-8) : rawDigitsEns;
      const validBibEnsId = /^[34]\d{6,}$/.test(sEnsId) ? sEnsId : '';
      if (sTitle && sVol && !series460 && !isEditorialPaperbackCollectionName(sTitle)) {
        series460 = sTitle;
        vol460 = sVol;
        if (validBibEnsId) ensId460 = validBibEnsId;
      } else if (sTitle && !unnumberedEns && !isEditorialPaperbackCollectionName(sTitle)) {
        unnumberedEns = sTitle;
        if (validBibEnsId) unnumberedEnsId = validBibEnsId;
      }
    } else if (f.tag === '290' || f.tag === '225') {
      const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
      const sVol = normalizeSeriesNumber(getSf('v'));
      if (
        sTitle &&
        sVol &&
        !series290 &&
        !isEditorialPaperbackCollectionName(sTitle) &&
        isPlausibleVolumeNumberStr(sVol)
      ) {
        series290 = sTitle;
        vol290 = sVol;
      } else if (sTitle && !collectionRaw) {
        collectionRaw = sTitle;
      }
    } else if (f.tag === '410' || f.tag === '295') {
      const sTitle = cleanSeriesName(cleanTitle(getSf('t') || getSf('a')));
      const sVol = normalizeSeriesNumber(getSf('v'));
      if (
        sTitle &&
        sVol &&
        !series410 &&
        !isEditorialPaperbackCollectionName(sTitle) &&
        isPlausibleVolumeNumberStr(sVol)
      ) {
        series410 = sTitle;
        vol410 = sVol;
      } else if (sTitle && !collectionRaw) {
        collectionRaw = sTitle;
      }
    } else if (f.tag === '260' || f.tag === '214' || f.tag === '210') {
      publisher = publisher || cleanPublisher(getSf('c') || getSf('b'));
      publishDate = publishDate || cleanPublishDate(getSf('d'));
    } else if (f.tag === '100' || f.tag === '700' || f.tag === '701' || f.tag === '702') {
      const last = getSf('a').trim();
      const firstM = getSf('m').trim();
      const firstB = getSf('b').trim();
      const first = firstM || (!last.includes(' ') ? firstB : '');
      const cleaned = cleanAuthor([last, first].filter(Boolean).join(', '));
      if (cleaned && !authors.includes(cleaned)) authors.push(cleaned);
    } else if (f.tag === '280' || f.tag === '215') {
      const raw280 = getSf('a');
      if (/\d+\s*-\s*\d+\s*p\./i.test(raw280)) isDualPages = true;
      const m = /(\d+)\s*p\b/i.exec(raw280);
      if (m) pageCount = Number(m[1]);
    }
  }

  if (!title) return null;

  // Priorité stricte InterMarc : 460/461 > 245$p/$u > 290 (filtré) > 410/295 (filtré)
  let seriesRaw = '';
  let volumeNumber = '';
  let bnfEnsembleId = ensId460 || unnumberedEnsId;

  if (series460 && !isEditorialOrPublisherCollection(series460, publisher)) {
    seriesRaw = series460;
    volumeNumber = vol460 || vol245;
  } else if (series245 && !isEditorialOrPublisherCollection(series245, publisher)) {
    seriesRaw = series245;
    volumeNumber = vol245;
  } else if (series290 && !isEditorialOrPublisherCollection(series290, publisher)) {
    seriesRaw = series290;
    volumeNumber = vol245 || vol290;
  } else if (series410 && !isEditorialOrPublisherCollection(series410, publisher)) {
    seriesRaw = series410;
    volumeNumber = vol245 || vol410;
  } else if (vol245) {
    volumeNumber = vol245;
    if (unnumberedEns && !isEditorialOrPublisherCollection(unnumberedEns, publisher)) {
      seriesRaw = unnumberedEns;
    }
  } else if (unnumberedEns && !collectionRaw) {
    collectionRaw = unnumberedEns;
  }

  const _isIntegral =
    explicitIntegralTag245 ||
    isDualPages ||
    Boolean(secondTitleHint && /\b(tomes?|albums?|int[ée]grale)\b/i.test(secondTitleHint)) ||
    isIntegralCandidateTitleOrPages(`${title} ${secondTitleHint}`, pageCount, Boolean(seriesRaw));

  if (isDualPages && secondTitleHint && !title.includes(secondTitleHint)) {
    title = `${title} / ${secondTitleHint}`;
  }

  return {
    source: 'bnf',
    isbn13: isbn13 || undefined,
    title,
    ...(authors.length ? { authors } : {}),
    seriesRaw: seriesRaw || undefined,
    collectionRaw: collectionRaw || undefined,
    volumeNumber: _isIntegral ? undefined : (volumeNumber || undefined),
    publisher: publisher || undefined,
    publishDate: publishDate || undefined,
    pageCount,
    coverUrl: coverUrl || undefined,
    bnfEnsembleId: bnfEnsembleId || undefined,
    language: language || 'fre',
    _isIntegral
  };
}

/**
 * Interroge le catalogue national SUDOC (ABES — `sudoc.fr`) par ISBN-13 :
 * 1. `isbn2ppn` JSON (~120 ms) -> récupère le(s) PPN
 * 2. `<ppn>.xml` (~150 ms) -> notice UNIMARC XML complète (compatible `extractMarcRecordMetadata` & `parseIntermarcRecord`).
 * Indispensable pour les éditions franco-belges (ex: Dupuis / Lombard / Casterman) absentes ou retardées au dépôt légal BnF.
 */
export async function fetchSudocRecordXmlByIsbn(isbn13: string, timeoutMs = 3500): Promise<string | null> {
  const clean = isbnUtil.normalize(isbn13);
  if (!clean) return null;
  try {
    const ppnUrl = `https://www.sudoc.fr/services/isbn2ppn/${encodeURIComponent(clean)}&format=text/json`;
    const ppnRes = await fetchWithTimeoutAndRetry(ppnUrl, { timeoutMs, retriesOn5xx: 0 });
    if (!ppnRes.ok) return null;
    const ppnJson = (await ppnRes.json().catch(() => null)) as any;
    const rawResult = ppnJson?.sudoc?.query?.result;
    const ppnEntry = Array.isArray(rawResult) ? rawResult[0] : rawResult;
    const ppn = typeof ppnEntry?.ppn === 'string' ? ppnEntry.ppn.trim() : '';
    if (!/^[0-9X]{8,10}$/i.test(ppn)) return null;

    const xmlUrl = `https://www.sudoc.fr/${encodeURIComponent(ppn)}.xml`;
    const xmlRes = await fetchWithTimeoutAndRetry(xmlUrl, { timeoutMs, retriesOn5xx: 0 });
    if (!xmlRes.ok) return null;
    const xml = await xmlRes.text();
    if (!xml || !xml.includes('<datafield')) return null;
    return xml;
  } catch {
    return null;
  }
}

export async function discoverMultiSourceLayer3(
  rawIsbn13: string,
  tracer?: PipelineTracer
): Promise<StagingPayload | null> {
  const start = Date.now();
  const isbn13 = isbnUtil.toIsbn13(isbnUtil.normalize(rawIsbn13)) || isbnUtil.normalize(rawIsbn13);
  if (!isbn13) return null;

  const bnfQuery = `bib.anywhere all "${isbn13}"`;
  const bnfAnchorUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(bnfQuery)}&recordSchema=intermarcxchange&maximumRecords=2`;
  const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn13)}&maxResults=4`;
  const olUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn13)}&jscmd=data&format=json`;
  const invUrl = `https://inventaire.io/api/entities?action=by-uris&uris=isbn:${encodeURIComponent(isbn13)}&attributes=info|labels|descriptions|claims|image&relatives=wdt:P629|wdt:P179|wdt:P50`;

  const fetchTrackedText = async (url: string) => {
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeoutAndRetry(url, { timeoutMs: 4200, retriesOn5xx: 0 });
      const text = r.ok ? await r.text() : await r.text().catch(() => '');
      return { ok: r.ok, status: r.status, ms: Date.now() - t0, data: r.ok ? text : '', err: r.ok ? undefined : text.slice(0, 180) };
    } catch (e: unknown) {
      return { ok: false, status: 0, ms: Date.now() - t0, data: '', err: e instanceof Error ? e.message : 'Network error' };
    }
  };
  const fetchTrackedJson = async (url: string) => {
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeoutAndRetry(url, { timeoutMs: 4200, retriesOn5xx: 0 });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return { ok: false, status: r.status, ms: Date.now() - t0, data: null as any, err: txt.slice(0, 180) };
      }
      const json = await r.json().catch(() => null);
      return { ok: true, status: r.status, ms: Date.now() - t0, data: json, err: undefined };
    } catch (e: unknown) {
      return { ok: false, status: 0, ms: Date.now() - t0, data: null as any, err: e instanceof Error ? e.message : 'Network error' };
    }
  };

  const gbCircuitOpen = isGoogleBooksCircuitOpen();
  const [bnfRes, sudocXml, gbRes, olRes, invRes] = await Promise.all([
    fetchTrackedText(bnfAnchorUrl),
    fetchSudocRecordXmlByIsbn(isbn13),
    gbCircuitOpen
      ? Promise.resolve({ ok: false, status: 429, ms: 0, data: null as any, err: 'circuit-breaker cooldown' })
      : fetchTrackedJson(gbUrl),
    fetchTrackedJson(olUrl),
    fetchTrackedJson(invUrl)
  ]);
  if (!gbCircuitOpen && gbRes.status === 429) {
    tripGoogleBooksCircuit();
  }

  const sisterEditions: SisterEditionCandidate[] = [];
  const seriesCandidates: SeriesVoteCandidate[] = [];
  const authors: string[] = [];
  const illustrators: string[] = [];
  const scriptwriters: string[] = [];
  const rawSubjects: string[] = [];
  const rawTitles: string[] = [];
  const sourcesHit: string[] = [];

  let anchorTitle = '';
  let anchorVolumeNumber = '';
  let anchorIsIntegral = false;
  let publisher = '';
  let publishDate = '';
  let pageCount: number | undefined;
  let description = '';
  let deweyCode = '';
  let wikidataWorkQid: string | undefined;
  const wikidataWorkQids: string[] = [];
  let wikidataSeriesQid: string | undefined;
  let inventaireWorkUri: string | undefined;
  const includedVolumeNumbersHint = new Set<string>();

  const registerSeriesVote = (
    source: string,
    rawName: string | undefined,
    weight: number,
    extra?: { ensembleId?: string; wikidataQid?: string }
  ) => {
    if (!rawName?.trim()) return;
    if (isEditorialPaperbackCollectionName(rawName)) return;
    const { coreKey, cleanDisplay } = stripEditorialCollectionSuffixes(cleanSeriesName(rawName));
    if (!coreKey || coreKey.length < 2) return;
    if (isEditorialPaperbackCollectionName(cleanDisplay)) return;
    seriesCandidates.push({
      source,
      rawName: rawName.trim(),
      coreKey,
      cleanDisplay: cleanDisplay || cleanSeriesName(rawName),
      weight,
      ensembleId: extra?.ensembleId,
      wikidataQid: extra?.wikidataQid
    });
  };

  // 1. Analyse BnF InterMarc (+ repli / complément UNIMARC SUDOC ABES si présent)
  const bnfExtractedSummary: any[] = [];
  const rawMarcRecords: string[] = [];
  if (bnfRes.ok && bnfRes.data) {
    rawMarcRecords.push(...bnfRes.data.split('<srw:record>').slice(1));
  }
  if (sudocXml) {
    rawMarcRecords.push(sudocXml);
  }
  if (rawMarcRecords.length > 0) {
    for (const recXml of rawMarcRecords) {
      const cand = extractMarcRecordMetadata(recXml, isbn13);
      if (!cand) continue;
      if (!sourcesHit.includes('bnf')) sourcesHit.push('bnf');
      if (!isStrictFrenchLanguage(cand.language)) continue;
      sisterEditions.push(cand);
      anchorTitle = anchorTitle || cand.title;
      if (!anchorVolumeNumber && cand.volumeNumber) anchorVolumeNumber = cand.volumeNumber;
      if (cand._isIntegral) anchorIsIntegral = true;
      rawTitles.push(cand.title);
      publisher = publisher || cand.publisher || '';
      publishDate = publishDate || cand.publishDate || '';
      pageCount = pageCount || cand.pageCount;
      bnfExtractedSummary.push({
        title: cand.title,
        seriesRaw: cand.seriesRaw,
        volumeNumber: cand.volumeNumber,
        collectionRaw: cand.collectionRaw,
        isIntegral: Boolean(cand._isIntegral),
        lang: cand.language
      });

      if (cand.seriesRaw) {
        registerSeriesVote('bnf_anchor', cand.seriesRaw, 3, { ensembleId: cand.bnfEnsembleId });
      } else if (cand.collectionRaw && cand.volumeNumber && isPlausibleVolumeNumberStr(cand.volumeNumber)) {
        registerSeriesVote('bnf_collection_numbered', cand.collectionRaw, 2.2, { ensembleId: cand.bnfEnsembleId });
      }

      const fields = parseMarcFieldsFromXml(recXml);
      for (const f of fields) {
        const getSf = (c: string) => f.subfields.find((s) => s.code === c)?.value || '';
        if (f.tag === '100' || f.tag === '700' || f.tag === '701' || f.tag === '702') {
          const last = getSf('a').trim();
          const firstM = getSf('m').trim();
          const firstB = getSf('b').trim();
          const first = firstM || (!last.includes(' ') ? firstB : '');
          const cleaned = cleanAuthor([last, first].filter(Boolean).join(', '));
          const role = getSf('4').toLowerCase();
          if (cleaned) {
            if (role.includes('440') || role.includes('ill') || role.includes('dessin')) {
              if (!illustrators.includes(cleaned)) illustrators.push(cleaned);
            } else if (role.includes('690') || role.includes('070') || role.includes('scén')) {
              if (!scriptwriters.includes(cleaned)) scriptwriters.push(cleaned);
            }
            if (!authors.includes(cleaned)) authors.push(cleaned);
          }
        } else if (f.tag === '676') {
          deweyCode = deweyCode || getSf('a');
        } else if (f.tag === '606' || f.tag === '608' || f.tag === '610') {
          if (getSf('a')) rawSubjects.push(getSf('a'));
          if (getSf('x')) rawSubjects.push(getSf('x'));
        } else if (f.tag === '830' || f.tag === '330') {
          const d = getSf('a');
          if (d && d.length > description.length) description = d;
        }
      }
    }
  }
  tracer?.record(
    'C3',
    'api_bnf',
    bnfRes.ok ? (bnfExtractedSummary.length ? 'ok' : 'warn') : 'error',
    `BnF SRU (${isbn13}) HTTP ${bnfRes.status} (${bnfRes.ms}ms) -> ${bnfExtractedSummary.length} notice(s)`,
    { request: { url: bnfAnchorUrl, query: bnfQuery }, status: bnfRes.status, results: bnfExtractedSummary, error: bnfRes.err },
    bnfRes.ms
  );

  // 2. Inventaire.io (API Publique Lecture Seule sans auth) + Wikidata
  let invSummary: Record<string, unknown> | null = null;
  if (invRes.ok && invRes.data?.entities) {
    const ents = invRes.data.entities as Record<string, any>;
    const edEnt = ents[`isbn:${isbn13}`] || Object.values(ents).find((e: any) => e?.type === 'edition');
    if (edEnt) {
      sourcesHit.push('inventaire');
      const edTitle = cleanTitle(edEnt.claims?.['wdt:P1476']?.[0] || edEnt.labels?.fr || edEnt.labels?.en || '');
      if (edTitle) {
        rawTitles.push(edTitle);
        if (!anchorTitle || (/\b(?:int[ée]grale|coffret|omnibus)\b/i.test(edTitle) && !/\b(?:int[ée]grale|coffret|omnibus)\b/i.test(anchorTitle))) {
          anchorTitle = edTitle;
        }
      }
      const rawImg = edEnt.image?.url || edEnt.claims?.['invp:P2']?.[0];
      const invCoverUrl =
        typeof rawImg === 'string' && rawImg.trim()
          ? `https://inventaire.io/img/entities/300x300/${rawImg.split('/').pop()}`
          : undefined;

      const workUris: string[] = Array.isArray(edEnt.claims?.['wdt:P629'])
        ? edEnt.claims['wdt:P629'].map(String).filter(Boolean)
        : [];
      const workUri = workUris[0];
      if (typeof workUri === 'string') {
        inventaireWorkUri = workUri;
        if (workUri.startsWith('wd:')) wikidataWorkQid = workUri.slice(3);
      }
      for (const wUri of workUris) {
        if (wUri.startsWith('wd:')) {
          const q = wUri.slice(3);
          if (!wikidataWorkQids.includes(q)) wikidataWorkQids.push(q);
        }
      }
      if (workUris.length > 1 || (edTitle && isIntegralCandidateTitleOrPages(edTitle, undefined, true))) {
        anchorIsIntegral = true;
      }

      const workEnt = workUri ? ents[workUri] : undefined;
      let invVol = '';
      let invSeries = '';
      for (const wUri of workUris) {
        const wEnt = ents[wUri];
        if (!wEnt) continue;
        const wDesc = wEnt.descriptions?.fr || wEnt.descriptions?.en;
        if (typeof wDesc === 'string' && wDesc.length > description.length) description = wDesc;
        const ord = wEnt.claims?.['wdt:P1545']?.[0];
        if (ord) {
          const normOrd = normalizeSeriesNumber(String(ord));
          if (normOrd && /^\d+$/.test(normOrd)) {
            if (workUris.length > 1) {
              includedVolumeNumbersHint.add(normOrd);
            } else {
              invVol = invVol || normOrd;
              if (!anchorVolumeNumber) anchorVolumeNumber = normOrd;
            }
          }
        }
        const authorRefs = wEnt.claims?.['wdt:P50'];
        if (Array.isArray(authorRefs)) {
          for (const aUri of authorRefs) {
            const aEnt = ents[String(aUri)];
            const aLabel = aEnt?.labels?.fr || aEnt?.labels?.en;
            if (aLabel) {
              const ca = cleanAuthor(String(aLabel));
              if (ca && !authors.includes(ca)) authors.push(ca);
            }
          }
        }
        const serieUri = wEnt.claims?.['wdt:P179']?.[0];
        if (typeof serieUri === 'string' && serieUri.startsWith('wd:')) {
          wikidataSeriesQid = wikidataSeriesQid || serieUri.slice(3);
        }
        const serieEnt = serieUri ? ents[serieUri] : undefined;
        if (serieEnt) {
          const sName = cleanSeriesName(serieEnt.labels?.fr || serieEnt.labels?.en || serieEnt.label || '');
          if (sName) {
            invSeries = invSeries || sName;
            registerSeriesVote('inventaire_p179', sName, 3, { wikidataQid: wikidataSeriesQid });
          }
        }
      }

      if (workEnt && !invSeries && !wikidataSeriesQid) {
        const sFallback = workEnt.claims?.['wdt:P179']?.[0];
        if (typeof sFallback === 'string' && sFallback.startsWith('wd:')) wikidataSeriesQid = sFallback.slice(3);
      }

      invSummary = {
        edTitle,
        workUri,
        workUrisCount: workUris.length,
        invVol,
        includedVols: Array.from(includedVolumeNumbersHint),
        invSeries,
        wikidataSeriesQid
      };
      if (edTitle) {
        sisterEditions.push({
          source: 'inventaire',
          isbn13,
          title: edTitle,
          seriesRaw: invSeries || undefined,
          volumeNumber: workUris.length <= 1 ? (invVol || undefined) : undefined,
          coverUrl: invCoverUrl,
          wikidataWorkQid: workUris.length <= 1 ? wikidataWorkQid : undefined,
          wikidataSeriesQid,
          language: 'fr'
        });
      }
    }
  }
  tracer?.record(
    'C3',
    'api_inventaire',
    invRes.ok ? (invSummary ? 'ok' : 'warn') : 'error',
    `Inventaire.io (${isbn13}) HTTP ${invRes.status} (${invRes.ms}ms) -> ${invSummary ? 'HIT' : 'Aucun'}`,
    { request: { url: invUrl }, status: invRes.status, result: invSummary, error: invRes.err },
    invRes.ms
  );

  // 3. Google Books (FR prioritaire + éditions sœurs éventuelles)
  const gbSummary: any[] = [];
  if (gbRes.ok && Array.isArray(gbRes.data?.items)) {
    const items = gbRes.data.items as any[];
    if (items.length > 0) sourcesHit.push('google_books');
    for (const item of items) {
      const info = item?.volumeInfo;
      if (!info) continue;
      if (info.language && !isStrictFrenchLanguage(info.language)) continue;
      const t = cleanTitle(info.title || '');
      if (!t) continue;
      anchorTitle = anchorTitle || t;
      rawTitles.push(t);
      if (Array.isArray(info.authors)) {
        for (const a of info.authors) {
          const ca = cleanAuthor(String(a));
          if (ca && !authors.includes(ca)) authors.push(ca);
        }
      }
      if (typeof info.description === 'string' && info.description.trim().length > description.length + 25) {
        description = info.description.trim();
      }
      if (Array.isArray(info.categories)) rawSubjects.push(...info.categories);
      const thumb = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail;
      const gbCoverUrl = thumb ? String(thumb).replace(/^http:\/\//i, 'https://') : undefined;
      const parsedFromGbTitle = parseSeriesFromTitle(t);
      if (parsedFromGbTitle.series) {
        registerSeriesVote('google_books', parsedFromGbTitle.series, 1.5);
      }
      const ids = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [];
      const gbIsbn13 =
        ids.find((x: any) => x.type === 'ISBN_13')?.identifier ||
        isbnUtil.toIsbn13(ids.find((x: any) => x.type === 'ISBN_10')?.identifier || '') ||
        isbn13;
      const candIntegralGb = isIntegralCandidateTitleOrPages(t, info.pageCount);
      gbSummary.push({ title: t, series: parsedFromGbTitle.series, vol: parsedFromGbTitle.seriesNumber, pages: info.pageCount });
      if (!anchorVolumeNumber || !parsedFromGbTitle.seriesNumber || parsedFromGbTitle.seriesNumber === anchorVolumeNumber) {
        if (candIntegralGb === anchorIsIntegral || !anchorTitle) {
          sisterEditions.push({
            source: 'google_books',
            isbn13: isbnUtil.isValidBookBarcode(gbIsbn13) ? gbIsbn13 : undefined,
            title: parsedFromGbTitle.title || t,
            seriesRaw: parsedFromGbTitle.series,
            volumeNumber: parsedFromGbTitle.seriesNumber,
            publisher: info.publisher ? cleanPublisher(info.publisher) : undefined,
            publishDate: info.publishedDate ? cleanPublishDate(info.publishedDate) : undefined,
            pageCount: info.pageCount,
            coverUrl: gbCoverUrl,
            language: info.language || 'fr'
          });
        }
      }
    }
  }
  if (!gbCircuitOpen) {
    tracer?.record(
      'C3',
      'api_google_books',
      gbRes.ok ? (gbSummary.length ? 'ok' : 'warn') : gbRes.status === 429 ? 'warn' : 'error',
      gbRes.status === 429
        ? `Google Books (${isbn13}) HTTP 429 -> circuit-breaker activé 15 min`
        : `Google Books (${isbn13}) HTTP ${gbRes.status} (${gbRes.ms}ms) -> ${gbSummary.length} résultat(s)`,
      { request: { url: gbUrl }, status: gbRes.status, results: gbSummary, error: gbRes.err },
      gbRes.ms
    );
  }

  // 4. OpenLibrary
  let olSummary: Record<string, unknown> | null = null;
  if (olRes.ok && olRes.data) {
    const key = Object.keys(olRes.data as Record<string, unknown>)[0];
    const olBook = key ? (olRes.data as Record<string, any>)[key] : null;
    if (olBook?.title) {
      sourcesHit.push('openlibrary');
      const t = cleanTitle(olBook.title);
      anchorTitle = anchorTitle || t;
      rawTitles.push(t);
      if (Array.isArray(olBook.authors)) {
        for (const a of olBook.authors) {
          const ca = cleanAuthor(a?.name || '');
          if (ca && !authors.includes(ca)) authors.push(ca);
        }
      }
      if (Array.isArray(olBook.subjects)) {
        for (const s of olBook.subjects) {
          const sName = typeof s === 'string' ? s : s?.name;
          if (typeof sName === 'string' && sName.trim()) rawSubjects.push(sName.trim());
        }
      }
      const olCoverUrl = olBook.cover?.large || olBook.cover?.medium;
      const parsedFromOl = parseSeriesFromTitle(t);
      olSummary = { title: t, publisher: olBook.publishers?.[0]?.name, pages: olBook.number_of_pages };
      sisterEditions.push({
        source: 'openlibrary',
        isbn13,
        title: parsedFromOl.title || t,
        seriesRaw: parsedFromOl.series,
        volumeNumber: parsedFromOl.seriesNumber,
        publisher: olBook.publishers?.[0]?.name ? cleanPublisher(olBook.publishers[0].name) : undefined,
        publishDate: olBook.publish_date ? cleanPublishDate(olBook.publish_date) : undefined,
        pageCount: olBook.number_of_pages,
        coverUrl: olCoverUrl,
        language: 'fr'
      });
    }
  }
  tracer?.record(
    'C3',
    'api_openlibrary',
    olRes.ok ? (olSummary ? 'ok' : 'warn') : 'error',
    `OpenLibrary (${isbn13}) HTTP ${olRes.status} (${olRes.ms}ms) -> ${olSummary ? 'HIT' : 'Aucun'}`,
    { request: { url: olUrl }, status: olRes.status, result: olSummary, error: olRes.err },
    olRes.ms
  );

  if (!anchorTitle) {
    tracer?.record(
      'C3',
      'multi_source_discovery',
      'warn',
      `Aucune source externe n'a résolu l'ISBN ${isbn13}`,
      { isbn13, sourcesHit },
      Date.now() - start
    );
    return null;
  }

  // 5. Phase C3-bis : Découverte rapide des Éditions Sœurs FR sur BnF + Wikidata direct
  // Permet de récupérer le n° de tome manquant sur une réédition ou toutes les éditions d'une même œuvre !
  const parsedAnchor = parseSeriesFromTitle(anchorTitle);
  const searchTitleClean = (parsedAnchor.title || anchorTitle).replace(/["()]/g, ' ').trim();
  const effectiveAnchorVol = normalizeSeriesNumber(anchorVolumeNumber || parsedAnchor.seriesNumber || '');
  const effectiveAnchorIntegral =
    anchorIsIntegral ||
    wikidataWorkQids.length > 1 ||
    isIntegralCandidateTitleOrPages(anchorTitle, pageCount, seriesCandidates.length > 0);

  const sisterLookups: Promise<void>[] = [];

  if (searchTitleClean.length >= 3) {
    sisterLookups.push(
      (async () => {
        const s0 = Date.now();
        try {
          const firstAuthorLast = extractAuthorLastNameForBnfCql(authors[0]);
          const cql = firstAuthorLast
            ? `(bib.title all "${searchTitleClean}") and (bib.author all "${firstAuthorLast}") and (bib.doctype all "a")`
            : `(bib.title all "${searchTitleClean}") and (bib.doctype all "a")`;
          const sruUrl = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${encodeURIComponent(cql)}&recordSchema=intermarcxchange&maximumRecords=12&startRecord=1`;
          const res = await fetchWithTimeoutAndRetry(sruUrl, { timeoutMs: 4500, retriesOn5xx: 1 });
          if (!res.ok) {
            tracer?.record(
              'C3',
              'api_bnf_sisters',
              'warn',
              `BnF Sœurs CQL HTTP ${res.status}`,
              { request: { url: sruUrl, cql }, status: res.status },
              Date.now() - s0
            );
            return;
          }
          const xml = await res.text();
          const recs = xml.split('<srw:record>').slice(1);
          const normTarget = normalizeTextKey(parsedAnchor.title || anchorTitle);
          let accepted = 0;
          let rejectedDiffVol = 0;
          let rejectedIntegralMismatch = 0;

          for (const rec of recs) {
            const cand = extractMarcRecordMetadata(rec);
            if (!cand || !isStrictFrenchLanguage(cand.language)) continue;
            if (cand.isbn13 && !isFrancophoneBookIsbn13(cand.isbn13)) continue;
            const candTitleClean = parseSeriesFromTitle(cand.title).title || cand.title;
            const normCandTitle = normalizeTextKey(candTitleClean);
            const titleSimilar =
              normCandTitle === normTarget ||
              normCandTitle.includes(normTarget) ||
              normTarget.includes(normCandTitle) ||
              (normTarget.length >= 5 && getLevenshteinDistance(normCandTitle, normTarget) <= 2);
            if (!titleSimilar) continue;

            // Garde critique anti-absorption entre tomes distincts (ex: Culottées T1 vs T2) ou Intégrale vs Tome
            const candVol = normalizeSeriesNumber(cand.volumeNumber || parseSeriesFromTitle(cand.title).seriesNumber || '');
            if (effectiveAnchorVol && candVol && candVol !== effectiveAnchorVol) {
              rejectedDiffVol++;
              continue;
            }
            // Si le tome ancre est numéroté mais la notice sœur n'a PAS de numéro ET porte un titre générique identique à la série
            // (ex: "Culottées", "Aya de Yopougon", "Mattéo"), ou inversement si l'ancre n'a pas de numéro mais la sœur en a un sur titre générique,
            // ne pas l'absorber (évite la contamination T1 <-> T2).
            const candSeriesCore = cand.seriesRaw ? stripEditorialCollectionSuffixes(cand.seriesRaw).coreKey : '';
            const normCandCore = stripEditorialCollectionSuffixes(candTitleClean).coreKey;
            const anchorSeriesCore = seriesCandidates[0]?.coreKey || '';
            const isGenericSeriesTitle =
              (candSeriesCore && normCandCore === candSeriesCore) ||
              (anchorSeriesCore && normCandCore === anchorSeriesCore);
            if (isGenericSeriesTitle && ((effectiveAnchorVol && !candVol) || (!effectiveAnchorVol && candVol))) {
              rejectedDiffVol++;
              continue;
            }
            if (Boolean(cand._isIntegral) !== effectiveAnchorIntegral) {
              rejectedIntegralMismatch++;
              continue;
            }

            sisterEditions.push(cand);
            accepted++;
            if (cand.seriesRaw) {
              registerSeriesVote('bnf_sister_edition', cand.seriesRaw, 2, { ensembleId: cand.bnfEnsembleId });
            }
          }

          tracer?.record(
            'C3',
            'api_bnf_sisters',
            'ok',
            `BnF Sœurs (${recs.length} reçue(s)) : ${accepted} retenue(s), ${rejectedDiffVol} écartée(s) autre tome, ${rejectedIntegralMismatch} autre format`,
            {
              request: { url: sruUrl, cql, anchorVol: effectiveAnchorVol, anchorIntegral: effectiveAnchorIntegral },
              status: res.status,
              totalRecords: recs.length,
              accepted,
              rejectedDiffVol,
              rejectedIntegralMismatch
            },
            Date.now() - s0
          );
        } catch (err: unknown) {
          tracer?.record(
            'C3',
            'api_bnf_sisters',
            'error',
            `Erreur BnF Sœurs : ${err instanceof Error ? err.message : String(err)}`,
            { searchTitleClean },
            Date.now() - s0
          );
        }
      })()
    );
  }

  const wdBatchIds = Array.from(new Set([wikidataWorkQid, ...wikidataWorkQids].filter(Boolean) as string[])).slice(0, 12);
  if (wdBatchIds.length > 0) {
    sisterLookups.push(
      (async () => {
        const w0 = Date.now();
        try {
          const wdUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(wdBatchIds.join('|'))}&props=labels|descriptions|claims&languages=fr|en&format=json`;
          const res = await fetch(wdUrl, { headers: { 'User-Agent': USER_AGENT_BASE } });
          if (!res.ok) return;
          const json = (await res.json()) as any;
          const ent = wikidataWorkQid ? json?.entities?.[wikidataWorkQid] : json?.entities?.[wdBatchIds[0]];
          if (!ent) return;
          sourcesHit.push('wikidata');

          // Extraire tous les P1545 sur l'ensemble des œuvres liées (crucial pour Intégrales multi-P629 !)
          const extractP1545FromEntity = (wObj: any): string => {
            const p179Claims = Array.isArray(wObj?.claims?.P179) ? wObj.claims.P179 : [];
            for (const claim of p179Claims) {
              const qVal = claim?.qualifiers?.P1545?.[0]?.mainsnak?.datavalue?.value;
              if (qVal !== undefined && qVal !== null && String(qVal).trim()) {
                return String(qVal);
              }
            }
            const directVal = wObj?.claims?.P1545?.[0]?.mainsnak?.datavalue?.value;
            return directVal !== undefined && directVal !== null ? String(directVal) : '';
          };
          const isMultiWorkIntegral = wdBatchIds.length > 1;
          for (const qId of wdBatchIds) {
            const wObj = json?.entities?.[qId];
            if (!wObj) continue;
            const qOrd = extractP1545FromEntity(wObj);
            const normQOrd = qOrd ? normalizeSeriesNumber(qOrd) : '';
            if (isMultiWorkIntegral && normQOrd && /^\d+$/.test(normQOrd)) {
              includedVolumeNumbersHint.add(normQOrd);
            }
          }

          const p179Id = ent.claims?.P179?.[0]?.mainsnak?.datavalue?.value?.id;
          const rawEntOrd = extractP1545FromEntity(ent);
          const wdVol = isMultiWorkIntegral ? '' : normalizeSeriesNumber(rawEntOrd);
          let wdSeriesLabel = '';
          if (p179Id && typeof p179Id === 'string') {
            wikidataSeriesQid = wikidataSeriesQid || p179Id;
            const wdSeriesRes = await fetch(
              `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(p179Id)}&props=labels|claims&languages=fr|en&format=json`,
              { headers: { 'User-Agent': USER_AGENT_BASE } }
            ).catch(() => null);
            if (wdSeriesRes?.ok) {
              const sJson = (await wdSeriesRes.json()) as any;
              const sEnt = sJson?.entities?.[p179Id];
              const sLabel = sEnt?.labels?.fr?.value || sEnt?.labels?.en?.value;
              const rawBnfP268 = sEnt?.claims?.P268?.[0]?.mainsnak?.datavalue?.value;
              const cleanBnfP268 = rawBnfP268 ? String(rawBnfP268).replace(/\D/g, '') : '';
              // Attention : P268 sur Wikidata est le plus souvent un identifiant d'AUTORITÉ BnF (commençant par 1, ex: 14573759 pour Astérix)
              // et NON une notice bibliographique d'ensemble 460$3 (commençant par 3 ou 4). Ne l'enregistrer en ensembleId que si c'est une notice biblio !
              const validBibEnsId = /^[34]\d{6,}$/.test(cleanBnfP268) ? cleanBnfP268 : undefined;
              if (sLabel) {
                wdSeriesLabel = String(sLabel);
                registerSeriesVote('wikidata_p179', wdSeriesLabel, 3, {
                  wikidataQid: p179Id,
                  ensembleId: validBibEnsId
                });
              }
            }
          }
          if (wdVol) {
            sisterEditions.push({
              source: 'wikidata',
              title: ent.labels?.fr?.value || anchorTitle,
              volumeNumber: wdVol,
              wikidataWorkQid,
              wikidataSeriesQid,
              language: 'fr'
            });
          }
          tracer?.record(
            'C3',
            'api_wikidata',
            'ok',
            `Wikidata (${wdBatchIds.join(',')}) HTTP ${res.status} -> série « ${wdSeriesLabel || 'aucune'} », tomes « ${isMultiWorkIntegral ? Array.from(includedVolumeNumbersHint).join(',') : wdVol || '-'} »`,
            {
              request: { url: wdUrl, qids: wdBatchIds },
              result: { wdSeriesLabel, wikidataSeriesQid, wdVol, includedVols: Array.from(includedVolumeNumbersHint) }
            },
            Date.now() - w0
          );
        } catch {
          // non-bloquant
        }
      })()
    );
  }

  await Promise.allSettled(sisterLookups);

  const uniqueSources = Array.from(new Set(sourcesHit));
  tracer?.record(
    'C3',
    'multi_source_discovery',
    'ok',
    `Staging Payload (${uniqueSources.join('+')}) : « ${anchorTitle} », ${sisterEditions.length} édition(s) sœur(s), ${seriesCandidates.length} vote(s) série`,
    {
      isbn13,
      sourcesHit: uniqueSources,
      sisterIsbns: Array.from(new Set(sisterEditions.map((s) => s.isbn13).filter(Boolean))),
      seriesVotesCount: seriesCandidates.length
    },
    Date.now() - start
  );

  return {
    anchorIsbn13: isbn13,
    anchorTitle,
    language: 'fr',
    sisterEditions,
    seriesCandidates,
    authors,
    illustrators,
    scriptwriters,
    publisher: publisher || undefined,
    publishDate: publishDate || undefined,
    pageCount,
    description: description || undefined,
    deweyCode: deweyCode || undefined,
    rawSubjects,
    rawTitles,
    wikidataWorkQid: wdBatchIds.length <= 1 ? wikidataWorkQid : undefined,
    wikidataWorkQids,
    wikidataSeriesQid,
    inventaireWorkUri,
    includedVolumeNumbersHint: Array.from(includedVolumeNumbersHint).sort((a, b) => Number(a) - Number(b)),
    anchorIsIntegralHint: effectiveAnchorIntegral,
    sourcesHit: uniqueSources
  };
}

