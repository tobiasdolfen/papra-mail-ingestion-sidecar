# Custom Papra Mail Ingestion Sidecar

This is a custom adapted version of [Papra EMail Proxy](https://github.com/papra-hq/email-proxy/tree/main) to ingest mail via IMAP. It watches an IMAP mailbox for new emails and delivers them to Papra either by writing attachments directly to a mounted ingestion folder or by triggering the Papra webhook — or both.

Designed to run as a Docker sidecar alongside Papra or as a standalone service.

**Source:** [GitLab](https://gitlab.com/TDolfen/papra-mail-ingestion-sidecar) (primary) | [GitHub](https://github.com/tobiasdolfen/papra-mail-ingestion-sidecar) (mirror)

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Required | Default | Description |
|---|---|---|---|
| `IMAP_HOST` | Yes | — | IMAP server hostname |
| `IMAP_PORT` | No | `993` | IMAP server port |
| `IMAP_SECURE` | No | `true` | Use TLS |
| `IMAP_USER` | Yes | — | IMAP username |
| `IMAP_PASS` | Yes | — | IMAP password |
| `IMAP_FOLDER` | No | `INBOX` | Folder to watch |
| `IMAP_PROCESSED_FOLDER` | No | — | Folder to move processed messages to (if unset, messages stay in place) |
| `WEBHOOK_URL` | No* | — | Papra webhook endpoint (`https://<your-instance>/api/intake-emails/ingest`) |
| `WEBHOOK_SECRET` | No* | — | Webhook auth secret (same as `INTAKE_EMAILS_WEBHOOK_SECRET` in Papra) |
| `OUTPUT_DIR` | No* | — | Directory to save attachments (e.g. Papra's ingestion folder) |

\* At least one output (`WEBHOOK_URL` or `OUTPUT_DIR`) must be configured.

## Usage

### Docker Compose (recommended)

```yaml
services:
  papra-intake:
    image: registry.gitlab.com/tdolfen/papra-mail-ingestion-sidecar:latest
    restart: unless-stopped
    env_file: .env
    volumes:
      - /path/to/papra/ingestion:/app/output  # optional: mount Papra ingestion folder
```

Or build locally:

```bash
docker compose up -d
```

### Manual

Requires [Bun](https://bun.sh).

```bash
bun install
bun run start
```

For development with file watching:

```bash
bun run dev
```

## How It Works

1. Connects to the configured IMAP mailbox
2. Processes any unseen messages from the watched folder
3. Parses each email with `postal-mime`
4. Delivers to configured outputs:
   - **Webhook**: sends the parsed email to Papra's intake endpoint via `@owlrelay/webhook`
   - **Directory**: saves attachments to `OUTPUT_DIR/`
5. Marks processed messages as seen (optionally moves them to a processed folder)
6. Holds the connection open using IMAP IDLE, reacting instantly when new mail arrives
7. Automatically reconnects on connection failure

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for more information.

## Credits and Acknowledgements

This project is based on [Papra - Email proxy](https://github.com/papra-hq/email-proxy) by [Corentin Thomasset](https://corentin.tech).
