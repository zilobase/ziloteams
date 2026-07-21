# Deployment guide

This guide deploys the production API to `teams.zilobase.com`, backed by Cloudflare D1, Durable Objects, R2, Queues, and Email Sending.

## 1. Authenticate and create resources

```sh
npx wrangler login
npx wrangler d1 create ziloteams
npx wrangler r2 bucket create ziloteams-attachments
npx wrangler r2 bucket create ziloteams-releases
npx wrangler queues create ziloteams-cleanup
npx wrangler queues create ziloteams-cleanup-dlq
```

Copy the D1 database ID into `apps/api/wrangler.jsonc`. Confirm that `teams.zilobase.com` and the sender domain are active in the same Cloudflare account. Enable Email Sending, verify `no-reply@zilobase.com`, and change both `OTP_SENDER` and `allowed_sender_addresses` if a different sender is used.

The `routes` entry configures `teams.zilobase.com` as a Worker custom domain. Change `PUBLIC_BASE_URL`, the route, and the release URLs in `scripts/make-release.mjs` together when using another hostname.

## 2. Configure secrets

Generate three independent values of at least 32 random bytes. Do not reuse them or put them in `wrangler.jsonc`.

```sh
openssl rand -hex 32 | npx wrangler secret put OTP_HMAC_KEY --config apps/api/wrangler.jsonc
openssl rand -hex 32 | npx wrangler secret put INVITE_HMAC_KEY --config apps/api/wrangler.jsonc
openssl rand -hex 32 | npx wrangler secret put FILE_SIGNING_KEY --config apps/api/wrangler.jsonc
```

For local development only, copy `.dev.vars.example` to `.dev.vars` and replace every placeholder. Both files are ignored except the example.

## 3. Migrate and deploy

```sh
npm ci
npm run check
npx wrangler d1 migrations apply DB --remote --config apps/api/wrangler.jsonc
npx wrangler deploy --config apps/api/wrangler.jsonc
curl -fsS https://teams.zilobase.com/health
```

Apply D1 migrations before deploying code that depends on them. Durable Object migrations are applied by the Worker deploy. The hourly cron removes expired authentication data and re-enqueues incomplete attachment/channel cleanup jobs.

For automated deploys, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets. The token needs Workers Scripts, D1, R2, Queues, and account read permissions scoped to this account.

## 4. Create release signing keys

Create an offline signing key once. Store the private key in a secrets manager and the GitHub Actions secret `RELEASE_PRIVATE_KEY_PEM`. Store the public key as `RELEASE_PUBLIC_KEY_PEM`.

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out ziloteams-release-private.pem
openssl pkey -in ziloteams-release-private.pem -pubout -out ziloteams-release-public.pem
```

The release workflow embeds only the public key in the compiled client and installer. It builds four standalone binaries with Bun, signs both release manifests, and uploads immutable artifacts plus the current manifests to the private release bucket. Never rotate the key without also publishing a migration path for already-installed clients.

Create a release by updating all workspace versions together, merging the change, and pushing the matching tag:

```sh
git tag v2.0.0
git push origin v2.0.0
```

## 5. Operational checks

- Confirm OTP delivery to a test mailbox and verify cooldown/rate-limit behavior.
- Create an organization, invite a second email, and confirm a different signed-in email cannot redeem the code.
- Remove the second account and verify its open WebSocket closes immediately.
- Upload, open, and delete a file; check the cleanup queue and R2 object removal.
- Test both `curl -fsSL https://teams.zilobase.com/install.sh | sh` and `ziloteams update` on a non-production machine.
- Monitor structured Worker logs, Queue dead letters, D1 errors, and Durable Object exceptions.

## Rollback

Use Cloudflare Worker version rollback for application code. Database migrations in this repository are additive and should receive a forward corrective migration; do not destructively roll back D1. Release manifests are mutable pointers, so restore the previous signed `latest.json`, `latest.json.sig`, `latest.env`, and `latest.env.sig` while leaving immutable versioned binaries in place.
