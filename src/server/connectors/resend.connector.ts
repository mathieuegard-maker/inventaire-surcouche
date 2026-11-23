// src/server/connectors/resend.connector.ts
// Connecteur d'envoi d'e-mails via Resend (fallback console en développement si clé absente).

export interface MailSender {
  sendEmail(params: { to: string; subject: string; html: string }): Promise<{ sent: boolean; providerId?: string }>;
}

export function createResendConnector(apiKey: string, mailFrom: string): MailSender {
  return {
    async sendEmail({ to, subject, html }) {
      if (!apiKey) {
        console.info(`[MAIL DEV FALLBACK] To: ${to} | Subject: ${subject}`);
        return { sent: false };
      }

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: mailFrom,
          to: [to],
          subject,
          html
        })
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
