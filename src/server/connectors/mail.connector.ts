// src/server/connectors/mail.connector.ts
// Connecteur unifié d'envoi d'e-mails : SMTP authentifié (ex. Infomaniak mail.infomaniak.com:465) en priorité,
// puis Resend API si RESEND_API_KEY est configurée, sinon repli console développement.

import nodemailer from 'nodemailer';
import type { ServerConfig } from '../config';
import { createResendConnector, type MailMessage, type MailSender } from './resend.connector';

export interface SmtpConnectorOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailFrom: string;
}

export function createSmtpMailConnector(options: SmtpConnectorOptions): MailSender {
  const transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: {
      user: options.user,
      pass: options.pass
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  });

  return {
    async sendEmail(params: MailMessage): Promise<{ sent: boolean; providerId?: string }> {
      const info = await transporter.sendMail({
        from: options.mailFrom,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        replyTo: params.replyTo
      });
      return {
        sent: true,
        providerId: typeof info.messageId === 'string' ? info.messageId : undefined
      };
    }
  };
}

export function createMailConnector(config: ServerConfig): MailSender {
  if (config.smtpHost && config.smtpUser && config.smtpPass) {
    return createSmtpMailConnector({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      user: config.smtpUser,
      pass: config.smtpPass,
      mailFrom: config.mailFrom
    });
  }
  return createResendConnector(config.resendApiKey, config.mailFrom);
}
