# evoapi-resilient

[![Licencia: Apache 2.0 + condiciones](https://img.shields.io/badge/License-Apache%202.0%20%2B%20conditions-blue.svg)](./LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933.svg)](https://nodejs.org/)

> **Aviso importante:** Este repositorio es un **fork no oficial** e independiente, derivado de [Evolution API](https://github.com/evolution-foundation/evolution-api) (versión base `2.3.7`). **Sin garantía ni soporte; úsalo bajo tu propia responsabilidad y haz respaldo de tu base de datos antes de migrar.** No está afiliado, patrocinado ni respaldado por Evolution Foundation ni por WhatsApp / Meta.

---

## Qué es y para quién

`evoapi-resilient` es una variante enfocada en estabilidad operativa y endurecimiento de seguridad del backend de mensajería basado en Evolution API `2.3.7` (sin interfaz gráfica/manager incluida; funciona como API REST).

Está pensado para equipos o desarrolladores que ya operan Evolution API sobre **PostgreSQL + Redis + Node.js 22+** y buscan mitigar desconexiones de Baileys, bloqueos en reconexión/proxies, duplicados de mensajes, caídas al consultar la versión de WhatsApp Web y problemas de identidad de instancia.

---

## Qué cambia respecto al upstream (`2.3.7`)

Solo se listan cambios verificados directamente en este código y en su suite de regresión:

1. **Parche de ACK para stanzas `<status>` en Baileys `7.0.0-rc12`**:
   - Archivo: `patches/baileys+7.0.0-rc12.patch` (aplicado vía `patch-package` en `postinstall`).
   - Copia suelta documentada para quien solo necesite este parche: [`docs/baileys-status-ack/`](./docs/baileys-status-ack/README.md).
   - Registra el manejador `CB:status` (en vivo y en `offlineNodeProcessor`) para enviar `<ack>` a las stanzas de estado de nivel superior (issue upstream #2778 / Baileys #2858).
2. **Reconexión automática, vigía de conexión atascada y control de concurrencia**:
   - Reconexión automática por instancia con backoff exponencial, jitter y límite de intentos (`src/api/services/monitor.service.ts`).
   - Vigía (`armStuckConnectingWatchdog`) para detectar intentos atascados en `connecting` (por ejemplo, ante proxies que no responden) y reciclar la conexión.
   - Control por generaciones/estado para evitar conexiones paralelas de una misma instancia y manejo fail-closed en `src/utils/makeProxyAgent.ts`.
3. **Deduplicación de mensajes en PostgreSQL y webhooks desacoplados con latencia**:
   - Migración `prisma/postgresql-migrations/20260909000000_add_message_idempotency/migration.sql` con índice único por `(instanceId, keyId, remoteJid, fromMe)`.
   - Cabecera `Idempotency-Key` en `src/api/integrations/event/webhook/webhook.controller.ts`.
   - Cola de envío desacoplada (`enqueueMessageWebhook` en `whatsapp.baileys.service.ts`) con marcas de latencia `receivedAtMs`, `enqueuedAtMs` y `dispatchedAtMs`.
4. **Correcciones de `@lid` y mensajes de Meta Ads**:
   - Mapeo/caché de `@lid` mediante `signalRepository.lidMapping` en `whatsapp.baileys.service.ts` y soporte de claves `@lid` en `markMessageAsRead`.
   - Manejo seguro de respuestas de Meta Ads (`externalAdReply`) y contenido ausente en `src/utils/getConversationMessage.ts`.
5. **Protección de identidad de instancia autenticado**:
   - Impide que parámetros de `query` o `body` sobrescriban la identidad de instancia validada en la ruta (`src/api/abstract/abstract.router.ts`, `src/api/guards/auth.guard.ts`, `src/api/routes/instance.router.ts`).
6. **Actualización de dependencias compatibles de HTTP, transporte, almacenamiento y vistas previas**:
   - Actualizadas dentro de versiones mayores compatibles: `express` (`4.22.3`), `multer` (`2.5.0`), `ws` (`8.23.0`), `axios` (`1.21.1`), `form-data` (`4.0.6`), `undici` (`7.30.2`), `@aws-sdk/client-sqs` (`3.1169.0`), `minio` (`8.0.7`), `link-preview-js` (`6.0.0`, con fijación DNS anti-SSRF en vistas previas) y `compression` (`1.8.2`).
7. **Resistencia ante caídas de GitHub al obtener la versión de WhatsApp Web**:
   - `src/utils/fetchLatestWaWebVersion.ts` usa consulta compartida con límite de tiempo, caché persistente en disco y fallback inmediato a la versión incluida en Baileys.

---

## Qué está validado y qué NO

- **Validado en este repositorio:**
  - Compilación TypeScript + bundle (`npm run build`).
  - Suite unitaria y de regresión (`npm run test:regressions`, 270 pruebas con `node:test` usando mocks y servidores locales).
- **NO validado / limitaciones:**
  - No incluye interfaz gráfica (`manager/dist` fue excluida); úsalo como API REST.
  - No se garantiza estabilidad a largo plazo en producción para todos los flujos ni compatibilidad equivalente en MySQL (las migraciones nuevas son de PostgreSQL).
  - No todas las dependencias del proyecto están actualizadas: `npm audit --omit=dev` aún reporta vulnerabilidades en dependencias transitivas heredadas de la base `2.3.7`.
  - No se distribuyen imágenes Docker precompiladas desde este repositorio.

---

## Variables de entorno nuevas

Además de las variables estándar de `.env.example`, este fork añade o utiliza:

- **Reconexión automática (`src/config/env.config.ts`):**
  - `WA_RECONNECT_ENABLED` (default `true`)
  - `WA_RECONNECT_MAX_ATTEMPTS` (default `6`)
  - `WA_RECONNECT_INITIAL_DELAY_MS` (default `5000`)
  - `WA_RECONNECT_MAX_DELAY_MS` (default `60000`)
  - `WA_RECONNECT_JITTER_FACTOR` (default `0.2`)
  - `WA_RECONNECT_ATTEMPT_TIMEOUT_MS` (default `45000`)
- **Caché resiliente de versión WhatsApp Web (`src/utils/fetchLatestWaWebVersion.ts`):**
  - `WA_VERSION_CACHE_PATH` (default `./instances/wa-web-version.json` o `/evolution/instances/wa-web-version.json` en contenedor)
  - `WA_VERSION_MAX_AGE_MS` (default `604800000`, 7 días)
- **Endpoints de vinculación por token (`LINK_*` en `.env.example`):**
  - `LINK_PUBLIC_ENABLED`, `LINK_PUBLIC_BASE_URL`, `LINK_TOKEN_DEFAULT_TTL_HOURS`, `LINK_TOKEN_MAX_TTL_HOURS`, `LINK_ATTEMPTS_PER_HOUR`, `LINK_ATTEMPTS_PER_TOKEN`, `LINK_MAX_AUTO_RESETS`, `LINK_RESET_AFTER_SECONDS`, `LINK_ATTEMPT_TTL_SECONDS`, `LINK_TRUST_PROXY_HOPS`, `LINK_PAIRING_MX_PREFIX`.

---

## Cómo construirlo

### Requisitos
- Node.js 22+ (recomendado Node 24 Alpine, igual que el `Dockerfile`)
- PostgreSQL y Redis

### Compilación y arranque local
```bash
cp .env.example .env
# Edita .env con tu PostgreSQL, Redis y AUTHENTICATION_API_KEY

npm ci
# postinstall ejecuta patch-package y aplica patches/baileys+7.0.0-rc12.patch

export DATABASE_PROVIDER=postgresql
npm run db:generate
npm run db:deploy
npm run build
npm run start:prod
```

### Construcción local de imagen Docker
```bash
docker build -t evoapi-resilient:local .
```

---

## Cómo revertir al upstream

1. **Antes de migrar:** guarda un respaldo completo (`pg_dump`) de tu base de datos PostgreSQL y anota la etiqueta/digest de tu imagen anterior.
2. Si deseas volver a la distribución oficial (`evolution-foundation/evolution-api` / `evoapicloud/evolution-api`):
   - Detén el servicio y vuelve a apuntar tu despliegue al repositorio o imagen oficial del upstream.
   - Si ya ejecutaste las migraciones nuevas de este fork (`20260909000000_add_message_idempotency` o `20261006120000_add_link_token`), restaura el respaldo de PostgreSQL previo a la migración para evitar diferencias de esquema con Prisma del upstream.

---

## Atribución, licencia y riesgos de uso

- **Licencia de código:** Este proyecto conserva la **Apache License 2.0** con las condiciones adicionales definidas por Evolution Foundation en [`LICENSE`](./LICENSE) y las atribuciones en [`NOTICE`](./NOTICE) (incluyendo Evolution Foundation, CodeChat y Baileys).
- **Requisito de notificación (LICENSE §1.b):** Si integras o utilizas este software dentro de cualquier sistema (incluidos sistemas propietarios), debes mostrar una notificación clara accesible para los administradores indicando que se utiliza Evolution API.
- **Marcas e identidad visual:** El uso de nombres y marcas de Evolution Foundation se rige por [`TRADEMARKS.md`](./TRADEMARKS.md). Este fork no utiliza el logotipo oficial ni sugiere respaldo de Evolution Foundation.
- **Términos de WhatsApp / Meta:** El proveedor basado en Baileys utiliza ingeniería inversa del protocolo WebSocket de WhatsApp Web, lo cual contraviene los Términos de Servicio de WhatsApp / Meta y conlleva riesgo de suspensión o bloqueo permanente de números. Para uso oficial y conforme a políticas de Meta, utiliza WhatsApp Cloud API.

---

## Brief English Summary

`evoapi-resilient` is an **unofficial, independent fork** based on [Evolution API](https://github.com/evolution-foundation/evolution-api) (`v2.3.7`), provided **AS IS with no warranty and no support commitment**. Back up your database before migrating. It is not affiliated with or endorsed by Evolution Foundation or Meta/WhatsApp.

**Verified changes included:**
- `patch-package` fix for Baileys `7.0.0-rc12` top-level `<status>` stanza ACKs (also available standalone in [`docs/baileys-status-ack/`](./docs/baileys-status-ack/README.md)).
- Automatic per-instance reconnection with stuck-connecting watchdog, single-connection state guards, and fail-closed proxy handling.
- PostgreSQL message deduplication migration, `Idempotency-Key` webhook header, decoupled webhook queue, and delivery latency timestamps (`receivedAtMs`, `enqueuedAtMs`, `dispatchedAtMs`).
- `@lid` mapping/read-receipt fixes and safer Meta Ads (`externalAdReply`) / missing-content handling.
- Authenticated instance identity protection against `query`/`body` overrides.
- Compatible security updates for HTTP, transport, storage, DNS-pinned link previews, and `compression` `1.8.2` (note: transitive `npm audit` advisories remain).
- Resilient WhatsApp Web version lookup with disk cache and bundled fallback during GitHub outages.

See [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE), and [`TRADEMARKS.md`](./TRADEMARKS.md) for full licensing and trademark terms.
