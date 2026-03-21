import type { Config } from './types';
import { mkdir } from 'node:fs/promises';
import { createLogger } from '@crowlog/logger';
import { triggerWebhook } from '@owlrelay/webhook';
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';

const logger = createLogger({ namespace: 'papra-intake' });

function loadConfig(): Config {
  const host = Bun.env.IMAP_HOST;
  const user = Bun.env.IMAP_USER;
  const pass = Bun.env.IMAP_PASS;

  if (!host || !user || !pass) {
    throw new Error('Missing required IMAP config: IMAP_HOST, IMAP_USER, IMAP_PASS');
  }

  const webhookUrl = Bun.env.WEBHOOK_URL;
  const webhookSecret = Bun.env.WEBHOOK_SECRET;
  const outputDir = Bun.env.OUTPUT_DIR;

  if (!webhookUrl && !outputDir) {
    throw new Error('At least one output must be configured: WEBHOOK_URL or OUTPUT_DIR');
  }

  return {
    imap: {
      host,
      port: Number(Bun.env.IMAP_PORT ?? '993'),
      secure: Bun.env.IMAP_SECURE !== 'false',
      auth: { user, pass },
      folder: Bun.env.IMAP_FOLDER ?? 'INBOX',
      processedFolder: Bun.env.IMAP_PROCESSED_FOLDER,
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
  await mkdir(config.directory, { recursive: true });

  const attachments = (email.attachments as Array<{ filename?: string; content: Uint8Array; mimeType?: string }>) ?? [];

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const filename = attachment.filename || `attachment_${i}`;
    const destination = Bun.file(`${config.directory}/${filename}`);
    await Bun.write(destination, attachment.content);
    logger.info({ requestId, filename }, 'Saved attachment');
  }
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

async function processUnseen(client: ImapFlow, config: Config) {
  const searchResult = await client.search({ seen: false }, { uid: true });
  const uids = searchResult || [];

  if (uids.length === 0) {
    return;
  }

  logger.info({ count: uids.length }, 'Found unseen messages');

  for (const uid of uids) {
    try {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });

      if (!message || !message.source) {
        logger.warn({ uid }, 'Message has no source, skipping');
        continue;
      }

      await processMessage(message.source, config);
      await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });

      if (config.imap.processedFolder) {
        try {
          await client.messageMove({ uid }, config.imap.processedFolder, { uid: true });
          logger.info({ uid, folder: config.imap.processedFolder }, 'Moved to processed folder');
        } catch (moveError) {
          logger.warn({ error: moveError, uid }, 'Failed to move message to processed folder');
        }
      }
    } catch (error) {
      logger.error({ error, uid }, 'Failed to process message');
    }
  }
}

async function watchMailbox(config: Config, running: { value: boolean }) {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: config.imap.auth,
    logger: false,
  });

  client.on('error', (error: Error) => {
    logger.error({ error }, 'IMAP connection error');
  });

  try {
    await client.connect();
    logger.info({ host: config.imap.host, folder: config.imap.folder }, 'Connected to IMAP server');

    const lock = await client.getMailboxLock(config.imap.folder);

    try {
      // Process any unseen messages that arrived while disconnected
      await processUnseen(client, config);

      // Hold the connection open with IDLE, reacting to new mail instantly
      while (running.value) {
        try {
          await client.idle();
        } catch (idleError) {
          // IDLE can fail if the connection drops — break out to reconnect
          if (running.value) {
            logger.warn({ error: idleError }, 'IDLE interrupted');
          }
          break;
        }

        // IDLE resolved — mailbox changed, check for new messages
        await processUnseen(client, config);
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (error) {
    logger.error({ error }, 'IMAP connection failed');
    try {
      await client.close();
    } catch {
      // ignore close errors after failure
    }
  }
}

async function main() {
  const config = loadConfig();

  logger.info({
    host: config.imap.host,
    folder: config.imap.folder,
    webhookEnabled: !!config.webhook,
    outputEnabled: !!config.output,
  }, 'Starting papra-intake service');

  const running = { value: true };

  function shutdown() {
    logger.info('Shutting down...');
    running.value = false;
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Persistent connection with IDLE; reconnect on failure
  while (running.value) {
    try {
      await watchMailbox(config, running);
    } catch (error) {
      logger.error({ error }, 'Unexpected error');
    }

    if (running.value) {
      logger.info('Reconnecting in 5s...');
      await Bun.sleep(5000);
    }
  }
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
