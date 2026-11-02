# Deploying one org (EXNA) on one small Linux server: runbook

**Status: PREPARED, NOT RUN.** Ops owns the paste and executes it only after the owner and Director approve. Nothing here has run on a server. G-1 measured the same programs on Ubuntu 24.04 / 2 GB: about 200 MiB per org at peak, no OOM, restart in about 2.5 s.

## Blockers before real use (each is its own reviewed item)

| # | Blocker | Who | Why it blocks |
|---|---|---|---|
| B1 | **Sign-in and approvals (option A: no passkeys)** | Product | Built: email-link join and sign-in; approvals need a sign-in from the last hour and send a receipt; member, policy and address changes are Ops commands until TOTP exists. With Fable for review. |
| B2 | **Outbound mail for sign-in and invite links** | Owner (Resend sending key + a verified sender domain) | Built (fixed templates via the Resend send API), with Fable for review. Render with `--mail-from "EXNA <noreply@<DOMAIN>>"` and put the sending key in `/etc/kapelle/secrets/hub/resend-send.key` (kapelle-hub, 0600). Without it, links go to the spool. |
| B3 | **Resend inbound content client** | Owner (Resend account, receiving domain, a key with receiving access) | Built (Receiving API client), with Fable for review. Put the org's Resend key in `/etc/kapelle/secrets/exna/resend-api.key` (kapelle-exna, 0600); without it a `resend` installation refuses to start (`org_resend_key_missing`). The attachment download host is pinned to `inbound-cdn.resend.com` (the documented host); confirm it on the first live email. |
| B4 | **A qualified OpenRouter profile** | Owner + Ops (probe, then run), Fable reviews | The profile's `qualificationRef` is still `pending:`. |
| B5 | **New system dependencies: Caddy (HTTPS) and restic (encrypted off-host backups)** | Owner OK | Neither is in the stack yet. Alternatives are listed below. |
| B6 | **Off-host storage: an S3-compatible bucket and credentials** | Owner | Required by restic. |

## Server

- Ubuntu 24.04 LTS x64, 1 vCPU / 2 GB, no swap. Ports open: 22 (SSH key only), 80, 443.
- Node 24.18.0: the official `node-v24.18.0-linux-x64.tar.xz`, SHA-256 pinned as in G-1's `cloud-init.yaml`, unpacked to `/opt/node`.
- No `node_modules` and no native code; `node:sqlite` is built into Node 24.

## Layout

These are the paths `deploy/kapelle-admin.ts` `layout()` renders. The units use the same ones.

| Path | Owner / mode | What |
|---|---|---|
| `/opt/kapelle/releases/<commit8>/bin/{org-serve,hub-serve,backup-cli,kapelle-admin}.mjs` + `bin/ui/` | root 0755 | Bundle built by Ops at a pinned commit (same recipe as G-1) |
| `/opt/kapelle/current` | root | Symlink to the active release |
| `/etc/kapelle/{catalog.json,orgs/exna.json,hub-config.json}` | root:kapelle-exna 0640 | Rendered configs; secrets appear here only as **file paths** |
| `/etc/kapelle/secrets/exna/{resend-webhook.whsec,openrouter.key,restic.env,restic.password}` | kapelle-exna 0600 | Org secrets |
| `/etc/kapelle/secrets/hub/{exna-envelope.pem,resend-send.key}` | kapelle-hub 0600 | Hub's envelope signing key for this org, and its Resend **sending** key (B2). The hub holds **no webhook secret**: it routes, and the org runtime alone verifies (Fable deploy R-1). |
| `/var/lib/kapelle/exna/{state,folder,ops}` | kapelle-exna 0700 | Org authority, files, Ops socket |
| `/run/kapelle-access/exna/access.sock` | kapelle-exna, dir 0710 / socket 0660 | The only way the hub reaches the org |
| `/var/backups/kapelle/exna` | kapelle-exna 0700 | Local backup sets (`backup.keep` = 8, one every 6 h) |
| `/var/lib/kapelle-hub/spool` | kapelle-hub 0700 | Sign-in/invite links until B2 lands |

## Install (once)

```sh
# users: the org and the hub are separate; the hub joins the org's group only to reach its access socket
useradd --system --home /var/lib/kapelle/exna --shell /usr/sbin/nologin kapelle-exna
useradd --system --home /var/lib/kapelle-hub --shell /usr/sbin/nologin kapelle-hub
usermod -aG kapelle-exna kapelle-hub
install -d -o root -g kapelle-exna -m 0750 /etc/kapelle /etc/kapelle/orgs
install -d -o kapelle-exna -g kapelle-exna -m 0700 /etc/kapelle/secrets/exna /var/lib/kapelle/exna /var/lib/kapelle/exna/state /var/lib/kapelle/exna/folder /var/lib/kapelle/exna/ops /var/backups/kapelle/exna
install -d -o kapelle-hub -g kapelle-hub -m 0700 /etc/kapelle/secrets/hub /var/lib/kapelle-hub /var/lib/kapelle-hub/spool
# bundle (from Ops' build, SHA-256 verified), then
ln -sfn /opt/kapelle/releases/<commit8> /opt/kapelle/current
# the release tarball carries deploy/ next to bin/ (Ops' production build)
R=/opt/kapelle/releases/<commit8>
install -m 0644 $R/deploy/systemd/*.service $R/deploy/systemd/*.timer /etc/systemd/system/ && systemctl daemon-reload
```

## Secrets (files only; never in chat or in a config)

- **`resend-webhook.whsec`:** the Resend webhook signing secret, for the **org only**. The hub never sees it. For a pre-launch smoke test with `--intake fake`, use a random 32-byte secret.
- **`resend-api.key`:** the org's Resend key with receiving access (B3).
- **`openrouter.key`:** the key from `room-cli secret request`, with a provider-side credit limit (Fable L-1).
- **`restic.env`:** contains `RESTIC_REPOSITORY=s3:…`, `RESTIC_PASSWORD_FILE=/etc/kapelle/secrets/exna/restic.password`, and the bucket credentials.
- **`github-website.pat`** (website pack, only when rendered with `--website-repo`): a GitHub **fine-grained** PAT (`github_pat_…`) for the one website repository. Permissions: Contents read/write, Pull requests read/write, Metadata read, Commit statuses read, Deployments read (D-1; no Vercel token is needed). Owner: kapelle-exna, 0600; read by the org runtime at each use. Rotate it if it ever reaches a chat or a log.
- **`restic.password`:** a long random password. **Store a copy off-server**: without it, the off-host backups can't be read.

## First start

```sh
K="/opt/node/bin/node /opt/kapelle/current/bin/kapelle-admin.mjs"
$K render --org exna --label "EXNA" --domain <DOMAIN> --monthly-usd <owner-approved cap>   # the org's model spend cap (owner decision); printed back
# run as root, render sets the group itself (kapelle-exna for the org's files, kapelle-hub for hub-config.json)
systemctl enable --now kapelle-org@exna
sudo -u kapelle-exna $K ops /etc/kapelle/orgs/exna.json /ops/status        # note installationId
sudo -u kapelle-hub $K keypair /etc/kapelle/secrets/hub/exna-envelope.pem # prints the PUBLIC jwk
sudo -u kapelle-exna $K ops /etc/kapelle/orgs/exna.json /ops/envelope-key/add '{"kid":"k1","publicJwk":<jwk>}'
$K render --org exna --label "EXNA" --domain <DOMAIN> --monthly-usd <cap> --installation-id <installationId> --mail-from "EXNA <noreply@<DOMAIN>>"   # also writes hub-config.json
systemctl enable --now kapelle-hub
# Caddy (B5): /etc/caddy/Caddyfile from $R/deploy/caddy/Caddyfile.template with {{DOMAIN}} and {{ACME_EMAIL}}; systemctl reload caddy
# LIBRARY files host: {{FILES_HOST}} from hub-config filesHost; without it, delete the block: sed '/^# FILES-HOST-BEGIN/,/^# FILES-HOST-END$/d'
```

**First admin (B1, option A):** Ops mints a one-time link on the owner-only Ops socket and gives it to the admin out of band. The token is in the link's `#fragment`, so it never reaches a server log. The link is valid 24 h, single use, and refused once any member exists.

```sh
sudo -u kapelle-exna $K ops /etc/kapelle/orgs/exna.json /ops/bootstrap/invite '{"email":"<admin email>"}'   # prints {link}
```

The admin opens the link and taps **Join**, which signs them in. Later sign-ins use an emailed link (needs B2). There is no passkey.

**Ops-only actions (option A, until an authenticator-app check exists).** The app refuses these with `access_step_up_required`. They decide who is a member, who receives mail, and what replies may say. Each is audited as `ops`, and `authn` is `ops-socket`.

```sh
O=/etc/kapelle/orgs/exna.json
sudo -u kapelle-exna $K ops $O /ops/member/invite '{"email":"robin@example.org","role":"reviewer"}'   # prints {email, role, invitationId, link}: 7 days, single use; give the link out of band
sudo -u kapelle-exna $K ops $O /ops/member/invite/revoke '{"invitationId":"<id>"}'                     # or {"email":...}: an unused invite dies at once (audited)
sudo -u kapelle-exna $K ops $O /ops/bootstrap/revoke '{"email":"<admin email>"}'                       # the first-admin link, if it leaked before use (P-R1)
sudo -u kapelle-exna $K ops $O /ops/member/list
sudo -u kapelle-exna $K ops $O /ops/member/role '{"email":"robin@example.org","role":"contributor"}'   # bumps membershipVersion
sudo -u kapelle-exna $K ops $O /ops/member/remove '{"email":"robin@example.org"}'                      # bumps; never the last admin
sudo -u kapelle-exna $K ops $O /ops/intake/token/issue '{"email":"alex@example.org"}'                  # the member's private submission address
sudo -u kapelle-exna $K ops $O /ops/intake/token/revoke '{"email":"alex@example.org"}'
sudo -u kapelle-exna $K ops $O /ops/policy/approve "{\"policy\": $(cat policy.json)}"                 # the exact reply policy (JSON file)
```

Re-enabling replies after the kill switch (`/ops/reply-kill '{"on":false}'`), envelope keys and restore are already Ops-only.

**Meeting transcription (T-1: configuration and policy only; nothing records or transcribes yet).** Off unless rendered with `--transcription fake|deepgram --transcription-usd <owner-approved monthly cap>` (D-1; separate from the model cap). `deepgram` expects `/etc/kapelle/secrets/exna/deepgram.key` (kapelle-exna, 0600) and stays refused until its `qualificationRef` is pinned (T-7, with Director approval). The policy (backend profile, retention, recording-notice text) is `totp` tier, so Ops approves it:

```sh
sudo -u kapelle-exna $K ops $O /ops/status                                                   # transcription {profileHash, policy, ...}
sudo -u kapelle-exna $K ops $O /ops/transcription/policy/approve "{\"policy\": $(cat transcription-policy.json)}"
sudo -u kapelle-exna $K ops $O /ops/transcription/hold '{"jobId":"tj_...","on":true,"reason":"why the audio must be kept"}'   # pauses deletion; audited
sudo -u kapelle-exna $K ops $O /ops/transcription/hold '{"jobId":"tj_...","on":false}'
sudo -u kapelle-exna $K ops $O /ops/transcription/sweep                                       # apply the retention clocks now (also daily)
```

Audio lives only under `/var/lib/kapelle/exna/state/media/` and is **never in a backup**. It is deleted at transcript acceptance plus the policy's days (D-2 placeholder: 7), and at most 30 days after upload unless held. Every deletion leaves a `media_tombstones` row first, and `/ops/status` → `transcription.deletions` counts them by reason. After a restore, audio the database still lists is recorded as `missing_at_start`; transcripts come back with the folder.

**Approvals in the app:** adopting a submission needs a signed-in session. Approving a plan or member notes also needs a sign-in from the last 60 minutes; otherwise the app offers **Email me a fresh sign-in link**. Every adopt and approval mails a fixed-template receipt to the person who did it. Plan approvals also go to every other admin.

**Reply sending:** the runtime only ever prepares replies (shadow mode). There is no send path. `/ops/reply-kill` pauses even preparation.

## Smoke test (no members, no model spend)

- `curl -sI https://<DOMAIN>/o/exna/` returns 200, with a `content-security-policy` that includes `script-src 'self'` and `strict-transport-security`.
- `/ops/status` shows `backup.ok >= 1` within a minute (an overdue set is taken at start), and `triggerFailures` and `draftRunFailures` are both 0.
- `journalctl -u kapelle-org@exna -u kapelle-hub` is free of errors.
- **First start only (Fable N-1):** the hardening (`CapabilityBoundingSet=`, `SystemCallFilter=@system-service`, `ProtectClock`, `ProtectHostname`) was not in the G-1 units, so confirm it.
  - `systemctl is-active kapelle-org@exna kapelle-hub` prints `active` twice.
  - `journalctl -b -u kapelle-org@exna -u kapelle-hub | grep -Ei 'seccomp|SIGSYS|operation not permitted|status=31'` prints nothing.
  - If a unit dies with signal SYS (status 31), a syscall filter is too tight. Record the unit and the journal line for Product; don't loosen it ad hoc.

## Backups

- **Local:** the runtime takes a verified set every 6 h and keeps 8 (`backup` block in `orgs/exna.json`).
- **Nightly off-host (B5/B6):** `systemctl enable --now kapelle-backup@exna.timer`. At 03:15 Central it takes a fresh set, runs `restic backup` to the bucket, then `restic forget` (14 daily, 8 weekly, 6 monthly).
- **Restore drill:** run monthly, and before go-live.

  ```sh
  # 1. fetch the newest off-host snapshot into a scratch directory (as the org user, with its restic env)
  sudo -u kapelle-exna sh -c 'set -a; . /etc/kapelle/secrets/exna/restic.env; set +a;
    restic restore latest --tag exna --host kapelle-exna --target /var/tmp/kapelle-drill'
  ls /var/tmp/kapelle-drill/var/backups/kapelle/exna/          # pick the newest set directory, e.g. exna-20261016T081500000Z
  # 2. verify every hash and restore into a NEW root (it must not exist yet); writes /var/tmp/kapelle-drill/root/org-config.json
  sudo -u kapelle-exna /opt/node/bin/node /opt/kapelle/current/bin/backup-cli.mjs restore \
    /etc/kapelle/orgs/exna.json /var/tmp/kapelle-drill/var/backups/kapelle/exna/<set> /var/tmp/kapelle-drill/root
  # 3. start a runtime on it for 20 s (own sockets under the drill root; the live org is untouched), and read its status meanwhile
  sudo -u kapelle-exna timeout 20 /opt/node/bin/node /opt/kapelle/current/bin/org-serve.mjs /var/tmp/kapelle-drill/root/org-config.json &
  sleep 5; sudo -u kapelle-exna /opt/node/bin/node /opt/kapelle/current/bin/kapelle-admin.mjs ops /var/tmp/kapelle-drill/root/org-config.json /ops/status
  wait
  # 4. discard the drill
  rm -rf /var/tmp/kapelle-drill
  ```

  - **Step 2** prints `{"ok":true,"installationId":…,"restoredFrom":…,"held":…}`. The restored org gets a **new installation id**, and any sent-but-unsettled effect is held.
  - **Step 3** prints `{"ok":true,"orgId":"exna",…}`. See `docs/org-backups.md` for the consistency window.

## Intake archiving (automatic)

The preparer reads `reviewers-private/intake/`, and its snapshot refuses past 1,000 entries (a few hundred stored emails). The org runtime archives at start and daily.

- **What moves:** processed submissions, oldest first, go to `reviewers-private/archive/intake/`, which the preparer doesn't read. That covers everything older than `intakeArchive.afterDays` (default 60), plus more while the folder is over `budgetEntries` (default 600).
- **What stays:** the newest 4 adopted submissions (a plan's retained context) and anything not yet processed.
- **Archived submissions** leave the Review list. Archives are included in backups.
- **Commands:**

  ```sh
  sudo -u kapelle-exna $K ops /etc/kapelle/orgs/exna.json /ops/intake/archive                                  # run now
  sudo -u kapelle-exna $K ops /etc/kapelle/orgs/exna.json /ops/intake/restore '{"intakeId":"intake_..."}'      # bring one back
  ```

- `/ops/status` shows `intakeArchive {intakeEntries, archivedTotal, lastRun}`.

## First live week: what to watch

- **Resend retries (Fable N-2):** `/ops/status` and the journal for intake refusals answering 503. Retryable labels are retried until Resend's own retry window closes.
  - A burst of `resend_http_5xx`, `resend_http_429` or `resend_transport_failed` is Resend or the network having a bad moment, and it recovers on its own.
  - A *persistent* `resend_response_malformed` or `resend_key_*` needs Ops: the API shape or the key changed. Fix it inside Resend's retry window, or those emails are lost.
- **Transcription holds (monthly):** `/ops/status` → `transcription.held` lists every held recording with when and why. A hold keeps audio past the 30-day cap, so review the list monthly and release what no longer needs keeping. A hold is not a filing cabinet.
- **Approval receipts (option A, N-3):** `/ops/status` → `receiptFailures` counts receipts the hub could not send, by mail label. Each row is in the access audit (`receipt.failed`, with the operation and the recipient's member id). Any count means someone approved without the receipt reaching them: fix the mail path (B2), and tell the approver what was approved.
- **The attachment download host (B3):** the first live email with a text attachment confirms the host. `resend_download_host_not_admitted` means it differs from the pinned `inbound-cdn.resend.com` and must be re-pinned.

## Website pack v0 (optional; Director/owner decisions D-1..D-4)

Reviewers ask for a change to the website's events or meeting notes on the Review page; the agent proposes typed edits to
`src/data/events.json` / `src/data/meeting-notes.json` only; the reviewer approves the exact diff (fresh sign-in) and the runtime
opens a **draft** pull request as the connected identity, with a fixed `Kapelle-Agent:` trailer and `Co-authored-by: Kapelle agent`.
Publishing is a maintainer merging the PR on GitHub; nothing in Kapelle merges.

```sh
$K render ... --website-repo 0xkilgore/example-org-website \
  --website-author "<Alex's GitHub name> <<id>+<login>@users.noreply.github.com>" --website-preview-hosts "*.vercel.app"
install -o kapelle-exna -g kapelle-exna -m 0600 <pat file> /etc/kapelle/secrets/exna/github-website.pat
```

- Egress: the org runtime calls `https://api.github.com` only (redirects refused, no proxy). Vercel's preview URL is read from GitHub's commit statuses/deployments and shown as a link; the server never fetches it.
- Caps: 20 requests and 5 approvals per org per 24 h (config `dailyRequest` / `dailyApply`). Each request is one hosted model call on the org's monthly cap.
- Watch `/ops/status` → `website.prs.unsettled`: a push whose GitHub answer was lost. Check the branch/PR on GitHub, then `$K ops $O /ops/website/resume '{"operationId":"<id>"}'` (it reads first and never makes a second branch or PR).
- Proposals (the prepared bytes under `stateRoot/website/`) are not in the backup set: they are regenerable, and the pull request on GitHub is the durable artifact (Fable W-2 N-2).
- `website_base_shape_changed` means the website's data files gained a field the pinned schema doesn't know: Product updates the schema (`website-data/v1`) before more requests work.

## Images (IMAGES-V1, optional; owner decision 2026-10-19)

Flyer/image attachments in Chat need the decoder: the ONLY native code in Kapelle (sharp/libvips, pinned in
`decoder/package-lock.json`, provenance in `decoder/SOURCES.md`). It is not part of the JS bundles (org-serve never imports it):
it ships as a separate prebuilt `decoder/` tree in the release and runs as its own sandboxed unit:

```
# The release bundle carries a PREBUILT decoder/ tree (built on the Mac from decoder/package-lock.json with
# npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc, musl packages pruned; covered by the manifest). No npm on the host.
install -m 0644 deploy/systemd/kapelle-image-decode@.socket deploy/systemd/kapelle-image-decode@.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now kapelle-image-decode@exna.socket
```

One connection = one fresh decoder (DynamicUser, PrivateNetwork, AF_UNIX only, no org paths, 256 MiB, 10 s); only
`kapelle-exna` can connect (`/run/kapelle-images/exna.sock`, 0600). The org config names it as
`images: { decoder: { mode: "systemd", socket: "/run/kapelle-images/exna.sock" } }`; without the socket the org still starts; uploads
refuse with `image_decoder_unavailable` and `/ops/status` shows `images.decoderAvailable: false`. Qualify on the host before enabling: the unit's properties (`systemd-analyze security
kapelle-image-decode@x.service`), denied egress, and the fixture suite (`tests/images.test.ts`) against the installed decoder.

## Upgrade and rollback

1. Ops builds the new bundle at the pinned commit and copies it to `/opt/kapelle/releases/<new>`.
2. `ln -sfn` switches `current` to the new release.
3. `systemctl restart kapelle-org@exna kapelle-hub`.
4. Run the smoke test.

**Rollback:** switch `current` back and restart. Configs and state are not changed by an upgrade, unless the release notes say so.
A second upgrade overwrites the one-step rollback markers: roll back before upgrading again if the current release is suspect.
Hub sessions live in memory, so an upgrade signs members out; they sign in again with an email link.

**Catalog change** (for example, the pinned qualification ref after B4): `render` again, which recomputes `catalogSha256`, then restart the org. A runtime refuses a catalog that doesn't match its pin (`org_catalog_pin_mismatch` at start, `setup_changed` while running).

## Alternatives, if the owner declines a new dependency (B5)

| Instead of | Alternative | Trade-off |
|---|---|---|
| Caddy | nginx + certbot | Two packages and a renewal timer instead of one |
| restic | `rsync -e ssh` to a second machine | Plain copies, no encryption at rest; a second host to keep |
