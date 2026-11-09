# Plan: slab-runner-code

Estado: implementado en `feat/coding` · 2026-11-09 · Contrato: [code-runner-contract.md](code-runner-contract.md) · Plan padre: [`slab-agents/docs/plans/coding-and-workspaces.md`](../../../slab-agents/docs/plans/coding-and-workspaces.md)

## Idea

Un **segundo contenedor de Slab Runner** (`slab-runner-code`) que hace de sandbox para programar:

- Usa el mismo código del Runner, con `RUNNER_PROFILE=code`.
- Codex con **login de OpenAI (ChatGPT)**, igual que hoy. El runner-code hace su propio
  device login con los endpoints `/auth/codex*` que ya existen.
- **El contenedor es el sandbox**: Codex corre adentro sin pedir aprobación por comando, y
  todo lo que rompa queda ahí.
- Por cada tarea hay un checkout del repo en su propia rama. Al terminar, el Runner commitea,
  hace push de `slab/<issue>` y slab-agents abre el PR.

Nada de API keys, proxies de credenciales ni separación de usuarios en v1.

## Qué cambia en slab-runner

### 1. Perfil `code`

- **Config**: `RUNNER_PROFILE=code` y `RUNNER_CODE_ROOT=/var/lib/slab-code`.
- **Runs**: en `POST /runs` se agrega `workspace: { id }` y el Runner resuelve
  `cwd = <root>/workspaces/<id>/repo`. Así el control plane no manda paths arbitrarios.
- **Codex** (`codex-adapter.ts`), cuando el run trae workspace:
  - `approvalPolicy: "never"` y sandbox `danger-full-access`, o `externalSandbox` si la
    versión de Codex lo soporta. El aislamiento lo da Docker.
  - Las aprobaciones de MCP (Work y Docs) siguen igual que hoy.
  - Preámbulo en `developerInstructions`: estás en la rama X, no hay remote, corré
    `<test>` antes de terminar, no toques `.github/workflows`, y terminá con un resumen.
- **Límites**: timeout de wall-clock por run (default 60 min) y `RUNNER_MAX_ACTIVE_RUNS` (default 2).

### 2. Workspaces (endpoints nuevos, sólo en el perfil `code`)

```http
POST   /workspaces            { workspaceId, repo: { cloneUrl, defaultBranch }, branch,
                                fetchToken, setupCommand?, testCommand? }
GET    /workspaces/:id        → { status, baseSha, headSha, diffStat }
POST   /workspaces/:id/test   → { exitCode, logTail }        // corre testCommand
POST   /workspaces/:id/publish { pushToken, commitMessage }  → { branch, sha, diffStat }
DELETE /workspaces/:id
GET    /workspaces/:id/handoff/:name   // archivos de handoff de las etapas (spec.md, plan.md, ...)
PUT    /workspaces/:id/handoff/:name   // Slab escribe inputs (feedback-items.json, run.md)
```

Cada workspace tiene `repo/` (checkout) y `handoff/` (fuera del repo, nunca se commitea).
Los dos son escribibles por el agente. Los nombres de handoff se validan con
`^[a-z0-9][a-z0-9._-]{0,80}$` y tienen un tope de 2 MB.

**Preparar.** `git clone` con el `fetchToken`, pasado por un credential helper definido en la
línea de comandos (nunca un script en disco) y nunca escrito en la config. Después `git switch -c slab/<issue>`, se borra el `origin` y se corre `setupCommand`.

**Publicar:**

1. Mata los procesos que haya dejado el run.
2. `git add -A && git commit` en el checkout, sin hooks ni credenciales.
3. Copia `HEAD` y `baseSha` a un repo bare temporal y limpio (fetch local); desde ahí
   rechaza si **cualquier** commit de `baseSha..HEAD` toca `.github/workflows/` o
   `.gitmodules`.
4. `git push` desde el repo limpio a `refs/heads/<branch>` (`branch` y `baseSha` vienen en la
   petición y deben coincidir con el workspace), con el `pushToken` vía credential helper.

**Limpieza.** Borra el directorio. Hay un GC de workspaces viejos (más de 3 días).

Los tokens de GitHub los genera slab-agents (GitHub App, vida de 1 h) y sólo existen
durante el clone y el push, nunca mientras corre el agente.

## Imagen y Compose

**Imagen**: target `code` del Dockerfile.

- Base `node:22-bookworm`, más git, build-essential, python3, ripgrep y jq.
- Conserva npm y habilita pnpm/yarn con corepack.
- Codex fijado a la misma versión que el runner actual.

**Compose** (slab-stack, perfil `code`):

```yaml
slab-runner-code:
  image: ${SLAB_RUNNER_CODE_IMAGE}
  profiles: [code]
  networks: [code]              # red propia con salida a internet; no ve slab-api, docs ni la DB
  volumes:
    - runner_code_codex:/var/lib/slab-runner/codex   # su propio login de Codex
    - code_data:/var/lib/slab-code                   # repos y cachés (npm/pnpm)
  secrets: [runner_code_token]
  mem_limit: 6g
  cpus: 3
  pids_limit: 2048
  security_opt: ["no-new-privileges:true"]
```

- slab-agents se une también a la red `code` para hablarle al runner.
- Las MCP de Work y Docs se pasan apuntando a slab-agents, que hace de puente, porque el
  runner-code no está en `control`.
- `slabctl install_code` activa el perfil (como `install_whatsapp`).

## Lo único de GitHub que hay que respetar

- La **GitHub App sin permiso `workflows`**. Si no, un PR del agente podría editar el CI y
  leer los secrets de Actions.
- **Branch protection en `main`**: merge humano.

## Riesgo aceptado

Adentro del contenedor el código que corre el agente puede leer el `auth.json` de Codex y
el token del runner-code. Es lo mismo que pasa corriendo Codex en tu máquina. El contenedor
no tiene otros secretos ni acceso a la red interna. Si después molesta, se corre el agente
con otro uid (v2).

## Pasos

| # | Qué | Listo cuando |
|---|---|---|
| 1 | Perfil `code`, endpoints de workspace (prepare, test, publish, delete) y `cwd` por workspace | Tests de integración con un bare repo local como remoto |
| 2 | Codex sin aprobaciones por comando en el perfil code, preámbulo, timeout y concurrencia | Un run real edita, testea y deja un resumen en un repo fixture |
| 3 | Imagen `code` y servicio Compose con red `code` | `docker compose --profile code up` y device login de Codex desde Settings |
| 4 | Push real a un repo sandbox de GitHub con la App | La rama aparece en GitHub; el push a `main` y a `.github/workflows` es rechazado |

Estimación: **alrededor de 1 semana** para el Runner. En paralelo, en slab-agents: la GitHub
App con escritura, el registro de repos con `setup` y `test`, el modo de run `code`, abrir
el PR y una segunda entrada de Runner en Settings para el login de Codex.

## A confirmar antes de arrancar

- Que la versión de Codex del stack (0.148) acepte `approvalPolicy: "never"` con `cwd` por
  thread. Lo usa hoy el modo `yolo`, así que debería.
- El repo piloto de CleanCut y sus comandos de setup y test.
