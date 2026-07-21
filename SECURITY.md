# Security policy

## Reporting

Do not open a public issue for a vulnerability. Send a private report to the repository owner with the affected version, reproduction steps, impact, and any suggested mitigation. Avoid accessing data that is not yours while validating a report.

## Security model

- Accounts are authenticated through short-lived email OTPs. Organizations are invite-only, and invite redemption requires the authenticated account email to exactly match the normalized invited email.
- Authorization is enforced by the Worker on every HTTP request. The Durable Object receives identity only from the authenticated Worker, never from client-supplied query parameters.
- Invite codes, OTPs, and session tokens are not stored in plaintext. HMAC or SHA-256 digests are stored in D1; the HMAC keys are Cloudflare Worker secrets.
- Attachments and release files remain in non-public R2 buckets. Attachment links are signed, expire after ten minutes, and should be treated as bearer credentials until expiry.
- Releases are signed offline. The installer and updater reject an invalid manifest or artifact checksum.

ZiloTeams does not provide end-to-end encryption. Workspace administrators and the service operator control the service infrastructure. Do not use it for secrets or regulated data without an independent compliance and threat-model review.

## Operator responsibilities

- Scope Cloudflare and CI tokens to the minimum required permissions.
- Use separate, randomly generated production secrets and rotate them through a planned session/invite invalidation window.
- Protect the release private key offline; never add it to the repository or an R2 bucket.
- Review Worker logs, Queue dead letters, membership audit events, and dependency alerts.
- Keep the compatibility date, Wrangler, Worker runtime types, and dependencies current after testing.
