import { Injectable, Logger } from '@nestjs/common';

import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import configuration from 'src/config/configuration';

@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);
  private configuration = configuration;

  constructor() {}

  createOAuth2Client(): OAuth2Client {
    const clientId = this.configuration().google.clientId;
    const clientSecret = this.configuration().google.clientSecret;
    const redirectUri = this.configuration().google.redirectUri;

    if (!clientId || !clientSecret) {
      this.logger.warn('Missing Google OAuth credentials');
      throw new Error('OAuth credentials not configured');
    }

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  getGmailClient(accessToken: string): gmail_v1.Gmail {
    const oauth2Client = this.createOAuth2Client();
    oauth2Client.setCredentials({ access_token: accessToken });
    return google.gmail({ version: 'v1', auth: oauth2Client });
  }

  async refreshAccessToken(refreshToken: string) {
    this.logger.log('Attempting to refresh token...');

    const oauth2Client = this.createOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();

      if (!credentials.access_token) {
        throw new Error('No access token received from refresh');
      }

      this.logger.log(
        `Token refresh successful, new expiry: ${
          credentials.expiry_date
            ? new Date(credentials.expiry_date).toISOString()
            : 'unknown'
        }`,
      );

      return {
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token || refreshToken,
        expiryDate: credentials.expiry_date,
      };
    } catch (error) {
      this.logger.error(`Error refreshing token: ${error.message}`);
      throw error;
    }
  }

  async getEmails(accessToken: string, labelId = 'INBOX', options = {}) {
    const defaultOptions = {
      maxResults: 50,
      pageToken: null,
      ...options,
    };

    try {
      const gmail = this.getGmailClient(accessToken);

      // Get message list
      //@ts-ignore
      const response = await gmail.users.messages.list({
        userId: 'me',
        labelIds: [labelId],
        maxResults: defaultOptions.maxResults,
        pageToken: defaultOptions.pageToken,
      });
      //@ts-ignore
      if (!response.data.messages || response.data.messages.length === 0) {
        return [];
      }

      // Get full message details
      const messages = await Promise.all(
        //@ts-ignore
        response.data.messages.map(async (message) => {
          try {
            const { data } = await gmail.users.messages.get({
              userId: 'me',
              id: message.id,
              format: 'full',
            });

            return this.parseGmailMessage(data);
          } catch (error) {
            this.logger.error(
              `Error fetching message ${message.id}: ${error.message}`,
            );
            return null;
          }
        }),
      );

      // Filter out null values (failed messages)
      const validMessages = messages.filter((message) => message !== null);

      // Add the next page token to the result
      const result = validMessages as any;
      //@ts-ignore
      result.nextPageToken = response.data.nextPageToken;

      return result;
    } catch (error) {
      this.logger.error(`Error getting emails: ${error.message}`);
      throw error;
    }
  }

  parseGmailMessage(message: gmail_v1.Schema$Message) {
    if (!message || !message.id) {
      this.logger.warn('Received invalid message object');
      return null;
    }

    try {
      const headers = message.payload?.headers || [];

      // Extract headers
      const subject =
        headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ||
        '(No subject)';
      const from =
        headers.find((h) => h.name?.toLowerCase() === 'from')?.value || '';
      const to =
        headers.find((h) => h.name?.toLowerCase() === 'to')?.value || '';
      const cc =
        headers.find((h) => h.name?.toLowerCase() === 'cc')?.value || '';
      const date =
        headers.find((h) => h.name?.toLowerCase() === 'date')?.value || '';

      // Parse sender
      const senderMatch = from.match(/(?:"?([^"]*)"?\s)?(?:<?(.+@[^>]+)>?)/);
      const sender = {
        name: senderMatch ? senderMatch[1] || senderMatch[2] : 'Unknown',
        email: senderMatch ? senderMatch[2] : from,
      };

      // Parse recipients
      const parseRecipients = (recipientString: string) => {
        if (!recipientString) return [];

        return recipientString.split(',').map((recipient) => {
          const match = recipient
            .trim()
            .match(/(?:"?([^"]*)"?\s)?(?:<?(.+@[^>]+)>?)/);
          return {
            name: match ? match[1] || match[2] : recipient.trim(),
            email: match ? match[2] : recipient.trim(),
          };
        });
      };

      const toRecipients = parseRecipients(to);
      const ccRecipients = parseRecipients(cc);

      // Get body content
      let body = '';
      let bodyPlain = '';

      if (message.payload?.parts) {
        // Multipart message
        for (const part of message.payload.parts) {
          if (part.mimeType === 'text/html' && part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          } else if (part.mimeType === 'text/plain' && part.body?.data) {
            bodyPlain = Buffer.from(part.body.data, 'base64').toString('utf-8');
          }

          // Handle nested multipart
          if (part.parts) {
            for (const nestedPart of part.parts) {
              if (
                nestedPart.mimeType === 'text/html' &&
                nestedPart.body?.data
              ) {
                body = Buffer.from(nestedPart.body.data, 'base64').toString(
                  'utf-8',
                );
              } else if (
                nestedPart.mimeType === 'text/plain' &&
                nestedPart.body?.data
              ) {
                bodyPlain = Buffer.from(
                  nestedPart.body.data,
                  'base64',
                ).toString('utf-8');
              }
            }
          }
        }
      } else if (message.payload?.body?.data) {
        // Simple message
        const content = Buffer.from(
          message.payload.body.data,
          'base64',
        ).toString('utf-8');
        if (message.payload.mimeType === 'text/html') {
          body = content;
        } else {
          bodyPlain = content;
        }
      }

      // If no HTML body was found, use plain text
      if (!body && bodyPlain) {
        body = bodyPlain.replace(/\n/g, '<br>');
      }

      // Extract preview (snippet or first part of body)
      const preview =
        message.snippet ||
        bodyPlain.substring(0, 100) ||
        body.substring(0, 100).replace(/<[^>]*>/g, '');

      // Parse attachments
      const attachments = [];

      const processAttachments = (parts?: gmail_v1.Schema$MessagePart[]) => {
        if (!parts) return;

        for (const part of parts) {
          if (
            part.filename &&
            part.filename.length > 0 &&
            part.body?.attachmentId
          ) {
            //@ts-ignore
            attachments.push({
              id: part.body.attachmentId,
              name: part.filename,
              contentType: part.mimeType || 'application/octet-stream',
              //@ts-ignore
              size: Number.parseInt(part.body.size || '0'),
            });
          }

          // Process nested parts
          if (part.parts) {
            processAttachments(part.parts);
          }
        }
      };

      processAttachments(message.payload?.parts);

      return {
        id: message.id,
        subject,
        sender,
        to: toRecipients,
        cc: ccRecipients.length > 0 ? ccRecipients : undefined,
        date: new Date(date).toISOString(),
        body,
        preview,
        read: !message.labelIds?.includes('UNREAD'),
        starred: message.labelIds?.includes('STARRED') || false,
        folder: message.labelIds?.includes('INBOX')
          ? 'inbox'
          : message.labelIds?.includes('SENT')
            ? 'sent'
            : message.labelIds?.includes('DRAFT')
              ? 'drafts'
              : message.labelIds?.includes('TRASH')
                ? 'trash'
                : 'archive',
        attachments: attachments.length > 0 ? attachments : undefined,
      };
    } catch (error) {
      this.logger.error(
        `Error parsing Gmail message ${message.id}: ${error.message}`,
      );
      return null;
    }
  }

  async getMailLabels(accessToken: string) {
    try {
      const gmail = this.getGmailClient(accessToken);
      const { data } = await gmail.users.labels.list({
        userId: 'me',
      });
      return data.labels || [];
    } catch (error) {
      this.logger.error(`Error getting mail labels: ${error.message}`);
      throw error;
    }
  }
}
