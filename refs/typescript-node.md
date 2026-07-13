# Stack Reference — typescript-node

TypeScript on Node, pnpm workspaces monorepo. Backend frameworks: NestJS, Express, Fastify. Front-end/full-stack:
Next.js, React, Expo/React Native. Data layer: Prisma, TypeORM, Drizzle, or a hand-rolled driver (e.g. `better-sqlite3`).
This reference tells the scout which component types recur, how to find them, and which invariants to capture per type.

## Detection signals
- `package.json` + `tsconfig.json` (often a shared `tsconfig.base.json` at root that each workspace `extends`).
- Lockfile picks the package manager: `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, `package-lock.json`→npm, `bun.lockb`→bun.
  Also read `packageManager` in root `package.json` (e.g. `"pnpm@11.1.1"`).
- Monorepo: `pnpm-workspace.yaml` (`packages: ["apps/*", "packages/*"]`), `workspaces`, `turbo.json`, or `nx.json`.
- Framework by dependency: `@nestjs/*`, `express`, `fastify`, `next`, `react`, `expo`.
- Data layer by dependency/files: `@prisma/client` + `schema.prisma`; `typeorm` + `@Entity`; `drizzle-orm`; or a driver
  like `better-sqlite3` with hand-rolled SQL under a `migrations/` dir.

## Slicing
- Monorepo: one slice per workspace under `packages/*` or `apps/*` (a dir with its own `package.json` and `name`).
- Single app: slice by top-level `src/` domain dir (e.g. `src/<domain>/`, `src/modules/*`), or by feature folder.

## Conventional commands (read `package.json` scripts; prefer them over guesses)
Root usually fans out to every workspace via `pnpm -r run <script>` (add `--parallel` for long-running ones).
| Purpose | Typical (`{pm}` = detected manager) |
| --- | --- |
| build | `{pm} run build` (else `tsc -p tsconfig.json`; per-app may be `nest build` / `next build`) |
| test | `{pm} test` (jest or vitest; root: `{pm} -r run test`) |
| test-one | `{pm} --filter {WORKSPACE} test -- {TEST}` / `jest {TEST}` / `vitest run {TEST}` |
| typecheck | `{pm} run typecheck` (else `tsc --noEmit`) |
| lint | `{pm} run lint` (else `eslint .`; may be `next lint`) |
| format | `{pm} run format` (else `prettier --write .` if prettier present) |
| run (dev) | `{pm} run dev` (per-app: `nest start --watch` / `next dev` / `expo start`) |

Detect the package manager from the lockfile and target a single workspace with `--filter <name>` before writing commands.
Do not assume `format`/`lint` exist — many scripts are stubs (`echo "(no lint configured)"`); treat a stub as "not configured".

## Test framework
Jest and/or Vitest — a monorepo may use both (e.g. Jest for the app, Vitest for a pure package). Detect per workspace:
- Jest: a `jest.config.ts`/`jest.config.js` or a `jest` key in `package.json`; test files matched by `testRegex`
  (commonly `.*\.test\.ts$`) or `*.spec.ts`. NestJS commonly pairs `ts-jest` + `@nestjs/testing`.
- Vitest: `vitest.config.ts` or a `test` block in the config; script `vitest run`.
- Test doubles: `jest-mock-extended` (`mock<T>()`, `DeepMockProxy`) for interfaces; `@nestjs/testing`
  `Test.createTestingModule` for wiring; `supertest` for HTTP; Testing Library (`@testing-library/react[-native]`) for UI.
Confirm which framework each workspace actually uses before writing a test command — do not assume one globally.

## Component catalog (find → capture invariants)

For each type: **find** (grep, `--include='*.ts'` / `'*.tsx'`) then **capture** the listed invariants. Verify a pattern
returns hits in the target repo before relying on it.

### route / controller
- find: `@Controller(` (Nest) / `router.(get|post|put|delete|patch)(` / `app.(get|post)(` (Express/Fastify). ex: `apps/api/src/article/article.controller.ts`
- invariants: path prefix in `@Controller('...')`; class- vs method-level guards (`@UseGuards`); verb+status decorators (`@Get`, `@HttpCode(HttpStatus.CREATED)`); param extraction (`@Param`, `@Body`, custom `@CurrentUser()`); request/response DTO types; explicit `Promise<T>` return; constructor-injected service.

### service
- find: `@Injectable()` + `class .*Service`. ex: `apps/api/src/article/article.service.ts`
- invariants: `@Injectable()`; constructor DI with `private readonly` fields; per-class `Logger(X.name)`; explicit typed `async` returns; never touches the DB (delegates to a repository); throws domain errors (not HTTP exceptions) for the global filter to map.

### dto / schema
- find: `class .*Dto` + `class-validator` (`@IsString`, `@IsOptional`, `@MaxLength`), or `z.object(` (zod). ex: `apps/api/src/article/dto/create-article.dto.ts` (class); `apps/api/src/ingest/ingest.schema.ts` (zod)
- invariants: two idioms coexist — **request DTOs** are `class` + `class-validator` (enforced by a global `ValidationPipe`, non-`Dto` fields whitelisted/rejected); **internal/LLM payloads** are zod `z.object(...)` with `type X = z.infer<typeof Schema>`. Capture which lib guards which boundary; `!`/`?` mark required/optional.

### entity / model / repository
- find: Prisma `model X` in `schema.prisma`; TypeORM `@Entity(`; or `class .*Repository`. ex: `apps/api/prisma/schema.prisma`; `apps/api/src/article/article.repository.ts`; `apps/api/src/database/migration-runner.ts`
- invariants: **ORM boundary** — which store each layer owns (e.g. one DB via Prisma, another via a raw driver). Prisma: `@id`/`@default`, relations, `@@map`/`@@index`, `prisma migrate`. Raw-driver repository: `@Injectable()`; a `*Row` (snake_case) + `*Domain` (camelCase) type pair with a `toDomain()` mapper; prepared statements; multi-step deletes wrapped in `db.transaction(() => …)`; migration mechanism (`prisma migrate` vs hand-rolled SQL under a `migrations/` dir applied by a runner).

### module
- find: `@Module(` (Nest). ex: `apps/api/src/article/article.module.ts`
- invariants: `imports` (other modules), `controllers`, `providers` (services + repositories), `exports` (what other modules may inject). Cross-module providers are re-listed in `providers` or reached via an imported module's `exports`.

### middleware / guard / interceptor / decorator
- find: `implements CanActivate` (guard) / `NestMiddleware` / `@Injectable()`+`intercept(` (interceptor) / `createParamDecorator(` / Express `(req, res, next) =>`. ex: `apps/api/src/auth/jwt-auth.guard.ts`; `apps/api/src/common/decorators/current-user.decorator.ts`
- invariants: `@Injectable()` + `canActivate(context: ExecutionContext): boolean`; how identity is read (cookie and/or `Authorization: Bearer`) and attached to the request; throws a framework exception on failure (`UnauthorizedException`); param decorators pull the augmented field off the request via `switchToHttp().getRequest`.

### job / worker (queue)
- find: `@Processor(` + `extends WorkerHost` (Nest BullMQ) / `new Worker(` / `.process(` (bare BullMQ) / `@Cron(`. ex: `apps/api/src/generation/content-generation.worker.ts`; `apps/api/src/queue/queue.module.ts`
- invariants: `@Processor(QUEUE_NAME, { concurrency, lockDuration, … })`; `override async process(job: Job<T>)`; job data typed (often a discriminated union on a `type` field); retry semantics (throw → BullMQ retries; `return` for terminal failures); fire-and-forget follow-ups via `void queue.add(...).catch(...)`; queue names centralized in a constants module and registered via `BullModule.registerQueue`.

### auth strategy / config
- find: Passport `new Strategy(...)` inside an `@Injectable()`, or env-schema parsing. ex: `apps/api/src/auth/google.strategy.ts`; `apps/api/src/common/config/config.schema.ts`
- invariants: config parsed+validated once (a zod `ConfigSchema` with `z.coerce`, `.default(...)`, `type AppConfig = z.infer<...>`); env read through a typed `ConfigService<AppConfig, true>` with `{ infer: true }`, never raw `process.env`; secrets required (`.min(1)` / `getOrThrow`).

### exception / error filter
- find: `extends Error` (domain error) and `implements ExceptionFilter` + `@Catch()` (global filter). ex: `apps/api/src/article/errors/article-not-found.error.ts`; `apps/api/src/common/filters/global-exception.filter.ts`
- invariants: domain errors are thin `class X extends Error` with a literal `readonly code = '…' as const` and `this.name = 'X'`; a single `@Catch()` filter maps error class name → HTTP status and emits a consistent `{ error: { code, message } }` body; registered once via `app.useGlobalFilters(...)` at bootstrap.

### front-end (Next.js / React / Expo)
- find: `'use client'`, `@tanstack/react-query` `useQuery`/`useMutation`, `export default function`. ex: `apps/web/src/hooks/useItems.ts`; pure package fn: `packages/prompt/src/serializers/summary.ts`
- invariants: server vs client components (`'use client'` pragma); data access via colocated hooks that wrap a shared `apiFetch` and key factories (`xKeys.list(id)`), calling `useQueryClient().invalidateQueries` after mutations; shared types imported from the workspace types package; path alias `@/*` for app-local imports.

## Conventions to look for (seed the convention skill only if consistently observed)
- `strict` tsconfig (a shared `tsconfig.base.json` commonly also sets `noUnusedLocals`, `noUnusedParameters`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`) — respect all that are enabled.
- `const`/`let`, never `var`. No `any`. `as` casts require an inline `// reason:` comment justifying them.
- Explicit return types on exported/public functions, including `Promise<T>` on every `async`.
- Named exports for shared code; `export default function` reserved for React components / Next pages.
- Import via path aliases (`@shared/*`, `@/*`), not deep relative chains, when aliases are configured.
- Errors are typed classes + a global filter; never `throw 'string'`. No `console.log` in committed code — use a `Logger`.
- Repository layer wraps the DB; services never issue queries directly.
- Config is validated once and read through a typed accessor, never raw `process.env` in feature code.

## Real-world variations you may encounter
- Multiple persistence stores: e.g. Prisma owning one DB while per-tenant/per-user SQLite files (`better-sqlite3`) use
  hand-rolled SQL migrations applied via `PRAGMA user_version` by a runner — no Prisma migrate for those. Detect the
  migration mechanism per store; don't assume one ORM owns everything.
- NestJS may run on the **Fastify** adapter instead of Express; guards may read both an HTTP-only cookie and a `Bearer` token.
- Jest and Vitest can coexist (Jest for an app's colocated `*.test.ts`; Vitest for a pure package's golden tests). A package
  may be wired for a runner yet have no committed tests — verify presence before assuming coverage.
- LLM code often wraps a vendor SDK (e.g. Anthropic's `@anthropic-ai/sdk`) behind a service that streams generation and
  validates JSON output against a zod schema; model choice may come from a config file rather than env.
- `lint`/`format`/`test` scripts are frequently stubs in some workspaces — confirm each does real work.

## Review rule seeds (copy stable IDs into INVENTORY Review Rule Set)
| ID | Rule | Severity | Auto-fixable |
| --- | --- | --- | --- |
| C1 | `any` used where a concrete type is known | M | no |
| C2 | `as` cast without an inline `// reason:` justification | M | no |
| C3 | Non-null assertion `!` on an unchecked value | M | no |
| C4 | Missing `await`/`void` on a floating Promise | H | no |
| C5 | Missing explicit return type on an exported/`async` function | L | yes |
| C6 | `console.log` in committed code instead of a `Logger` | L | yes |
| D1 | Service issues DB queries directly instead of via a repository | H | no |
| D2 | New entity/model without a matching migration (Prisma or hand-rolled) | H | no |
| E1 | `throw` of a non-Error (string/object) instead of a typed error class | M | yes |
| E2 | New domain error class not mapped in the global exception filter | M | no |
| S1 | Missing guard/auth on a state-changing route | H | no |
| S2 | Raw `process.env` read in feature code instead of the typed config accessor | M | no |
| T1 | New exported function/provider without a test | H | no |
