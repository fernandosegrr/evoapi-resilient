# CLAUDE.md

This file provides comprehensive guidance to Claude AI when working with the Evolution API codebase.

## Project Overview

**Evolution API** is a powerful, production-ready REST API for WhatsApp communication that supports multiple WhatsApp providers:
- **Baileys** (WhatsApp Web) - Open-source WhatsApp Web client
- **Meta Business API** - Official WhatsApp Business API
- **Evolution API** - Custom WhatsApp integration

Built with **Node.js 20+**, **TypeScript 5+**, and **Express.js**, it provides extensive integrations with chatbots, CRM systems, and messaging platforms in a **multi-tenant architecture**.

## Common Development Commands

### Build and Run
```bash
# Development
npm run dev:server    # Run in development with hot reload (tsx watch)

# Production
npm run build        # TypeScript check + tsup build
npm run start:prod   # Run production build

# Direct execution
npm start           # Run with tsx
```

### Code Quality
```bash
npm run lint        # ESLint with auto-fix
npm run lint:check  # ESLint check only
npm run commit      # Interactive commit with commitizen
```

### Database Management
```bash
# Set database provider first
export DATABASE_PROVIDER=postgresql  # or mysql

# Generate Prisma client (automatically uses DATABASE_PROVIDER env)
npm run db:generate

# Deploy migrations (production)
npm run db:deploy      # Unix/Mac
npm run db:deploy:win  # Windows

# Development migrations (with sync to provider folder)
npm run db:migrate:dev      # Unix/Mac
npm run db:migrate:dev:win  # Windows

# Open Prisma Studio
npm run db:studio

# Development migrations
npm run db:migrate:dev      # Unix/Mac
npm run db:migrate:dev:win  # Windows
```

### Testing
```bash
npm run test:regressions  # Real regression suite (reconnect/proxy/settings/events) — use this
npm test                  # Inherited from upstream; watches test/all.test.ts, which doesn't exist in this repo — currently broken
```

## Architecture Overview

### Core Structure
- **Multi-tenant SaaS**: Complete instance isolation with per-tenant authentication
- **Multi-provider database**: PostgreSQL and MySQL via Prisma ORM with provider-specific schemas and migrations
- **WhatsApp integrations**: Baileys, Meta Business API, and Evolution API with unified interface
- **Event-driven architecture**: EventEmitter2 for internal events + WebSocket, RabbitMQ, SQS, NATS, Pusher for external events
- **Microservices pattern**: Modular integrations for chatbots, storage, and external services

### Directory Layout
```
src/
├── api/
│   ├── controllers/     # HTTP route handlers (thin layer)
│   ├── services/        # Business logic (core functionality)
│   ├── repository/      # Data access layer (Prisma)
│   ├── dto/            # Data Transfer Objects (simple classes)
│   ├── guards/         # Authentication/authorization middleware
│   ├── integrations/   # External service integrations
│   │   ├── channel/    # WhatsApp providers (Baileys, Business API, Evolution)
│   │   ├── chatbot/    # AI/Bot integrations (OpenAI, Dify, Typebot, Chatwoot)
│   │   ├── event/      # Event systems (WebSocket, RabbitMQ, SQS, NATS, Pusher)
│   │   └── storage/    # File storage (S3, MinIO)
│   ├── routes/         # Express route definitions (RouterBroker pattern)
│   └── types/          # TypeScript type definitions
├── config/             # Environment and app configuration
├── cache/             # Redis and local cache implementations
├── exceptions/        # Custom HTTP exception classes
├── utils/            # Shared utilities and helpers
└── validate/         # JSONSchema7 validation schemas
```

### Key Integration Points

**Channel Integrations** (`src/api/integrations/channel/`):
- **Baileys**: WhatsApp Web client with QR code authentication
- **Business API**: Official Meta WhatsApp Business API
- **Evolution API**: Custom WhatsApp integration
- Connection lifecycle management per instance with automatic reconnection

**Chatbot Integrations** (`src/api/integrations/chatbot/`):
- **EvolutionBot**: Native chatbot with trigger system
- **Chatwoot**: Customer service platform integration
- **Typebot**: Visual chatbot flow builder
- **OpenAI**: AI capabilities including GPT and Whisper (audio transcription)
- **Dify**: AI agent workflow platform
- **Flowise**: LangChain visual builder
- **N8N**: Workflow automation platform
- **EvoAI**: Custom AI integration

**Event Integrations** (`src/api/integrations/event/`):
- **WebSocket**: Real-time Socket.io connections
- **RabbitMQ**: Message queue for async processing
- **Amazon SQS**: Cloud-based message queuing
- **NATS**: High-performance messaging system
- **Pusher**: Real-time push notifications

**Storage Integrations** (`src/api/integrations/storage/`):
- **AWS S3**: Cloud object storage
- **MinIO**: Self-hosted S3-compatible storage
- Media file management and URL generation

### Database Schema Management
- Separate schema files: `postgresql-schema.prisma` and `mysql-schema.prisma`
- Environment variable `DATABASE_PROVIDER` determines active database
- Migration folders are provider-specific and auto-selected during deployment

### Authentication & Security
- **API key-based authentication** via `apikey` header (global or per-instance)
- **Instance-specific tokens** for WhatsApp connection authentication
- **Guards system** for route protection and authorization
- **Input validation** using JSONSchema7 with RouterBroker `dataValidate`
- **Rate limiting** and security middleware
- **Webhook signature validation** for external integrations

## Important Implementation Details

### WhatsApp Instance Management
- Each WhatsApp connection is an "instance" with unique name
- Instance data stored in database with connection state
- Session persistence in database or file system (configurable)
- Automatic reconnection handling with exponential backoff

### Message Queue Architecture
- Supports RabbitMQ, Amazon SQS, and WebSocket for events
- Event types: message.received, message.sent, connection.update, etc.
- Configurable per instance which events to send

### Media Handling
- Local storage or S3/Minio for media files
- Automatic media download from WhatsApp
- Media URL generation for external access
- Support for audio transcription via OpenAI

### Multi-tenancy Support
- Instance isolation at database level
- Separate webhook configurations per instance
- Independent integration settings per instance

## Environment Configuration

Key environment variables are defined in `.env.example`. The system uses a strongly-typed configuration system via `src/config/env.config.ts`.

Critical configurations:
- `DATABASE_PROVIDER`: postgresql or mysql
- `DATABASE_CONNECTION_URI`: Database connection string
- `AUTHENTICATION_API_KEY`: Global API authentication
- `REDIS_ENABLED`: Enable Redis cache
- `RABBITMQ_ENABLED`/`SQS_ENABLED`: Message queue options

### `WA_RECONNECT_*` — automatic reconnection (not part of the original fork)

Added to recover unattended from dropped WhatsApp connections:
- `WA_RECONNECT_ENABLED` (default `true`): master switch for the automatic reconnection system.
- `WA_RECONNECT_MAX_ATTEMPTS` (default `6`): attempts before an instance is flagged for manual intervention.
- `WA_RECONNECT_INITIAL_DELAY_MS` / `WA_RECONNECT_MAX_DELAY_MS` (default `5000` / `60000`): exponential backoff bounds between attempts.
- `WA_RECONNECT_JITTER_FACTOR` (default `0.2`): randomization applied to each delay to avoid reconnect storms across instances.
- `WA_RECONNECT_ATTEMPT_TIMEOUT_MS` (default `45000`): hard ceiling for a single reconnect attempt (e.g. a proxy TCP connect that never resolves) — past this, the attempt counts as failed and normal backoff schedules the next one. Neither this timeout nor the stuck-connecting watchdog applies to a runtime that already emitted a QR (`instance.qrcode.count > 0` while `connecting`): it is waiting for a person to scan or type a pairing code, and recycling it would invalidate the code. A retry also keeps the phone number a pairing code was requested for, until the phone accepts the code (`creds.registered`/`creds.account`). Details and live evidence: `docs/validation/pairing-watchdog-2026-10-06.md`.

### Webhook delivery timing and diagnostics (not part of the original fork)

Added after the 2026-10-06 cumulative webhook delay (webhooks ~60s apart; see `docs/validation/webhook-delivery-delay-2026-10-06.md`):
- `messages.upsert` webhooks carry `receivedAtMs`, `enqueuedAtMs` and `dispatchedAtMs` (epoch ms, UTC) at the top level. `date_time` is the server local time labelled `Z` and is **not** UTC; do not use it to measure delays.
- `GET /instance/deliveryMetrics` (global apikey) and `/instance/deliveryMetrics/:instanceName`: in-memory queue depth/waits and the last 50 slow steps per instance. A step of 2s or more logs one `[SLOW-STEP]` warning.
- `WEBHOOK_TIMING_LOGS` (default `false`): per-message `[WEBHOOK-TIMING]` detail, only for investigations.
- `WEBHOOK_MEDIA_DOWNLOAD_TIMEOUT_MS` (default `15000`): deadline for the media download attached to a webhook as base64; on timeout the message is still delivered with `mediaError.code = MEDIA_DOWNLOAD_TIMEOUT`.
- Rule for the per-instance event chain (`eventQueue`): nothing inside it may wait on WhatsApp without an explicit timeout. Profile pictures are looked up in the background (`ProfilePictureResolver`), never with `await` in `messages.upsert`.

### Self-service link (`LINK_*`) — not part of the original fork

A customer opens a public link on their phone and generates their own pairing code or QR for their own instance, without an apikey. Design, decisions and threat model: `docs/design/link-vinculacion-2026-10-06.md`; validation: `docs/validation/`.

- **Off by default.** `LINK_PUBLIC_ENABLED` (default `false`) controls whether `/public/link/*` is mounted. Administration (`POST/GET /instance/linkTokens`, `DELETE /instance/linkTokens/:linkId`, `GET /instance/linkTokens/_diagnostics`) exists regardless but only accepts the **global** apikey (an instance's own key is rejected: the routes carry no `:instanceName`).
- The token (256 bits, base64url) is shown **once** when the link is created; only its SHA-256 is stored in `LinkToken`. It lives in the URL fragment (`/manager/link#t=…`), which never reaches a server or a log, and travels in `Authorization: Bearer`. Status is derived: revoked > consumed > expired > active. A link is consumed when the line reaches `open`.
- `LINK_PUBLIC_BASE_URL` (optional origin) builds links with a custom domain; otherwise the manager uses the URL it logged in with. `LINK_TOKEN_DEFAULT_TTL_HOURS` (24) / `LINK_TOKEN_MAX_TTL_HOURS` (168, hard cap 7 days).
- Quotas (persisted, atomic): `LINK_ATTEMPTS_PER_HOUR` (6) and `LINK_ATTEMPTS_PER_TOKEN` (12) per link; **every automatic reset counts as an attempt**. WhatsApp's threshold for temporarily blocking a number that registers many new devices is **not known**; these values are prudent guesses to be calibrated with the `[LINK] reinicio` log lines.
- **Reset to zero** (run by the link service, never by the generic reconnect watchdog): `LINK_RESET_AFTER_SECONDS` (120) after the code was first shown with no progress, up to `LINK_MAX_AUTO_RESETS` (2) per link (`0` disables it), the socket is discarded, the unpaired session cleaned and the same mode/number reconnected. Renewals (a new code on the same socket every 45 s) are not resets. It never acts on an open line, a socket it did not create, or once the phone started to link. `LINK_ATTEMPT_TTL_SECONDS` (600) bounds a whole attempt.
- **"Paired session" = `creds.registered || creds.account`.** Baileys only sets `registered` in the pairing-code flow; a QR-linked session keeps `registered:false` and gets `account` at pair-success. The link refuses to act (`unavailable`) unless sessions are stored in the database (not Redis/provider files).
- `LINK_TRUST_PROXY_HOPS` (1): trusted proxies in front of the server, used only for per-IP limits (the `hops`-th `X-Forwarded-For` entry from the right). Check it with `_diagnostics` before enabling. `LINK_PAIRING_MX_PREFIX` (`52` or legacy `521`, **provisional `52`** until verified with a real phone) decides how Mexican numbers are sent for a pairing code; `expectedNumber` compares 52 and 521 as the same line.
- Per-IP limits on the public router are generous on purpose (many customers share a carrier-grade NAT address): 120 requests/min, 10 starts/hour, and an address that sends 10 non-existent tokens in 15 minutes is cut off.

### Event key rename: `*_GROUPS_UPDATE` → `*_GROUP_UPDATE`

The env vars controlling the WhatsApp group-metadata-changed event (across Webhook, WebSocket, RabbitMQ, SQS, Kafka, Pusher) were renamed from the plural `*_GROUPS_UPDATE` to the canonical `*_GROUP_UPDATE`, matching the event key Baileys actually emits. The old plural names still work as compatibility aliases — if both are set, the canonical `*_GROUP_UPDATE` wins, even when it's explicitly `false`. Not part of the original fork; see `docs/validation/backend-audit-2026-09-13.md`.

## Development Guidelines

The project follows comprehensive development standards defined in `.cursor/rules/`:

### Core Principles
- **Always respond in Portuguese (PT-BR)** for user communication
- **Follow established architecture patterns** (Service Layer, RouterBroker, etc.)
- **Robust error handling** with retry logic and graceful degradation
- **Multi-database compatibility** (PostgreSQL and MySQL)
- **Security-first approach** with input validation and rate limiting
- **Performance optimizations** with Redis caching and connection pooling

### Code Standards
- **TypeScript strict mode** with full type coverage
- **JSONSchema7** for input validation (not class-validator)
- **Conventional Commits** enforced by commitlint
- **ESLint + Prettier** for code formatting
- **Service Object pattern** for business logic
- **RouterBroker pattern** for route handling with `dataValidate`

### Architecture Patterns
- **Multi-tenant isolation** at database and instance level
- **Event-driven communication** with EventEmitter2
- **Microservices integration** pattern for external services
- **Connection pooling** and lifecycle management
- **Caching strategy** with Redis primary and Node-cache fallback

## Testing Approach

- **`npm run test:regressions`** (`node --test tests/*.test.cjs`) is the real, working regression suite added in this fork — covers the reconnect/proxy/settings/events fixes described under Environment Configuration below. Run this before pushing backend changes.
- **`npm test`** (`tsx watch ./test/all.test.ts`) is inherited from the original fork's `package.json`. `test/all.test.ts` does not exist in this repo, so the command fails immediately — left as-is rather than silently redefined; treat it as dead until someone deliberately repurposes it for real watch-mode TDD.
- `node tests/backend-audit-real.cjs` runs a live-database audit against a real Evolution API instance (creates/deletes its own isolated instances). It's separate from `test:regressions` (its filename doesn't match the `*.test.cjs` glob) and is run manually, not as part of the regular suite.
- **Manual testing** remains the primary way to validate end-to-end WhatsApp connection flows (QR pairing, real message send/receive) — see `docs/validation/` for past live-canary sessions.

### Recommended Testing Strategy
- Focus on **critical business logic** in services
- **Mock external dependencies** (WhatsApp APIs, databases)
- **Integration tests** for API endpoints
- **Manual testing** for WhatsApp connection flows

## Deployment Considerations

- Docker support with `Dockerfile` and `docker-compose.yaml`
- Graceful shutdown handling for connections
- Health check endpoints for monitoring
- Sentry integration for error tracking
- Telemetry for usage analytics (non-sensitive data only)