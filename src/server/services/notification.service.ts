// src/server/services/notification.service.ts
// Service métier Nouveautés Séries (anti-faux-positifs intégrales), Préférences Notifications & Digests Push/E-mail.

import crypto from 'node:crypto';
import { annotateIntegralCoverage } from '../../shared/bibliographic/integral.util';
import type { BookView, NotificationChannel, NotificationFrequency } from '../../shared/types/domain.types';
import type { ServerConfig } from '../config';
import type { MailSender } from '../connectors/resend.connector';
import type { WebPushSender } from '../connectors/webpush.connector';
import type { CatalogRepository } from '../repositories/catalog.repo';
import type { LibraryRepository } from '../repositories/library.repo';
import type { NotificationRepository } from '../repositories/notification.repo';
import type { IngestionService } from './acquisition/ingestion.service';
import type { SeriesGraphService } from './acquisition/series-graph.service';

export interface ReleaseAlertView {
  alertId: string;
  seriesId: string;
  seriesName: string;
  detectedAt: string;
  book: BookView;
}

export interface NotificationPrefsView {
  frequency: NotificationFrequency;
  dayOfWeek: number;
  dayOfMonth: number;
  hour: number;
  timezone: string;
  channel: NotificationChannel;
  lastNotifiedAt: string | null;
  vapidPublicKey: string;
  hasPushSubscription: boolean;
}

function getLocalPartsInTimezone(date: Date, timezone: string): {
  hour: number;
  dayOfWeek: number;
  dayOfMonth: number;
  dateKey: string;
} {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
      weekday: 'short'
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      hour: Number(parts.hour ?? 0) % 24,
      dayOfWeek: wdMap[parts.weekday ?? 'Sat'] ?? 6,
      dayOfMonth: Number(parts.day ?? 1),
      dateKey: `${parts.year}-${parts.month}-${parts.day}`
    };
  } catch {
    return {
      hour: date.getUTCHours(),
      dayOfWeek: date.getUTCDay(),
      dayOfMonth: date.getUTCDate(),
      dateKey: date.toISOString().slice(0, 10)
    };
  }
}

export class NotificationService {
  private readonly config: ServerConfig;
  private readonly notifRepo: NotificationRepository;
  private readonly catalogRepo: CatalogRepository;
  private readonly libraryRepo: LibraryRepository;
  private readonly ingestionService: IngestionService;
  private readonly seriesGraphService: SeriesGraphService;
  private readonly mailSender: MailSender;
  private readonly webPushSender: WebPushSender;

  constructor(deps: {
    config: ServerConfig;
    notifRepo: NotificationRepository;
    catalogRepo: CatalogRepository;
    libraryRepo: LibraryRepository;
    ingestionService: IngestionService;
    seriesGraphService: SeriesGraphService;
    mailSender: MailSender;
    webPushSender: WebPushSender;
  }) {
    this.config = deps.config;
    this.notifRepo = deps.notifRepo;
    this.catalogRepo = deps.catalogRepo;
    this.libraryRepo = deps.libraryRepo;
    this.ingestionService = deps.ingestionService;
    this.seriesGraphService = deps.seriesGraphService;
    this.mailSender = deps.mailSender;
    this.webPushSender = deps.webPushSender;
  }

  getPrefs(userId: string): NotificationPrefsView {
    const row = this.notifRepo.getPrefs(userId);
    const subs = this.notifRepo.listPushSubscriptions(userId);
    return {
      frequency: row?.frequency ?? 'weekly',
      dayOfWeek: row?.day_of_week ?? 6,
      dayOfMonth: row?.day_of_month ?? 1,
      hour: row?.hour ?? 9,
      timezone: row?.timezone ?? 'Europe/Paris',
      channel: row?.channel ?? 'push',
      lastNotifiedAt: row?.last_notified_at ?? null,
      vapidPublicKey: this.config.vapidPublicKey,
      hasPushSubscription: subs.length > 0
    };
  }

  savePrefs(
    userId: string,
    input: {
      frequency: NotificationFrequency;
      dayOfWeek: number;
      dayOfMonth: number;
      hour: number;
      timezone: string;
      channel: NotificationChannel;
    }
  ): NotificationPrefsView {
    const now = new Date().toISOString();
    this.notifRepo.upsertPrefs({ userId, ...input, now });
    return this.getPrefs(userId);
  }

  subscribePush(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
    this.notifRepo.upsertPushSubscription({
      id: `push_${crypto.randomBytes(6).toString('hex')}`,
      userId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      now: new Date().toISOString()
    });
  }

  unsubscribePush(userId: string, endpoint?: string): void {
    this.notifRepo.deletePushSubscription(userId, endpoint);
  }

  /**
   * Liste les alertes nouveautés actives d'un foyer, en filtrant automatiquement tout tome déjà possédé
   * (directement OU couvert par une intégrale possédée).
   */
  listActiveReleaseAlerts(libraryId: string): ReleaseAlertView[] {
    const rawAlerts = this.notifRepo.listActiveAlerts(libraryId);
    if (rawAlerts.length === 0) return [];

    // Récupère les intégrales possédées du foyer pour filtrage anti-faux-positif
    const ownedLibRows = this.libraryRepo
      .listLibraryBooks(libraryId)
      .filter((r) => r.status === 'owned' && !r.deleted_at);

    const ownedIntegrals: BookView[] = [];
    for (const lr of ownedLibRows) {
      const br = this.catalogRepo.findBookById(lr.book_id);
      if (!br) continue;
      const mv = this.ingestionService.buildMergedBookView(br, lr);
      if (mv.isIntegral && mv.includedVolumes.length > 0) ownedIntegrals.push(mv);
    }

    const now = new Date().toISOString();
    const out: ReleaseAlertView[] = [];

    for (const alert of rawAlerts) {
      const bookRow = this.catalogRepo.findBookById(alert.book_id);
      if (!bookRow) continue;
      const libRow = this.libraryRepo.findLibraryBook(libraryId, bookRow.id);
      const merged = this.ingestionService.buildMergedBookView(bookRow, libRow);
      const [annotated] = annotateIntegralCoverage([merged], ownedIntegrals);

      // Si entre-temps le foyer a acquis ce tome (ou une intégrale qui le couvre), on acquitte silencieusement !
      if (annotated.ownershipStatus === 'owned' || annotated.ownedViaIntegral) {
        this.notifRepo.dismissAlert(libraryId, alert.id, now);
        continue;
      }

      const seriesRow = this.catalogRepo.findSeriesById(alert.series_id);
      out.push({
        alertId: alert.id,
        seriesId: alert.series_id,
        seriesName: seriesRow?.canonical_name ?? annotated.seriesName ?? '',
        detectedAt: alert.detected_at,
        book: annotated
      });
    }

    return out;
  }

  /**
   * Vérifie les sorties sur toutes les séries suivies par un foyer (expansion Graphe/BnF + anti-faux-positifs intégrales).
   */
  async checkReleasesForLibrary(libraryId: string): Promise<{ checkedSeriesCount: number; newAlertsCount: number }> {
    const libRows = this.libraryRepo.listLibraryBooks(libraryId);
    const ownedRows = libRows.filter((r) => r.status === 'owned' && !r.deleted_at);

    const followedSeriesIds = new Set<string>();
    const ownedViews: BookView[] = [];

    for (const lr of ownedRows) {
      const br = this.catalogRepo.findBookById(lr.book_id);
      if (!br) continue;
      const mv = this.ingestionService.buildMergedBookView(br, lr);
      ownedViews.push(mv);
      if (mv.seriesId) followedSeriesIds.add(mv.seriesId);
    }

    const ownedIntegrals = ownedViews.filter((b) => b.isIntegral && b.includedVolumes.length > 0);
    let newAlertsCount = 0;
    const now = new Date().toISOString();

    for (const seriesId of followedSeriesIds) {
      await this.seriesGraphService.expandSeriesByGraph(seriesId);

      // Calcule le numéro max possédé dans la série (incluant les tomes couverts par intégrales)
      const seriesBooks = this.catalogRepo.listBooksBySeriesId(seriesId);
      const mergedSeriesBooks = seriesBooks.map((br) =>
        this.ingestionService.buildMergedBookView(br, this.libraryRepo.findLibraryBook(libraryId, br.id))
      );
      const annotated = annotateIntegralCoverage(mergedSeriesBooks, ownedIntegrals);

      let maxOwnedVol = 0;
      for (const b of annotated) {
        if (b.ownershipStatus === 'owned') {
          if (b.volumeNumber && b.volumeNumber > maxOwnedVol) maxOwnedVol = b.volumeNumber;
          for (const inc of b.includedVolumes) {
            const n = parseInt(inc, 10);
            if (Number.isFinite(n) && n > maxOwnedVol) maxOwnedVol = n;
          }
        }
      }

      for (const candidate of annotated) {
        // Jamais d'alerte sur un livre déjà possédé (directement OU couvert par une intégrale possédée)
        if (candidate.ownershipStatus === 'owned' || candidate.ownedViaIntegral) continue;
        // On alerte sur les tomes suivants (> maxOwnedVol) ou sur les tomes sans numéro non possédés
        if (maxOwnedVol > 0 && candidate.volumeNumber !== null && candidate.volumeNumber <= maxOwnedVol) {
          continue;
        }

        const inserted = this.notifRepo.createAlertIfAbsent({
          id: `alt_${crypto.randomBytes(6).toString('hex')}`,
          libraryId,
          seriesId,
          bookId: candidate.id,
          detectedAt: now
        });
        if (inserted) newAlertsCount++;
      }
    }

    return { checkedSeriesCount: followedSeriesIds.size, newAlertsCount };
  }

  dismissAlerts(libraryId: string, alertId?: string): { dismissedCount: number } {
    const now = new Date().toISOString();
    if (alertId) {
      const ok = this.notifRepo.dismissAlert(libraryId, alertId, now);
      return { dismissedCount: ok ? 1 : 0 };
    }
    return { dismissedCount: this.notifRepo.dismissAllAlerts(libraryId, now) };
  }

  /**
   * Passe horaire de distribution des digests Push VAPID / E-mail Resend selon le fuseau horaire de chaque utilisateur.
   */
  async runHourlyDigestDispatch(nowDate = new Date()): Promise<{ notifiedUsers: number; pushSent: number; emailsSent: number }> {
    const rows = this.notifRepo.listEnabledPrefsWithUsers();
    let notifiedUsers = 0;
    let pushSent = 0;
    let emailsSent = 0;

    for (const pref of rows) {
      const local = getLocalPartsInTimezone(nowDate, pref.timezone);
      if (local.hour !== pref.hour) continue;
      if (pref.frequency === 'weekly' && local.dayOfWeek !== pref.day_of_week) continue;
      if (pref.frequency === 'monthly' && local.dayOfMonth !== pref.day_of_month) continue;

      // Évite un double envoi le même jour local
      if (pref.last_notified_at) {
        const lastLocal = getLocalPartsInTimezone(new Date(pref.last_notified_at), pref.timezone);
        if (lastLocal.dateKey === local.dateKey) continue;
      }

      const alerts = this.listActiveReleaseAlerts(pref.library_id);
      if (alerts.length === 0) continue;

      const summaryTitle = `${alerts.length} nouveauté(s) dans vos séries`;
      const summaryBody = alerts
        .slice(0, 5)
        .map((a) => `${a.seriesName} — ${a.book.title}`)
        .join(', ');

      let delivered = false;

      if (pref.channel === 'push' || pref.channel === 'both') {
        const subs = this.notifRepo.listPushSubscriptions(pref.user_id);
        for (const sub of subs) {
          const res = await this.webPushSender.sendNotification(
            { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
            { title: summaryTitle, body: summaryBody, url: '/releases' }
          );
          if (res.sent) {
            pushSent++;
            delivered = true;
          } else if (res.gone) {
            this.notifRepo.deletePushSubscription(pref.user_id, sub.endpoint);
          }
        }
      }

      if (pref.channel === 'email' || pref.channel === 'both') {
        const mailRes = await this.mailSender.sendEmail({
          to: pref.email,
          subject: `${summaryTitle} — Ma Bibliothèque Cloud`,
          html: `<p>Bonjour ${pref.username},</p><p>De nouvelles sorties sont disponibles dans vos séries suivies :</p><ul>${alerts
            .slice(0, 10)
            .map((a) => `<li><strong>${a.seriesName}</strong> : ${a.book.title}</li>`)
            .join('')}</ul>`
        });
        if (mailRes.sent) {
          emailsSent++;
          delivered = true;
        }
      }

      if (delivered) {
        this.notifRepo.markNotified(pref.user_id, nowDate.toISOString());
        notifiedUsers++;
      }
    }

    return { notifiedUsers, pushSent, emailsSent };
  }
}
