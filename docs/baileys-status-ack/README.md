# Parche: ACK de stanzas `<status>` en Baileys 7.0.0-rc12

## Español

### Qué corrige
En Baileys `7.0.0-rc12`, algunas cuentas reciben actualizaciones de estado (historias) como stanzas `<status>` de nivel superior que no tenían manejador registrado. Al no enviarse el `<ack>` correspondiente, WhatsApp puede cortar o dejar la sesión en un estado "conectado pero sordo" / con desconexiones periódicas (`Stream Errored (ack)`).

- Issue en Baileys: [#2858](https://github.com/WhiskeySockets/Baileys/issues/2858) (estado al 2026-11-16: **abierto**)
- PR en Baileys: [#2883](https://github.com/WhiskeySockets/Baileys/pull/2883) (estado al 2026-11-16: **abierto, sin mergear**)
- Issue / PR en Evolution API: #2778 / PR [#2785](https://github.com/evolution-foundation/evolution-api/pull/2785) (estado al 2026-11-16: **abierto, sin mergear**)

### Qué incluye esta carpeta
1. `baileys+7.0.0-rc12.patch`: parche para `patch-package` sobre `node_modules/baileys/lib/Socket/messages-recv.js` (maneja `CB:status` tanto en vivo como en la cola `offlineNodeProcessor`).
2. `baileys-status-ack.test.cjs`: prueba unitaria con `node:test` (verifica ACK en vivo, error en ACK sin romper nodos siguientes, orden en cola offline y verificación del `Dockerfile`).

### Cómo aplicarlo
1. Instala `patch-package` en tu proyecto y agrega `"postinstall": "patch-package --error-on-fail"` en `package.json`.
2. Copia `baileys+7.0.0-rc12.patch` dentro de `patches/` en la raíz de tu proyecto.
3. Ejecuta `npx patch-package --error-on-fail`.
4. Si usas Docker, asegúrate de copiar `patches/` antes de `npm install` / `npm ci`.
5. (Opcional) Copia `baileys-status-ack.test.cjs` a `tests/` y ejecuta `node --test tests/baileys-status-ack.test.cjs`.

---

## English

### What this fixes
In Baileys `7.0.0-rc12`, certain accounts receive contact status updates (stories) as top-level `<status>` stanzas with no registered handler. Without sending an `<ack>`, WhatsApp can drop or stall the session ("connected but deaf" / periodic `Stream Errored (ack)` disconnects).

- Baileys issue: [#2858](https://github.com/WhiskeySockets/Baileys/issues/2858) (status as of 2026-11-16: **open**)
- Baileys PR: [#2883](https://github.com/WhiskeySockets/Baileys/pull/2883) (status as of 2026-11-16: **open, unmerged**)
- Evolution API issue / PR: #2778 / PR [#2785](https://github.com/evolution-foundation/evolution-api/pull/2785) (status as of 2026-11-16: **open, unmerged**)

### Contents
1. `baileys+7.0.0-rc12.patch`: `patch-package` patch for `node_modules/baileys/lib/Socket/messages-recv.js` (handles `CB:status` both live and via `offlineNodeProcessor`).
2. `baileys-status-ack.test.cjs`: `node:test` regression test covering live ACK, error resilience, offline queue ordering, and `Dockerfile` patch retention.

### How to apply
1. Install `patch-package` and add `"postinstall": "patch-package --error-on-fail"` to `package.json`.
2. Place `baileys+7.0.0-rc12.patch` into `patches/` at your project root.
3. Run `npx patch-package --error-on-fail`.
4. If building with Docker, copy `patches/` before running `npm install` / `npm ci`.
5. (Optional) Place `baileys-status-ack.test.cjs` in `tests/` and run `node --test tests/baileys-status-ack.test.cjs`.
