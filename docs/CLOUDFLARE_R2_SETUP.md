# Cloudflare R2 (S3-compatible) Setup

R2 is Cloudflare's S3-compatible object storage. Use it instead of local filesystem for video uploads.

> **Security**: If you shared credentials in a chat or public place, rotate them in Cloudflare Dashboard → R2 → Manage API Tokens.

## What to get from Cloudflare

### 1. Create R2 bucket

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **R2 Object Storage**
2. Click **Create bucket**
3. Name it (e.g. `online-game-commenter-videos`)
4. Region: **Automatic** or choose closest
5. Create

### 2. Create API token (R2 credentials)

1. In R2 section, click **Manage R2 API Tokens**
2. **Create API token**
3. Permissions: **Object Read & Write**
4. Specify bucket (or "Apply to all buckets")
5. Create token

You will get:

| Variable | Where to find |
|----------|---------------|
| **Account ID** | R2 overview page, or Cloudflare dashboard sidebar (right column) |
| **Access Key ID** | Shown once when token is created |
| **Secret Access Key** | Shown once when token is created — copy and store securely |
| **Bucket name** | The name you gave the bucket |

### 3. R2 endpoint URL

Format:
```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

Example: `https://a1b2c3d4e5f6.r2.cloudflarestorage.com`

### 4. Public access (optional, for video playback)

By default R2 buckets are private. To serve videos directly to the browser:

**Option A: R2 public bucket**

1. Bucket → **Settings** → **Public access**
2. Enable **Allow Access**
3. You get a URL like: `https://pub-xxxxx.r2.dev` (or custom domain)

**Option B: Custom domain**

1. Bucket → **Settings** → **Custom Domains**
2. Add domain (e.g. `videos.yourdomain.com`)
3. Add CNAME in DNS as instructed

---

## Environment variables for the project

Add to `.env` (or your env config):

```env
# Cloudflare R2 (S3-compatible)
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_access_key
R2_BUCKET_NAME=online-game-commenter-videos
R2_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com

# Optional: public URL for serving files (if public bucket or custom domain)
R2_PUBLIC_URL=https://pub-xxxxx.r2.dev
```

---

## Summary checklist

- [ ] R2 bucket created
- [ ] API token created (Object Read & Write)
- [ ] Account ID copied
- [ ] Access Key ID copied
- [ ] Secret Access Key copied (one-time!)
- [ ] Bucket name noted
- [ ] Public access configured (if videos must play in browser)

---

## Troubleshooting: Access Denied (403)

If upload fails with `AccessDenied` or `Access Denied`:

1. **Regenerate API token** — Cloudflare sometimes has token issues. Create a new token at [R2 API Tokens](https://dash.cloudflare.com/?to=/:account/r2/api-tokens) and update `.env`.

2. **Check token permissions** — Token must have **Object Read & Write** (or Admin Read & Write). If scoped to specific buckets, ensure your bucket is included.

3. **Verify bucket name** — `R2_BUCKET_NAME` must match the bucket name exactly (case-sensitive).

4. **Verify credentials** — Access Key ID and Secret Access Key are from the R2 API token, not the Cloudflare API token. Do not use "Token value" — use Access Key ID and Secret Access Key.
