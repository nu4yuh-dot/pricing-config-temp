# Hosting the pricing configurator

Three routes. Pick one.

| | Platform | Database | Cost | Signups | Best when |
|---|---|---|---|---|---|
| **A** | **Railway** | **MongoDB in the same project** | ~$5/mo | **1** | You want it up now, one account, database included |
| **B** | Render | MongoDB Atlas M0 | free* | 2 | You want a free tier and do not mind a second signup |
| **C** | AWS App Runner | MongoDB Atlas M0 | ~$20/mo | 2 | Production, or it must live in your AWS account |

\* Render's free plan sleeps after 15 minutes idle and takes ~50s to wake. Their
`starter` plan (~$7/mo) does not sleep.

**Vercel is not in the table on purpose.** It cannot run this container, and it has no
MongoDB. The app would run there as a Next.js project, but every request becomes a
serverless invocation, which churns database connections instead of holding one pool. Fine
for a blog, wrong for this.

Nothing below requires sharing a credential with anyone: both A and B deploy from the GitHub
repo, and the config files in this repo mean you are only clicking and pasting.

---

# Route A — Railway (recommended to get it shared today)

One signup, and the database sits next to the app on Railway's private network, so it is
never exposed to the internet. That is a genuinely better security posture than a free Atlas
cluster, which has to be open to `0.0.0.0/0`.

## A1. Create the project and the app

1. <https://railway.app> → sign in with GitHub.
2. **New Project** → **Deploy from GitHub repo** → `it-geethika/pricing-configurator`.
   Railway reads `railway.json`, sees the Dockerfile, and builds. First build ~5 min.

## A2. Add MongoDB to the same project

3. In the project: **New** → **Database** → **Add MongoDB**.
4. Open the Mongo service → **Variables** → copy **`MONGO_URL`**.

## A3. Give the app its environment

5. Open the **app** service → **Variables** → add:

   | Name | Value |
   |---|---|
   | `MONGODB_URI` | paste `MONGO_URL` from step 4 |
   | `MONGODB_DB` | `dns_pricing` |
   | `SESSION_SECRET` | output of `openssl rand -base64 48` |

   Do **not** set `BOOKING_API_KEY` — leaving it out keeps `/api/*` disabled (503) while
   the booking integration is out of scope. `/api/health` stays up for the health check.

6. **Settings** → **Networking** → **Generate Domain**. That is the URL you share.

## A4. Seed the database, once, from your Mac

Railway's internal hostname only resolves inside Railway, so use the **public** proxy URL:
Mongo service → **Settings** → **Networking** → **TCP Proxy**. It gives a
`mongodb://…@viaduct.proxy.rlwy.net:PORT` style URL.

```bash
cd ~/PricingConfig

MONGODB_URI='<the public TCP proxy URL>' \
MONGODB_DB='dns_pricing' \
npx tsx scripts/seed.ts --admin-password 'choose-a-strong-one'
```

Expected:

```
target database: dns_pricing (empty)
validated 3 rate cards
model-1: seeded (CUMULATIVE_SLABS)
model-2: seeded (MIN_PLUS_EXCESS)
model-3: seeded (MAX_MIN_OR_FULL)
pincodes: seeded 19494
created first admin: admin@dnslogistic.com
```

If it says *"Refusing to seed"*, `MONGODB_DB` is pointing somewhere else and **nothing was
written**. Fix it and re-run.

Then **turn the TCP proxy off again** — it was only needed for seeding.

## A5. Check and share

```bash
export APP=https://your-app.up.railway.app
curl -s $APP/api/health                               # {"status":"ok","database":"reachable"}
curl -s -o /dev/null -w '%{http_code}\n' $APP/       # 307, anonymous is redirected
curl -s $APP/api/quote                                # api-not-configured, as intended
```

Sign in as `admin@dnslogistic.com`, then **Users** → add accounts for your reviewers and
change the admin password. Never hand out the seeded admin login.

---

# Route B — Render + Atlas

1. Create the Atlas M0 cluster and user first (steps 1–3 of Route C below), and note the
   connection string.
2. <https://render.com> → **New** → **Blueprint** → connect this repo. Render reads
   `render.yaml`, creates the service and generates `SESSION_SECRET` itself.
3. It will prompt for `MONGODB_URI` — paste the Atlas string.
4. Deploy, then seed exactly as in step A4 (Atlas is publicly reachable, so no proxy needed).

Render's free plan sleeps when idle; if reviewers hit a 50-second wait, move it to `starter`.

---

# Route C — AWS App Runner + Atlas

Goal: a shareable HTTPS URL, protected by sign-in, running the real app against its own
database. Roughly 45 minutes the first time. Use this when it has to live in your AWS
account; use Route A to get it shared today.

**What we are building**

```
   you / colleagues
          │  https
          ▼
   AWS App Runner  ────────────►  MongoDB Atlas (free M0)
   (the container)      TLS        database: dns_pricing
          ▲
          │ pulls image
   Amazon ECR
```

**Decisions taken, and why**

| Decision | Reason |
|---|---|
| App Runner, not ECS/EC2 | No load balancer, VPC, subnets, SSH or TLS certificates to manage. It takes a container and returns an HTTPS URL. |
| Atlas M0 (free) | A **new cluster for this project only** — nothing else is touched. 512 MB against our ~40 MB. |
| Public URL + sign-in | There is no public signup; only an admin creates accounts, and every page redirects anonymous visitors. Shareable, but not open. |
| `BOOKING_API_KEY` left unset | Disables `/api/*` entirely (503). Booking integration is out of scope for now. |

**The one compromise, stated plainly:** Atlas M0 does not support PrivateLink or VPC peering,
so its network allowlist has to be `0.0.0.0/0`. The database is protected by TLS and a long
random password, not by network isolation. That is fine for a review deployment. Before real
customer pricing depends on it, move to Atlas M10 + PrivateLink, or run Mongo inside your own
VPC. Noted again at the end.

---

## Step 0 — Install the AWS CLI

```bash
brew install awscli
aws --version                     # expect aws-cli/2.x
```

Then create an IAM user or SSO profile with these managed policies:
`AmazonEC2ContainerRegistryFullAccess`, `AWSAppRunnerFullAccess`.

```bash
aws configure
#   AWS Access Key ID     : ...
#   AWS Secret Access Key : ...
#   Default region name   : ap-south-1      ← Mumbai; lowest latency from India
#   Default output format : json

aws sts get-caller-identity        # confirms it works, prints your account ID
```

Keep that account ID; it appears in the ECR URLs below.

---

## Step 1 — Create the database

1. Sign up at <https://cloud.mongodb.com>.
2. **Create a new Project** — call it `dns-pricing`. A separate project keeps this
   isolated from anything else in the account.
3. **Build a Database** → **M0 FREE** → provider AWS, region **Mumbai (ap-south-1)**.
   Same region as the app keeps latency low.
4. **Database Access** → Add New Database User
   - Authentication: Password
   - Username: `dns_pricing_app`
   - Password: **Autogenerate Secure Password** — copy it now
   - Database User Privileges: **Specific Privileges** → `readWrite` on database
     `dns_pricing`. Not `atlasAdmin`: this user should only ever reach our data.
5. **Network Access** → Add IP Address → `0.0.0.0/0`, comment "App Runner egress".
   (App Runner has no fixed outbound IP; see the compromise noted above.)
6. **Database** → **Connect** → **Drivers** → copy the connection string. It looks like:

```
mongodb+srv://dns_pricing_app:<password>@dns-pricing.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

Substitute the real password. If it contains `@ : / ? # [ ] %`, URL-encode those characters.

---

## Step 2 — Generate the session secret

```bash
openssl rand -base64 48
```

Keep it. It signs session cookies, so it must be **the same value** every time the service
restarts — otherwise everyone is signed out on each deploy. Never commit it.

---

## Step 3 — Seed the database, from your machine

Nothing is written until the guard confirms the target is this project's database.

```bash
cd ~/PricingConfig

MONGODB_URI='mongodb+srv://dns_pricing_app:PASSWORD@dns-pricing.xxxxx.mongodb.net/?retryWrites=true&w=majority' \
MONGODB_DB='dns_pricing' \
npx tsx scripts/seed.ts --admin-password 'choose-a-strong-one-here'
```

Expected output:

```
target database: dns_pricing (empty)
validated 3 rate cards
model-1: seeded (CUMULATIVE_SLABS)
model-2: seeded (MIN_PLUS_EXCESS)
model-3: seeded (MAX_MIN_OR_FULL)
pincodes: seeded 19494
created first admin: admin@dnslogistic.com
seed complete
```

If it says *"Refusing to seed"*, `MONGODB_DB` is pointing somewhere else. Nothing was written.
Fix the variable and re-run.

---

## Step 4 — Push the image to ECR

```bash
export AWS_REGION=ap-south-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/dns-pricing"

aws ecr create-repository --repository-name dns-pricing --region "$AWS_REGION"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# --platform linux/amd64 is required: your Mac is ARM, App Runner is x86.
docker build --platform linux/amd64 -t dns-pricing:$(git rev-parse --short HEAD) .
docker tag dns-pricing:$(git rev-parse --short HEAD) "$ECR:$(git rev-parse --short HEAD)"
docker tag dns-pricing:$(git rev-parse --short HEAD) "$ECR:latest"
docker push "$ECR:$(git rev-parse --short HEAD)"
docker push "$ECR:latest"
```

Tagging with the commit as well as `latest` means a rollback is "deploy the previous tag"
rather than a rebuild.

---

## Step 5 — Create the App Runner service

Console: **App Runner** → **Create service**.

1. **Source**
   - Repository type: **Container registry** → **Amazon ECR**
   - Browse to `dns-pricing:latest`
   - Deployment trigger: **Automatic** (redeploys when you push a new `latest`)
   - ECR access role: **Create new service role**

2. **Configure service**
   - Service name: `dns-pricing`
   - Virtual CPU & memory: **0.25 vCPU, 0.5 GB** (enough; it is I/O bound)
   - Port: **3000**

3. **Environment variables** — add three:

   | Name | Value |
   |---|---|
   | `MONGODB_URI` | the `mongodb+srv://…` string from step 1 |
   | `MONGODB_DB` | `dns_pricing` |
   | `SESSION_SECRET` | the value from step 2 |

   Do **not** set `BOOKING_API_KEY`. Leaving it out keeps `/api/*` disabled.

   For anything beyond a review deployment, store `MONGODB_URI` and `SESSION_SECRET` in
   Secrets Manager and reference them here instead of pasting plaintext.

4. **Health check**
   - Protocol: **HTTP**
   - Path: **`/api/health`**
   - Leave the intervals at their defaults

5. **Auto scaling** — max size **1** while reviewing. One instance keeps the login throttle
   coherent (it is per-instance) and keeps Atlas connections low.

6. **Create & deploy.** First deploy takes 5–10 minutes.

You get a URL like `https://abcdefgh.ap-south-1.awsapprunner.com`.

---

## Step 6 — Check it, then share it

```bash
export APP=https://abcdefgh.ap-south-1.awsapprunner.com

curl -s $APP/api/health                                    # {"status":"ok","database":"reachable"}
curl -s -o /dev/null -w '%{http_code}\n' $APP/login        # 200
curl -s -o /dev/null -w '%{http_code}\n' $APP/             # 307 — anonymous is redirected
curl -s $APP/api/quote                                     # api-not-configured, as intended
```

Then in a browser: sign in as `admin@dnslogistic.com` with the password from step 3.

**Immediately afterwards:** go to **Users**, add real accounts for whoever is reviewing
(Configurator for the pricing team, Viewer for read-only), and change the admin password.
Never share the seeded admin login itself.

---

## Running costs

| | Monthly |
|---|---|
| App Runner, 0.25 vCPU / 0.5 GB, running | ~$20–25 |
| App Runner **paused** | ~$5 (provisioned memory only) |
| Atlas M0 | free |
| ECR storage | pennies |

**Pause it between review sessions** — App Runner → your service → **Pause**. Resuming takes
about a minute and the URL does not change.

---

## Everyday operations

**Deploy a change**

```bash
docker build --platform linux/amd64 -t "$ECR:latest" .
docker push "$ECR:latest"        # automatic deployment picks it up
```

**Roll back** — App Runner → Deployments → deploy the previous image tag.

**Logs** — App Runner → Logs, or CloudWatch. Application logs and deployment logs are separate.

**Re-seed or reset** — run `scripts/seed.ts` again from your machine; it is idempotent and
leaves existing cards and pincodes alone. `--reset` clears rate cards, versions, change
requests and the audit log, but never users or pincodes, and only ever inside `dns_pricing`.

---

## Before this holds pricing anyone relies on

- [ ] Move the database off the `0.0.0.0/0` allowlist — Atlas M10 + PrivateLink, or Mongo
      inside your own VPC.
- [ ] Move `MONGODB_URI` and `SESSION_SECRET` into Secrets Manager.
- [ ] Turn on Atlas backups and actually test a restore.
- [ ] Custom domain (`pricing.samex.delivery`) — App Runner → Custom domains, then a CNAME.
- [ ] Replace the in-memory login throttle with a shared one if you scale past one instance.
- [ ] Decide the two open pricing questions: the non-monotonic pricing in Models 2 and 3, and
      GST policy. Both are in the README.
- [ ] Archive the three source workbooks somewhere durable — they are the origin of every rate.
