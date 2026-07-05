# The Office

The API is the Office. Everything else — this Flutter app, a future PWA,
WhatsApp, email, voice — is just a client of it. See `worker/` for the
backend, `app/` for the first native client.

## Build order (deliberate, do not skip ahead)

1. Shell screen — proves the phone-only pipeline (this commit).
2. Real mic capture, wired to a real backend call.
3. One real action function, writing to D1 — proves ground-truth state.
4. `guard()` — the one deterministic check before anything destructive,
   money-touching, or customer-facing executes.
5. Memory/Vectorize — deliberately last. Color, not ground truth.

Do not build 5 before 3 is solid.

## One-time setup still required (not done by this commit)

None of the commands below should ever be committed with a real
token in them — export as environment variables in your own Termux
session first, never paste the value into a file.

```bash
export CF_TOKEN="paste-your-cloudflare-token-here"
```

### 1. Find the zone ID for websitehub.co.za

```bash
curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=websitehub.co.za" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" | python3 -m json.tool
```

Copy the `id` field from the result — that's `ZONE_ID` below.

### 2. Create the D1 database

```bash
export ACCOUNT_ID="your-cloudflare-account-id"

curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"office-db"}' | python3 -m json.tool
```

Copy the returned `uuid` and replace `REPLACE_WITH_D1_ID` in
`worker/wrangler.toml` with it, then commit that change.

### 3. Create the R2 bucket

```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/r2/buckets" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"office-vault"}' | python3 -m json.tool
```

No ID needed back — the binding in `wrangler.toml` already references
it by name.

### 4. DNS record for the subdomain

```bash
export ZONE_ID="paste-from-step-1"

curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"office","content":"office-api.workers.dev","proxied":true}' \
  | python3 -m json.tool
```

The route in `worker/wrangler.toml` handles which worker actually
answers on that subdomain — this record just makes the hostname exist.

### 5. GitHub Actions secrets (do this in the GitHub UI, not via curl)

Repo → Settings → Secrets and variables → Actions → New repository secret:

- `CF_API_TOKEN` — same value as `$CF_TOKEN` above
- `CLOUDFLARE_ACCOUNT_ID` — same value as `$ACCOUNT_ID` above

Once both exist, every push to `main` that touches `worker/**` deploys
itself. No manual `wrangler deploy` ever again.

### 6. Codemagic

Connect this repo in the Codemagic dashboard (one-time OAuth, does not
belong in this repo). It reads `codemagic.yaml` from the repo root —
nothing to configure beyond connecting the repo and confirming the
`office-android` workflow is enabled.

## Ground rules

- Git is the source of truth. The Cloudflare dashboard is read-only —
  never click a fix in directly. If it's not in a commit, it isn't real.
- Secrets never live in this repo. Names go in `wrangler.toml` /
  `codemagic.yaml`; values live only in Cloudflare's and GitHub's
  encrypted secret stores.
- Rotate `CF_TOKEN` and any pasted PAT after initial setup is done.
