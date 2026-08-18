# Deploying to AWS

The app is a containerised Next.js server that needs MongoDB and three secrets. It has been
built and run as a container locally and verified serving real traffic, so the artefact is
known good before any AWS work starts.

```
docker build -t dns-pricing .        # 341 MB, non-root, no secrets baked in
docker run -p 3000:3000 \
  -e MONGODB_URI=… -e MONGODB_DB=dns_pricing \
  -e SESSION_SECRET=… -e BOOKING_API_KEY=… dns-pricing
```

## Recommended shape: ECS Fargate behind an ALB

| Piece | Service |
|---|---|
| Image registry | ECR |
| Runtime | ECS Fargate, 1 service, 2 tasks (0.5 vCPU / 1 GB each) |
| Ingress | Application Load Balancer + ACM certificate |
| Database | MongoDB Atlas via PrivateLink, or your existing cluster |
| Secrets | Secrets Manager, injected as task-definition secrets |
| Logs | CloudWatch Logs |
| DNS | Route 53 |

**Why Fargate rather than Lambda/Amplify for this app specifically:**

- It holds a **MongoDB connection pool**. A container keeps one warm pool per task; Lambda
  churns connections across cold starts and can storm the cluster under concurrency.
- The booking site calls `/api/quote` **synchronously in a booking flow**. Cold starts there
  are felt by a person waiting at a counter.
- Almost every route is dynamic (server-rendered per request), so there is little static
  content for a CDN-first architecture to win on.

Amplify Hosting is genuinely simpler and cheaper, and is a reasonable choice if this stays a
low-traffic internal tool and you accept occasional cold starts on the quote endpoint. If your
existing Next.js site already runs on something, **match it** — one deployment story beats a
marginally better second one.

## Steps

### 1. Decide where MongoDB lives

Reuse the existing cluster if it can be reached from the VPC. Otherwise Atlas with
**PrivateLink** (not a public IP allowlist — these are commercial rates).

**Avoid DocumentDB unless you test it first.** It is Mongo-compatible, not Mongo, and this app
uses unique indexes, `distinct`, `countDocuments` and dotted `$set`/`$unset` paths. Those are
all supported today, but the compatibility matrix moves and a silent difference here becomes a
pricing bug.

Create a database user restricted to the `dns_pricing` database.

### 2. Store the secrets

```bash
aws secretsmanager create-secret --name dns-pricing/session-secret \
  --secret-string "$(openssl rand -base64 48)"

aws secretsmanager create-secret --name dns-pricing/booking-api-key \
  --secret-string "$(openssl rand -base64 36)"

aws secretsmanager create-secret --name dns-pricing/mongodb-uri \
  --secret-string 'mongodb+srv://…'
```

`SESSION_SECRET` signs session cookies, so it must be **identical across tasks** — otherwise a
request served by task B rejects a cookie issued by task A. It is the one value that must not
be per-instance. Rotating it signs everyone out, which is the correct behaviour but should be
done deliberately.

### 3. Push the image

```bash
aws ecr create-repository --repository-name dns-pricing
aws ecr get-login-password | docker login --username AWS --password-stdin \
  <account>.dkr.ecr.<region>.amazonaws.com

docker build --platform linux/amd64 -t dns-pricing .
docker tag dns-pricing:latest <account>.dkr.ecr.<region>.amazonaws.com/dns-pricing:$(git rev-parse --short HEAD)
docker push <account>.dkr.ecr.<region>.amazonaws.com/dns-pricing:$(git rev-parse --short HEAD)
```

`--platform linux/amd64` matters when building on an Apple Silicon Mac; Fargate defaults to
x86_64. Tag with the commit rather than `latest`, so a rollback is a task-definition revision
rather than an archaeology exercise.

### 4. Network

- VPC with two private subnets (tasks) and two public subnets (ALB).
- Security group **alb-sg**: inbound 443 from wherever the app is used.
- Security group **task-sg**: inbound 3000 **from alb-sg only**.
- Database security group: inbound 27017 from task-sg only.
- NAT gateway, or VPC endpoints for ECR, Secrets Manager, CloudWatch and S3 if you would
  rather avoid the NAT cost.

### 5. Task definition

- 0.5 vCPU, 1 GB. The app is I/O bound; the memory floor is Node plus one Mongo pool.
- Port 3000.
- `secrets`: `MONGODB_URI`, `SESSION_SECRET`, `BOOKING_API_KEY` from Secrets Manager.
- `environment`: `MONGODB_DB=dns_pricing`, `NODE_ENV=production`.
- Log driver `awslogs`.
- Execution role needs `secretsmanager:GetSecretValue` for those three secrets and ECR pull.

### 6. Service and health checks

- 2 tasks minimum, across two availability zones.
- Target group health check path **`/api/health`** — it pings Mongo, so a task that cannot
  reach the database is pulled from rotation instead of serving a login page that cannot log
  anyone in.
- Deployment circuit breaker with rollback on.
- Deregistration delay ~30s.

### 7. Seed the database — once

The app reads Mongo at runtime and never touches the workbooks. Seeding is a separate one-off
job using the `tools` image target.

```bash
python3 scripts/extract.py            # workbooks -> data/extracted/*.json
docker build --target tools -t dns-pricing-tools .
# Run as a one-off ECS task in the same subnets/security group as the service:
#   command: ["npx","tsx","scripts/seed.ts","--admin-password","<initial admin password>"]
```

`seed.ts` validates every rate card before writing and fails loudly on a reshaped workbook, so
a bad import cannot half-apply. It is idempotent: existing cards and pincodes are left alone.

Then sign in as the admin it created and change that password.

### 8. DNS and TLS

ACM certificate in the ALB's region, Route 53 alias to the ALB, HTTP→HTTPS redirect on the
listener.

### 9. Point the booking site at it

Give the booking site the `BOOKING_API_KEY` and the base URL. It calls:

- `POST /api/customers` when a customer is created
- `GET /api/quote?customer=…` on the booking screen
- `POST /api/bookings/exceptions` and `GET /api/bookings/exceptions?reference=…`

## Security: the API should not be on the public internet

The API key is a real control, but rate cards are commercial data and a single leaked key
exposes every customer's negotiated pricing. Options, best first:

1. **Internal ALB** and reach the dashboard over VPN or Client VPN. Cleanest, if the pricing
   team can use a VPN.
2. **Public ALB for the dashboard, internal path for the API** — a second internal ALB, or a
   WAF rule restricting `/api/*` to the booking site's egress IPs.
3. **Public with WAF** — allowlist office and booking-site IPs on `/api/*`, plus rate limiting.

Whichever you choose, `/api/health` must stay reachable by the load balancer.

## Cost, roughly

| | Monthly |
|---|---|
| ALB | ~$18 plus LCU |
| Fargate, 2 × 0.5 vCPU / 1 GB | ~$30 |
| NAT gateway (skip with VPC endpoints) | ~$33 |
| CloudWatch, ECR, Route 53 | a few dollars |
| **Total, excluding the database** | **~$55–85** |

Amplify Hosting would land nearer $10–20 for this traffic. The difference is the price of no
cold starts and a warm connection pool on the booking path.

## Before going live

- [ ] `SESSION_SECRET` is 32+ random characters, from Secrets Manager, identical across tasks
- [ ] `BOOKING_API_KEY` is 24+ characters (the API refuses to run below that and fails closed)
- [ ] Database user scoped to `dns_pricing`, reachable only from task-sg
- [ ] `/api/health` returns `{"status":"ok"}` from the target group
- [ ] Initial admin password changed after seeding
- [ ] Automated database backups on, and a restore actually tested
- [ ] The three source workbooks archived somewhere durable — they are the origin of every rate
- [ ] Decide the two open pricing questions before real quoting: the non-monotonic pricing in
      Models 2 and 3, and GST policy. Both are documented in the README.
