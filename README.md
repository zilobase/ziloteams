# ZiloTeams

ZiloTeams is an invite-only, Slack-style terminal workspace. A verified account can create an organization or join one with an email-bound invite code. Organization members share channels, live presence, message history, and file attachments; administrators control invitations, roles, members, and channels.

## Product behavior

- First run asks whether to create or join an organization, then verifies the account with a six-digit email code.
- Creating an organization makes the creator its first administrator and creates `#general`.
- Only administrators see `/invite`. An invite is bound to one normalized email address, expires after seven days, works once, and displays its code once.
- `/switch` changes, creates, or joins organizations. `/channels` switches channels.
- The main terminal view shows channels, messages, channel details, and active users. Mouse clicks work for channels, commands, and attachments.
- Files are private in R2. Members receive a ten-minute signed access URL; only an explicit media allowlist renders inline.
- Sessions last 30 days. The local token is stored in a mode-`0600` configuration file.

## Architecture

```text
standalone CLI
  ├─ HTTPS/OTP/admin API ── Cloudflare Worker
  │                         ├─ D1: accounts, organizations, membership, invites
  │                         ├─ R2: private attachments and signed releases
  │                         ├─ Email Sending: OTP delivery
  │                         └─ Queues + cron: retryable cleanup
  └─ WebSocket ──────────── Durable Object per channel
                            └─ SQLite message history + live presence
```

The repository is an npm workspace. Shared API contracts live in `packages/contracts`, the Worker in `apps/api`, and the terminal client in `apps/cli`. End users install a compiled standalone binary and do not need Node.js, Bun, npm, or a source checkout.

## Install the CLI

After the first release is published:

```sh
curl -fsSL https://teams.zilobase.com/install.sh | sh
ziloteams
```

The installer supports macOS and Linux on arm64 and x64. It verifies a signed release manifest and the selected binary's SHA-256 digest before installing to `~/.local/bin`. Override the location with `ZILOTEAMS_INSTALL_DIR`. Run `ziloteams update` for a verified in-place update.

## Commands

Type `/` in the message field to open the command palette.

| Command | Access | Purpose |
|---|---|---|
| `/channels` | Member | List and switch channels |
| `/switch` | Member | Switch, create, or join an organization |
| `/upload` | Member | Upload a file up to 25 MiB |
| `/delete` | Member | Delete your message; admins can delete any message |
| `/settings` | Member | Profile settings; admins also manage the workspace |
| `/invite` | Admin | Create an email-bound, single-use invite |
| `/help` | Member | Show shortcuts |
| `/quit` | Member | Exit |

## Local development

Requirements: Node.js 24+, npm 11+, and a Cloudflare account for remote services.

```sh
npm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
npm run types:worker
npm run check
```

Create local D1 state and start the API:

```sh
npx wrangler d1 migrations apply DB --local --config apps/api/wrangler.jsonc
npm run dev:api
```

In another terminal:

```sh
ZILOTEAMS_API_URL=http://127.0.0.1:8787/api/v1 npm run dev:cli
```

The Email Sending binding requires a configured sender for real OTP delivery. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for resource creation, secrets, deploys, and releases.

## Verification

```sh
npm run check
npm run build --workspace @ziloteams/api
```

`npm run check` regenerates Worker types, performs strict TypeScript checks across all workspaces, and runs the test suite.

## Security

Please read [SECURITY.md](SECURITY.md) before operating the service. Never commit `.dev.vars`, Cloudflare API tokens, HMAC secrets, or the release private key.

## License

MIT
