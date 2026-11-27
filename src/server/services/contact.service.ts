// src/server/services/contact.service.ts
// Service d'envoi du formulaire de contact vers l'administrateur (SMTP Infomaniak / Resend)
// avec protection anti-spam (honeypot + rate-limit fenêtre glissante) et échappement HTML strict.

import { APP_VERSION_LABEL } from '../../shared/version';
import type { ContactCategory, ContactMessageInput } from '../../shared/schemas';
import type { ServerConfig } from '../config';
import type { MailSender } from '../connectors/resend.connector';
import type { AuthSessionContext } from './auth.service';
import { AppError } from '../middleware/error.middleware';

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_PER_WINDOW = 3;

const CATEGORY_LABELS: Record<ContactCategory, string> = {
  question: 'Question',
  bug: 'Signalement de bug',
  suggestion: 'Suggestion',
  other: 'Autre demande'
};

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHeaderText(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').trim();
}

export class ContactService {
  private readonly config: ServerConfig;
  private readonly mailSender: MailSender;
  private readonly recentHitsByKey = new Map<string, number[]>();

  constructor(deps: { config: ServerConfig; mailSender: MailSender }) {
    this.config = deps.config;
    this.mailSender = deps.mailSender;
  }

  private resolveDestinationEmail(): string {
    return this.config.contactEmail || this.config.smtpUser || this.config.adminEmail || '';
  }

  private checkRateLimit(rateKey: string, nowMs: number): void {
    const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;
    const prev = (this.recentHitsByKey.get(rateKey) ?? []).filter((ts) => ts > cutoff);
    if (prev.length >= RATE_LIMIT_MAX_PER_WINDOW) {
      this.recentHitsByKey.set(rateKey, prev);
      throw new AppError(
        429,
        'CONTACT_RATE_LIMITED',
        'Vous avez déjà envoyé plusieurs messages récemment. Merci de patienter quelques minutes avant de réessayer.'
      );
    }
    prev.push(nowMs);
    this.recentHitsByKey.set(rateKey, prev);

    // Écrêtage défensif pour éviter toute croissance mémoire non bornée
    if (this.recentHitsByKey.size > 2000) {
      for (const [k, list] of this.recentHitsByKey) {
        const fresh = list.filter((ts) => ts > cutoff);
        if (fresh.length === 0) this.recentHitsByKey.delete(k);
        else this.recentHitsByKey.set(k, fresh);
      }
    }
  }

  async sendContactMessage(params: {
    input: ContactMessageInput;
    clientKey: string;
    viewerAuth: AuthSessionContext | null;
  }): Promise<{ delivered: boolean }> {
    // Honeypot : si un robot remplit le champ caché `website`, accepter silencieusement sans envoyer de mail
    if (params.input.website && params.input.website.trim().length > 0) {
      return { delivered: true };
    }

    this.checkRateLimit(params.clientKey, Date.now());

    const destination = this.resolveDestinationEmail();
    if (!destination) {
      throw new AppError(
        503,
        'CONTACT_NOT_CONFIGURED',
        'La messagerie de contact n’est pas encore configurée sur ce serveur.'
      );
    }

    const categoryLabel = CATEGORY_LABELS[params.input.category] ?? 'Contact';
    const customSubject = sanitizeHeaderText(params.input.subject ?? '');
    const emailSubject = customSubject
      ? `[Ma Bibliothèque Cloud · ${categoryLabel}] ${customSubject}`
      : `[Ma Bibliothèque Cloud · ${categoryLabel}] Message de ${sanitizeHeaderText(
          params.viewerAuth?.username || params.input.senderName || params.input.email
        )}`;

    const senderDisplay =
      params.viewerAuth?.username || params.input.senderName?.trim() || 'Visiteur non connecté';
    const senderEmail = sanitizeHeaderText(params.input.email);
    const pageUrl = sanitizeHeaderText(params.input.pageUrl ?? '/');
    const cleanMessage = params.input.message.trim();

    const textLines = [
      `Nouveau message depuis Ma Bibliothèque Cloud (${APP_VERSION_LABEL})`,
      '',
      `Catégorie : ${categoryLabel}`,
      `Expéditeur : ${senderDisplay} <${senderEmail}>`,
      params.viewerAuth ? `Compte : ${params.viewerAuth.username} (${params.viewerAuth.userId})` : 'Compte : Non connecté',
      `Page d'origine : ${pageUrl}`,
      customSubject ? `Objet : ${customSubject}` : null,
      '',
      '--- Message ---',
      cleanMessage
    ].filter((line): line is string => line !== null);

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2937; max-width: 640px; line-height: 1.55;">
        <h2 style="margin: 0 0 12px; color: #111827;">Nouveau message — ${escapeHtml(categoryLabel)}</h2>
        <table style="border-collapse: collapse; margin-bottom: 16px; font-size: 14px;">
          <tr><td style="padding: 4px 12px 4px 0; color: #6b7280;">Expéditeur :</td><td><strong>${escapeHtml(senderDisplay)}</strong> (${escapeHtml(senderEmail)})</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #6b7280;">Statut :</td><td>${params.viewerAuth ? `Connecté (<code>${escapeHtml(params.viewerAuth.userId)}</code>)` : 'Non connecté'}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0; color: #6b7280;">Page :</td><td><code>${escapeHtml(pageUrl)}</code></td></tr>
          ${customSubject ? `<tr><td style="padding: 4px 12px 4px 0; color: #6b7280;">Objet :</td><td>${escapeHtml(customSubject)}</td></tr>` : ''}
        </table>
        <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; white-space: pre-wrap;">${escapeHtml(cleanMessage)}</div>
        <p style="margin-top: 16px; font-size: 12px; color: #6b7280;">
          Astuce : cliquez simplement sur « Répondre » pour écrire directement à ${escapeHtml(senderEmail)}.<br>
          Envoyé via Ma Bibliothèque Cloud ${escapeHtml(APP_VERSION_LABEL)}.
        </p>
      </div>
    `.trim();

    try {
      const result = await this.mailSender.sendEmail({
        to: destination,
        subject: emailSubject,
        html,
        text: textLines.join('\n'),
        replyTo: senderEmail
      });
      return { delivered: result.sent };
    } catch (err) {
      console.error('[CONTACT] Échec envoi e-mail de contact:', err);
      throw new AppError(
        502,
        'CONTACT_DELIVERY_FAILED',
        'Impossible d’envoyer le message pour le moment. Merci de réessayer dans quelques instants.'
      );
    }
  }
}
