import type { Config } from './types';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { createLogger } from '@crowlog/logger';
import { triggerWebhook } from '@owlrelay/webhook';
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';

const logger = createLogger({ namespace: 'papra-intake' });

function loadConfig(): Config {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;

  if (!host || !user || !pass) {
    throw new Error('Missing required IMAP config: IMAP_HOST, IMAP_USER, IMAP_PASS');
  }

  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const outputDir = process.env.OUTPUT_DIR;

  if (!webhookUrl && !outputDir) {
    throw new Error('At least one output must be configured: WEBHOOK_URL or OUTPUT_DIR');
  }

  return {
    imap: {
      host,
      port: Number(process.env.IMAP_PORT ?? '993'),
      secure: process.env.IMAP_SECURE !== 'false',
      auth: { user, pass },
      folder: process.env.IMAP_FOLDER ?? 'INBOX',
      pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? '30000'),
    },
    webhook: webhookUrl && webhookSecret ? { url: webhookUrl, secret: webhookSecret } : undefined,
    output: outputDir ? { directory: outputDir } : undefined,
  };
}

function createRequestId({ now = new Date() }: { now?: Date } = {}) {
  return `req_${now.getTime()}${Math.random().toString(36).substring(2, 15)}`;
}

async function deliverToWebhook(email: Record<string, unknown>, config: NonNullable<Config['webhook']>) {
  await triggerWebhook({ email: email as any, webhookUrl: config.url, webhookSecret: config.secret });
}

async function deliverToDirectory(email: Record<string, unknown>, config: NonNullable<Config['output']>, requestId: string) {
  const dir = join(config.directory, requestId);
  await mkdir(dir, { recursive: true });

  const attachments = (email.attachments as Array<{ filename?: string; content: Uint8Array; mimeType?: string }>) ?? [];

  for (const attachment of attachments) {
    const filename = attachment.filename || `attachment_${attachments.indexOf(attachment)}`;
    await writeFile(join(dir, filename), attachment.content);
    logger.info({ requestId, filename }, 'Saved attachment');
  }

  const { attachments: _, ...metadata } = email;
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
}

async function processMessage(source: Uint8Array, config: Config) {
  const requestId = createRequestId();
  const parser = new PostalMime();
  const email = await parser.parse(source);

  logger.info({
    from: email.from,
    to: email.to,
    subject: email.subject,
    attachments: email.attachments?.length ?? 0,
    requestId,
  }, 'Processing email');

  const emailData = email as unknown as Record<string, unknown>;

  if (config.webhook) {
    try {
      await deliverToWebhook(emailData, config.webhook);
      logger.info({ requestId }, 'Webhook delivered');
    } catch (error) {
      logger.error({ error, requestId }, 'Webhook delivery failed');
    }
  }

  if (config.output) {
    try {
      await deliverToDirectory(emailData, config.output, requestId);
      logger.info({ requestId }, 'Saved to directory');
    } catch (error) {
      logger.error({ error, requestId }, 'Directory delivery failed');
    }
  }
}

async function pollMailbox(config: Config) {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: config.imap.auth,
    logger: false,
  });

  try {
    await client.connect();
    logger.info({ host: config.imap.host, folder: config.imap.folder }, 'Connected to IMAP server');

    const lock = await client.getMailboxLock(config.imap.folder);

    try {
      const messages = client.fetch({ seen: false }, { source: true, uid: true });

      for await (const message of messages) {
        try {
          if (!message.source) {
            logger.warn({ uid: message.uid }, 'Message has no source, skipping');
            continue;
          }
          await processMessage(message.source, config);
          await client.messageFlagsAdd({ uid: message.uid }, ['\\Seen'], { uid: true });
        } catch (error) {
          logger.error({ error, uid: message.uid }, 'Failed to process message');
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (error) {
    logger.error({ error }, 'IMAP polling failed');
    try {
      await client.logout();
    } catch {
      // ignore logout errors after failure
    }
  }
}

async function main() {
  const config = loadConfig();

  logger.info({
    host: config.imap.host,
    folder: config.imap.folder,
    pollIntervalMs: config.imap.pollIntervalMs,
    webhookEnabled: !!config.webhook,
    outputEnabled: !!config.output,
  }, 'Starting papra-intake service');

  let running = true;

  function shutdown() {
    logger.info('Shutting down...');
    running = false;
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // eslint-disable-next-line no-unmodified-loop-condition
  while (running) {
    await pollMailbox(config);
    if (running) {
      await new Promise(resolve => setTimeout(resolve, config.imap.pollIntervalMs));
    }
  }
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
