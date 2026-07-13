# Stack Reference — go

Go HTTP service, single module, `cmd`-less (root `main.go`) with `internal/<domain>/<layer>` layout and
`go.uber.org/dig` for dependency injection. This reference tells the scout which component types recur,
how to find them, and which invariants to capture per type. Modeled on a common gofiber/gorm service layout.

## Detection signals
- `go.mod` at root (module path) + dominant `.go` extension. `go.work` → multi-module workspace.
- Router by import: `github.com/gofiber/fiber/v3` (one common choice), else `chi`/`gin`/`echo`/`net/http`.
- Data layer by import: `gorm.io/gorm` + a driver (`gorm.io/driver/postgres`); else `database/sql`, `sqlx`, `pgx`, `sqlc`.
- DI container: `go.uber.org/dig` (`dig.In`/`dig.Out` param/result structs). Config: `github.com/spf13/viper`.

## Slicing
- `go.work` workspace or `cmd/*` layout: one slice per top-level `internal/<domain>` or per `cmd/*`.
- Common layout: one slice per top-level package under `internal/` — e.g. `common`, `user`, `order`, `notification`.
  Each domain nests layers: `controller/`, `service/{,factory,impl}`, `repository/`, `entity/`, `dto/`, `constant/`, `command/`, `scheduler/`.

## Conventional commands
| Purpose | Command |
| --- | --- |
| build | `go build ./...` (image build often `go build -tags timetzdata -o main main.go`) |
| test | `go test ./...` |
| test-one | `go test ./{PKG} -run {TEST}` |
| format | `gofmt -w .` (or `goimports -w .`) |
| lint | `golangci-lint run` if configured, else `go vet ./...` |
| typecheck | `go build ./...` (compiler is the type checker) |
| run | `go run main.go` (typically needs `ENVIRONMENT`, a reachable DB/cache, and `configs/config*.yaml` in cwd) |
| migrate | goose: `./goose.sh up` / `down` / `create <name> sql`, or `goose <driver> <dsn> up`; else golang-migrate |
| swagger | `swag init` (swaggo; annotations in `main.go` + controller godoc) — only if the repo uses swaggo |

When there is no `Makefile`, commands are raw `go`/`goose`. A `goose.sh` wrapper usually exports `GOOSE_*` env and needs the `goose` binary on PATH.

## Test framework
Standard `testing` package (`func TestXxx(t *testing.T)`), table-driven tests; `testify` if present.
If a repo has no `*_test.go` files and only an indirect `testify` dependency, treat "new exported function
without a test" (T1) as a real gap to fill, not an existing convention to mirror.

## Component catalog (find → capture invariants)

For each type: **find** (grep, `--include='*.go'`) then **capture** the listed invariants. Verify the grep returns hits.

### handler / controller
- find: `func .*ctx fiber.Ctx) error` or `func Register.*Controller(` — e.g. `internal/order/controller/order.go`.
- capture: struct holds the service interface, `New<X>Controller(...)` constructor + top-level `Register<X>Controller(app *fiber.App, ...)`
  wired via `Invoke(container, ...)` in `main.go`; routes bound `app.Get/Put(path, controller.Method)`; user pulled from context
  `ctx.Locals(userConstant.UserContextKey).(*securityModel.UserDetails)`; request via generic `dtoParser.Parse{Body,Query,MultipartForm}AndValidate[T]`;
  response `ctx.JSON(commonDto.Ok(...))` / `commonDto.OkNoData()`; handlers `return err` (no manual status — a global error handler maps it);
  swaggo `godoc` annotation block (`@Summary`/`@Router`) above each method.

### service (interface + factory + impl)
- find: interface `type .*Service interface` (`internal/order/service/order_jobs.go`); impl `internal/order/service/impl/default_*.go`;
  wiring `Configure*Service` (`internal/order/service/factory/*.go`).
- capture: three-file split — bare interface in `service/`, `Default*` struct in `service/impl/` with a `New*` constructor,
  and a `factory/` `Configure*Service(params XParams) service.XService` that takes a `dig.In` param struct and returns the interface.
  Methods take domain args + `*dto.XRequestDto` and return `(*dto.YDto, error)`. (Some services thread no `context.Context` — see variations.)

### repository / store
- find: `type .*Repository interface` / `func Configure.*Repository(` — e.g. `internal/order/repository/order_job.go`.
- capture: interface + `Default*Repository` struct holding two `*gorm.DB` (`readWriteDB`, `readOnlyDB`); `Configure*Repository` takes a
  `dig.In` struct with `ReadWriteDB *gorm.DB \`name:"read-write"\`` / `ReadOnlyDB ... \`name:"read-only"\``; every method takes `tx *gorm.DB` first
  and self-opens (`readOnlyDB.Begin()`) + `defer` rollback/commit when `tx == nil`; named-return `err` so the deferred closure can rewrite it;
  `errors.Is(err, gorm.ErrRecordNotFound)` → `return nil, nil`; struct-based `Where(&entity.X{...})`; `Clauses(clause.Locking{Strength:"UPDATE"})` for row locks;
  `*ForDetails` uses `Preload(...)`. Ad-hoc projections are plain structs with `gorm:"column:..."` tags under `repository/query/`.

### entity / model
- find: `struct {` with `gorm:"column:` tags — e.g. `internal/order/entity/order.go`; base `internal/common/entity/`.
- capture: embeds `entity.BaseEntity` (`CreatedTime`/`UpdatedTime` with `autoCreateTime:nano`/`autoUpdateTime:nano`); nullable fields are pointers
  (`*int64`, `*string`, enum pointers) with `gorm:"column:...;not null"`; table names are `const XTableName = "..."`; optional
  `func (X) TableName(namer schema.Namer) string`; relations via `gorm:"foreignKey:..."`; JSONB via `datatypes.JSONType[T]` + `gorm:"type:jsonb"`;
  singular table names + schema prefix set globally in the gorm `NamingStrategy`.

### enum / typed constant (custom SQL type)
- find: `type .* string` + `func (.*) Scan(value any) error` / `func (.*) Value() (driver.Value, error)` — e.g. `internal/order/constant/order.go`.
- capture: string-backed named type with a triplet of `const` per value (`XEnum` typed / `X` int / `XString`); `Scan` maps stored `int64`→string,
  `Value` maps string→int (DB stores SMALLINT, Go holds the string); unknown value → wrapped error. New enum member = add all three consts + both switch arms.

### dto / request-response
- find: `Dto struct` with `json:`/`query:`/`validate:` tags — e.g. `internal/order/dto/order.go`; envelope `internal/common/dto/`.
- capture: plain structs (not records); request DTOs carry `validate:"required,min=1,oneof=..."` (go-playground/validator/v10) and `query:`/`form:` tags;
  response DTOs use non-pointer fields + `json:"...,omitempty"`; every response wrapped in a generic `commonDto.BaseApiResponse[T]` via `Ok[T]`/`OkNoData`.

### middleware / security
- find: `app.Use(` / `func Configure.*(params .*Params)` in `security/` — e.g. `internal/user/security/*.go`.
- capture: fiber middleware registered in `main.go` via `Invoke` (sequence: `requestid` → `recover` → CORS → JWT); JWT via a fiber JWT contrib
  with a `Filter` that returns `true` only for whitelisted `path+method` (a map `EndpointsWhitelist`) — i.e. auth is default-on, opt-out per route;
  `SuccessHandler` checks a JWT blacklist in the cache, loads the user, and stores it with `c.Locals(UserContextKey, user)`.

### mq / command consumer + producer
- find: `func .*Consume(message commonCommand.MessageObject) error` / `Configure.*CommandConsumer` / `producer.Send(` — e.g. `internal/order/command/order/consumer/consumer.go`, infra `internal/common/command/`.
- capture: a Redis-Streams-style bus (`Xadd`/`Xreadgroup`); `Producer.Send(streamName, cmd any)` JSON-marshals to a `payload` field;
  consumer registered via `Invoke` + `commonCommand.ConfigureNewCommandConsumer(...)` which spawns goroutines: `Listen`, `Redrive` (visibility-timeout retry), `Consume`;
  dispatch = unmarshal a `TypingObject{Type}` then `switch` on `Type` to the concrete command struct; each handler opens its own `readWriteDB.Begin()` tx with a `defer` commit/rollback;
  non-critical side effects (email) log-and-continue instead of failing the tx.

### scheduler / worker
- find: `time.NewTicker(` / `go .*start()` / a distributed locker — e.g. `internal/order/scheduler/order.go`.
- capture: a `Scheduler` struct started with `go scheduler.start()` from its `New*` constructor; a `time.Ticker` loop guarded by `signal.NotifyContext` for graceful shutdown;
  delayed work stored in a cache ZSet (score=deadline millis, drained by range query); cross-instance mutual exclusion via a distributed lock `TryWithContext(...)` + `defer release()`;
  batch limited, processed in one gorm tx, then removed from the ZSet.

### config / properties
- find: `mapstructure:"..."` structs / `viper.` — e.g. `internal/common/config/config.go` (+ `database.go`, `redis.go`, ...).
- capture: nested `mapstructure`-tagged structs rooted at an `AppConfig{App AppConfigRoot, Server ServerConfig}`; loaded by a `NewAppConfig()` which picks
  `config-<ENVIRONMENT>.yaml` (falls back to `config.yaml`) from cwd and auto-binds every key to an UPPER_SNAKE env var; yaml lives in `configs/`;
  read/write DB split provided to dig as a `dig.Out` `RoutingDatabaseClient` with `name:"read-only"`/`name:"read-write"` gorm handles.

### error handling
- find: `func .*Error() string` / `GlobalErrorHandler` — e.g. `internal/common/error/{error,handler,const}.go`.
- capture: sentinel error **structs** (one per case, e.g. `OrderJobNotFoundError`, `InvalidRequestParamError`) each implementing `Error()`; string code+message consts in `const.go`;
  a central `GlobalErrorHandler(ctx, err) error` `switch err.(type)` maps each to an HTTP status + `BaseApiResponse[any]{Status,Code,Message}`; registered on `fiber.New(fiber.Config{ErrorHandler: ...})`.
  Handlers/services just `return err`. Inline wrapping with `fmt.Errorf("...: %w", err)` appears in cross-layer helpers but may not be applied uniformly.

## Conventions to look for (seed the convention skill only if consistently observed)
- `gofmt`/tab-indented, grouped imports with per-package aliases (`commonDto`, `orderService`, ...); no fully-qualified inline package refs.
- Nullable model fields as pointers + `gorm:"...;not null"`; enums as string types with `Scan`/`Value`; JSONB via `datatypes.JSONType[T]`.
- DI everywhere: `Configure*`/`New*` constructors taking a `dig.In` param struct; wiring centralized in `main.go` (`Provide` vs `Invoke`).
- Transaction discipline: `tx *gorm.DB` first arg, named-return `err`, `defer` commit/rollback, self-open when `tx == nil`.
- Timestamps normalized to UTC (gorm `NowFunc` + `time.Now().UTC()`); a business timezone loaded explicitly via `time.LoadLocation(...)` where wall-clock deadlines matter.
- Error returns explicit; propagate (`return err`) up to a global handler rather than writing status in handlers.

## Real-world variations you may encounter (not universal Go rules)
- **No `context.Context` propagation**: some services omit `ctx` from signatures and use `context.Background()` at infra calls. Do not infer a ctx
  convention from such a service — still flag missing `ctx` on new I/O as a smell (C2).
- **No linter config and no tests**: lint may be only `go vet` and `testify` only an indirect dep. `golangci-lint run` is aspirational until a config is added.
- Infra choices vary widely: a Postgres-compatible DB (e.g. CockroachDB) behind the Postgres driver, a Redis-compatible cache/cluster, KMS-signed JWT, S3-compatible storage.
- Auth may be default-deny with an explicit allow-list (`EndpointsWhitelist`), the inverse of per-route opt-in guards.
- Migrations are often **goose** (`-- +goose Up/Down`, `StatementBegin/End`), timestamp-prefixed under `migrations/`, with no auto-migrate on boot.

## Review rule seeds (copy stable IDs into INVENTORY Review Rule Set)
| ID | Rule | Severity | Auto-fixable |
| --- | --- | --- | --- |
| C1 | Error ignored (`_ =` or unchecked) | H | no |
| C2 | Missing `context.Context` on new I/O function | M | no |
| C3 | Error not wrapped with `%w` when adding context | L | no |
| C4 | Fully-qualified/unaliased import used inline | L | yes |
| G1 | New gorm entity/column without a matching goose migration | H | no |
| G2 | Repo method missing `tx == nil` self-open or `defer` commit/rollback | H | no |
| G3 | Write path not run inside a gorm transaction | H | no |
| G4 | New enum value missing a `const` triple or `Scan`/`Value` switch arm | M | no |
| D1 | New component not wired into `main.go` `Provide`/`Invoke` | H | no |
| S1 | State-changing route not covered by the auth whitelist / left default-open | H | no |
| T1 | New exported function without a test | H | no |
