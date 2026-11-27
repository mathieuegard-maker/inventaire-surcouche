// src/server/connectors/resend.connector.ts
// Connecteur d'envoi d'e-mails via Resend (fallback console en développement si clé absente).

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface MailSender {
  sendEmail(params: MailMessage): Promise<{ sent: boolean; providerId?: string }>;
}

export function createResendConnector(apiKey: string, mailFrom: string): MailSender {
  return {
    async sendEmail({ to, subject, html, text, replyTo }) {
      if (!apiKey) {
        console.info(`[MAIL DEV FALLBACK] To: ${to} | Subject: ${subject}`);
        return { sent: false };
      }

      const payload: Record<string, unknown> = {
        from: mailFrom,
        to: [to],
        subject,
        html
      };
      if (text) payload.text = text;
      if (replyTo) payload.reply_to = replyTo;

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Resend HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { sent: true, providerId: data.id };
    }
  };
}
