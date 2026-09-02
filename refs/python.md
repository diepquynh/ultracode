# Stack Reference: python

Python service code. Frameworks vary: Django (+DRF), FastAPI, Flask, or a plain worker/CLI (no web
framework). Scraping stacks add a fetch layer: browser automation (`nodriver`/playwright/selenium) or an
HTTP client (`httpx`/`requests`/`aiohttp`) + a parser (`beautifulsoup4`+`lxml`). This reference tells the
scout which component types recur, how to find them, and which invariants to capture per type. The grounded
catalog below is an async FastAPI-or-Lambda scraper (`uv` + `injector` DI + `httpx` + BeautifulSoup +
pydantic), but keep the detection signals general.

## Detection signals
- `pyproject.toml` (`[project]`/`dependencies`), else `requirements.txt` / `setup.py` / `Pipfile`.
- Package manager by lockfile: `uv.lock` means uv, `poetry.lock` means poetry, `Pipfile.lock` means pipenv, else pip/venv.
  `.python-version` pins the interpreter.
- Web framework: `fastapi`+`APIRouter` means FastAPI; `manage.py`+`django` means Django; `flask` means Flask; none of
  these + a `[project.scripts]`/`main()` means a worker or CLI (may also be an AWS Lambda: `mangum` for HTTP, a
  bare `handler(event, context)` for direct invoke).
- Scraping: a browser driver (`nodriver`/`playwright`/`selenium`) vs an HTTP client + parser
  (`beautifulsoup4`+`lxml`/`selectolax`/`parsel`); an egress rotating-proxy service often wraps the client.
- Data + validation: `pydantic` v2 (`BaseModel`, `model_validator`, `TypeAdapter`) is near-universal;
  persistence may be SQLAlchemy/an ORM or none (stateless scraper). DI via `injector`/`dependency-injector`
  or plain constructors. Config via `pydantic-settings`, `omegaconf`, or hand-rolled env parsing.

## Slicing
- Django: one slice per app (a dir with `apps.py`/`models.py`).
- FastAPI/Flask/worker: one slice per top-level package under the source root (`<pkg>/common`, `<pkg>/<domain>`);
  each domain nests layers (`router.py`, `schema.py`, `scrape/`, `<feature>/`, `util/`). A shared
  `<pkg>/common/` holds cross-cutting infra (config, logging, HTTP, errors, the scraper SPI). The DI
  composition root (`<pkg>/di.py`) is the only module allowed to import from every other module.

## Conventional commands
Prefer the detected pm runner (`uv run …`, `poetry run …`) when a lockfile is present.
| Purpose | Typical (`uv` shown; swap runner per lockfile) |
| --- | --- |
| build | `python -m build` (libs) or `—` (services have no compile step) |
| run | `uv run <script>` / `uvicorn <pkg>.app:create_app --factory` / `python -m <pkg>.main`; runtime often chosen by an env var (`RUNTIME=api\|lambda`) |
| test | `uv run pytest -q` (else `python -m pytest` / `python manage.py test`) |
| test-one | `uv run pytest {PATH::TEST}` / `pytest -k {NAME}` |
| lint | `uv run ruff check .` (else `flake8`/`pylint`) |
| format | `uv run ruff format .` (else `black .`) |
| typecheck | `uv run mypy <pkg>` (else `pyright`), only if configured |

Usually no `Makefile`; commands are raw tools wrapped by the pm runner. Confirm each tool is declared in
`[dependency-groups]`/`[tool.*]` before writing it. Do not assume `mypy`/`ruff` exist. For a Lambda image the
container `CMD` is the handler path (`<pkg>.lambda_handler.handler`), not a shell command; local dev may drive
the AWS Runtime Interface Emulator via `docker compose`.

## Test framework
pytest (`testpaths`, fixtures, optional `conftest.py`). Async: `pytest-asyncio`. Check
`[tool.pytest.ini_options] asyncio_mode`; when `"auto"`, `async def test_*` needs no `@pytest.mark.asyncio`.
Test doubles come from stdlib `unittest.mock` (`AsyncMock` for async collaborators, `monkeypatch`), not a
third-party lib. HTTP tests: FastAPI/Starlette `TestClient` or `httpx` `ASGITransport`. Tests mirror the
package tree (`tests/<domain>/test_<module>.py`), often import module-private helpers (`_extract_*`, `_parse_*`)
directly to cover branch-heavy parsing, and may carry a docstring enumerating covered execution paths.
Commands: `uv run pytest -q`; one test `uv run pytest {PATH}::{TEST}`.

## Test component catalog

For each test type: **find** (grep, `--include='test_*.py'`), **capture** invariants from ONE real exemplar,
generate the named **skill** (Archetype D). Propose ONE shared convention skill `unit-test-common` (pytest +
`asyncio_mode="auto"`, `unittest.mock` doubles, Arrange-Act-Assert, the tree-mirroring layout, and the
"log-and-return-None on failure" contract scraper services follow). Every test skill applies it first.

### service / pure-function test: skill `unit-test-services`
- find: `test_*.py` importing `from unittest.mock import AsyncMock` (usually alongside the `Default*` class and its module-private helpers).
- capture: construct the `Default*` service directly with mocked collaborators (`AsyncMock` for async deps, `MagicMock(spec=RealType)` for typed doubles, `patch(...)` for module-level functions); small `_make_*` factory helpers build the SUT and canned responses; import and test module-private helpers (`_build_*`, `_extract_*`) directly; assert the return value AND the "returns `None` / logs on failure" contract; assert exception mapping with `pytest.raises(DomainException)`; `async def test_*` needs no marker under `asyncio_mode="auto"`.
- exemplar: `tests/<domain>/test_<service>.py`.

### FastAPI router test: skill `unit-test-fastapi-router`
- find: `test_*.py` importing `from fastapi.testclient import TestClient`.
- capture: a `@pytest.fixture` builds the app with service mocks and yields `(TestClient, *mocks)`. If the app wires dependencies through a `python-injector` container, a test `Module` subclass binds `AsyncMock`s via `binder.bind(Protocol, to=InstanceProvider(mock), scope=singleton)`, composed with the real app module and passed to the app factory; a plain FastAPI app instead uses `app.dependency_overrides[dep] = lambda: mock`. One test per documented execution path (the module docstring often enumerates them, e.g. `P1..P15`); call `client.post(path, json=/data=/files=)`; assert `response.status_code`, `response.json()` body + domain error `code`, and mock `assert_awaited_once()`/`assert_not_awaited()`; for a branch unreachable through HTTP (e.g. a `None` content-type), `await` the path-operation function directly with hand-built `AsyncMock` inputs.
- exemplar: `tests/<domain>/test_router.py`.

## Component catalog (find, then capture invariants)

For each type: **find** (grep, `--include='*.py'`) then **capture** the invariants. Verify the pattern returns
hits before relying on it. Example paths are genericized. Swap `<pkg>`/`<site>` for real neutral segments.

### router / endpoint
- find: `APIRouter(` + `@router.(post|get)(` (FastAPI) / `class .*View`/`ViewSet` (Django) / `@app.route` (Flask). ex: `<pkg>/<domain>/router.py`
- capture: module-level `router = APIRouter(prefix="/<domain>", tags=[...])`; verb decorators carry `response_model=<Model>`; `async def` handlers; DI collaborators injected as params via a container helper (`Injected(<Protocol>)`/`Depends(...)`) with `# noqa: B008` on the default-call; body typed as pydantic vs multipart `File(...)`/`Form(...)`; validation failures raise a domain exception (mapped to 4xx by a global handler), not an inline `HTTPException`.

### schema / DTO (pydantic)
- find: `class .*(BaseModel)` + `model_validator` / `Field(` / `TypeAdapter(`. ex: `<pkg>/<domain>/schema.py`
- capture: request+response models are `BaseModel`; optional fields `X | None = None`; cross-field rules via `@model_validator(mode="after")` returning `Self` raising `ValueError`; immutable value objects set `ConfigDict(frozen=True)`; wire control via `ConfigDict(alias_generator=..., populate_by_name=True, extra="forbid")` + `by_alias`/`exclude_none`; polymorphic payloads use a `type: Literal[...]` discriminated union parsed by a cached `TypeAdapter`.

### scraper client / spider (SPI + impl)
- find: `class .*(Protocol)` (contract) + `@singleton`/`@inject` `class Default.*`. ex: SPI `<pkg>/common/scrape/client.py`; impl `<pkg>/<domain>/scrape/<site>_scraper.py`
- capture: a `Protocol` declares the contract (a kind/source property + an `async` scrape method); each site impl satisfies it structurally, is decorated `@singleton @inject` with constructor DI of the fetch/proxy client; **conservative contract**: on any failure, parse mismatch, or empty body it logs and returns `None`, never raises; a bounded retry loop (`for attempt in range(1, MAX_ATTEMPTS+1)`) wraps the fetch; module-level `MAX_*`/selector/regex constants; query strings sometimes built by hand (not `urlencode`) to preserve param order/encoding.

### parser / extractor
- find: `BeautifulSoup(` / `.select_one(` / `.select(` / `re.compile(`. ex: private `_parse_*`/`_extract_*` in a `<site>_scraper.py`
- capture: module-level free functions (not methods): `BeautifulSoup(html, "lxml")`, CSS selectors, `re.Pattern` for embedded-JSON; every extractor is total (returns `None` on absent element / blank text / parse error); numbers use `Decimal` with explicit quantize/rounding; timestamps normalized to UTC (fixed-offset tz maps, not a DST lookup).

### HTTP / proxy client
- find: `httpx`(`AsyncClient`)/`requests`/`aiohttp`; a `class .*Proxy.*` or `fetch_*` method. ex: `<pkg>/common/scrape/proxy.py`, `<pkg>/common/http.py`
- capture: one shared async client injected (never per-call) and closed on shutdown (lifespan `await client.aclose()`); explicit connect/read `Timeout`; wraps an egress proxy (target URL percent-encoded + `api_key` appended); **secret hygiene**: the client's request logger is quieted so a key in a URL never hits the console; concurrent fan-out via `asyncio.gather`; expected transport errors caught narrowly, then a broad `except Exception` returns `None`.

### service / use-case (Protocol + Default impl)
- find: `class .*(Protocol)` + `class Default.*`. ex: `<pkg>/<domain>/<feature>/crawling.py`
- capture: interface/impl split (`Protocol` + `Default*`) with constructor DI into private `self._x` fields; `async` methods typed end to end; orchestrators fan out to a `list[<Protocol>]` and **never abort the batch on one failure** (per-item `try/except` logs and continues); source-to-result-field mapping uses `isinstance` narrowing so the type checker needs no `type: ignore`.

### model / value object
- find: `class .*(BaseModel)` in a `models.py`. ex: `<pkg>/common/scrape/models.py`
- capture: `BaseModel` + `ConfigDict(frozen=True)` for immutable results; money as `Decimal`, timestamps `datetime | None` (UTC-aware); updated via `model_copy(update={...})` not mutation; kept in `common/` so a shared `Protocol` can reference them without a boundary cycle.

### enum / typed constant
- find: `class .*(StrEnum)` / `Literal[`. ex: `<pkg>/common/scrape/client.py`, `<pkg>/common/config/settings.py`
- capture: `StrEnum` string-backed members (values chosen to round-trip on the wire / in logs); behavior hung off the enum via a `@property` (e.g. a per-member headers dict); result discriminators as `type: Literal["..."]` per union arm.

### config / settings
- find: `pydantic` config classes + a loader (`OmegaConf.load` / `os.environ`). ex: `<pkg>/common/config/settings.py`, `<pkg>/common/config/loader.py`
- capture: nested pydantic models rooted at a `Settings`, `extra="forbid"`, alias generator; loaded once (`@lru_cache`) by merging base YAML + `application-<profile>.yaml` (profile from env), resolving interpolations, then `Settings.model_validate(...)`; secrets from env (optionally hydrated from a secrets manager first); `@model_validator` enforces required-when-enabled groups. Feature code reads the typed `Settings`, never raw `os.environ`.

### DI composition root
- find: `injector` (`Module`, `Binder`, `@provider`, `@singleton`, `Injector([...])`) / a `build_*` factory. ex: `<pkg>/di.py`
- capture: one `Module.configure(binder)` + `build_injector()` called once at startup (shared across warm Lambda invocations and the lifespan); concrete-only deps via `@singleton @provider` (return-type = binding key); **optional** deps (`X | None`) built eagerly and bound via `InstanceProvider` (a `@provider` param typed `X | None` can be mis-resolved); a `list[<Protocol>]` assembled by hand in a provider. The root imports every module; nothing imports it.

### task / worker / lambda handler
- find: `def handler(event, context)` / `Mangum(` / Celery `@shared_task`/`@app.task`. ex: `<pkg>/lambda_handler.py`
- capture: HTTP events go to an ASGI adapter (`Mangum`); direct-invoke events are dispatched by an `event["action"]` switch to thin `_handle_*` functions; a correlation ID stamped per invocation; a **persistent module-level event loop** reused across warm invocations (pooled async clients survive), never `asyncio.run()` per call; handlers resolve collaborators from the shared injector and coerce loose event fields defensively (`str(...)`, `isinstance` guards, `None` fallbacks); side-effect failures log-and-continue.

### error handling
- find: `class .*Exception` / `add_exception_handler(` (FastAPI) / `@app.errorhandler` (Flask). ex: `<pkg>/common/errors.py`, `<pkg>/common/error_handlers.py`
- capture: a base `BusinessException(Exception)` carrying `status_code`/`error_code`/message; a pydantic error-response model (stable `code`/`message`/`status` keys); async handlers registered on the app (business errors to 4xx, catch-all to 500) as the global-advice analog; feature code raises the domain exception, never writes status inline.

### logging
- find: a `LogUtils`-style wrapper / `logging.getLogger(` / a `logging.Filter`. ex: `<pkg>/common/logging.py`
- capture: a thin static wrapper over `logging` with a fixed `"Class::method: msg"` convention and `{}` substitution; a `logging.Filter` injects a `correlation_id`; a JSON formatter emits UTC ISO-8601; noisy third-party loggers raised to WARNING to suppress secret-bearing lines.

## Conventions to look for (seed the convention skill only if consistently observed)
- `from __future__ import annotations` atop every module; full type hints on public (and most private)
  functions, enforced by strict mypy (`disallow_untyped_defs`, `warn_unused_ignores`, pydantic plugin).
- Modern syntax (`ruff` `UP`): `X | None` (not `Optional`), `StrEnum`, PEP 695 generics (`def f[T](...)`),
  builtin `dict`/`list`. Lint set commonly `E,F,I,UP,B,C4,SIM,RUF`.
- Explicit imports (no `import *`); an `__all__` on most modules; private helpers prefixed `_`.
- pydantic for all boundary data; `Decimal` for money; UTC-aware datetimes; immutable results (`frozen=True`)
  mutated via `model_copy`.
- Interface/impl as `Protocol` + `Default*`; constructor DI into `self._x`; the container owns all singletons.
- Config validated once and read through a typed `Settings`, never raw `os.environ` in feature code.
- Conservative SPI: total functions that log-and-return-`None`; a narrow expected catch then a broad
  `except Exception` at the I/O boundary; bounded retries; one broad catch never wraps pure logic.

## Real-world variations you may encounter
- **Dual runtime**: one package may boot as a long-running ASGI server and as an AWS Lambda (HTTP via an
  ASGI adapter plus a direct-invoke `action` dispatcher). A single shared DI container and a persistent event
  loop are built at module load and reused across warm invocations. Do not infer a per-request lifecycle.
- **DI-container quirks**: some containers strip `| None` from a union when resolving a `@provider` param,
  silently injecting the non-`None` arm. The fix is eager build + an `InstanceProvider` binding. Expect
  `# type: ignore[...]` on those bindings and on `container.get(<Protocol>)`.
- **Optional heavy deps**: a vendor SDK or credentialed feature may build eagerly and fall back to `None`
  ("disabled") when credentials are absent, so the same build runs locally without them; the endpoint returns
  503. Detect the disabled path before assuming a hard dependency.
- **Scraping is brittle by nature**: selectors, regex on embedded JSON, tz-abbreviation offset maps, and
  manual URL encoding to match a byte-exact upstream format are normal. Bounded retries + total parsers +
  return-`None` are the contract, not a smell. An egress proxy usually carries the secret in the URL.
- **No persistence layer**: a pure scraper may have no DB/ORM. Every model is a pydantic value object.
  Do not expect a repository or migrations; "new model without a migration" rules do not apply.
- Some services thread no explicit context object and rely on a `contextvars` correlation ID instead. Mocking
  uses stdlib `unittest.mock` (`AsyncMock`), not a third-party lib.

## Review rule seeds (copy stable IDs into INVENTORY Review Rule Set)
| ID | Rule | Severity | Auto-fixable |
| --- | --- | --- | --- |
| C1 | Missing type hint on a public function (strict mypy repo) | M | no |
| C2 | Mutable default argument (`def f(x=[])`) | H | yes |
| C3 | Bare `except:` / over-broad catch swallowing a logic bug (not an I/O boundary) | M | no |
| C4 | `Optional[X]`/`List[...]` instead of `X | None` / `list[...]` | L | yes |
| C5 | Raw `os.environ` read in feature code instead of the typed `Settings` | M | no |
| C6 | `print()`/ad-hoc logging instead of the project logging wrapper | L | yes |
| D1 | New service/scraper not bound in the DI composition root | H | no |
| D2 | Async client constructed per-call instead of injecting the shared one | M | yes |
| P1 | Parser/extractor raises instead of returning `None` on bad input | H | no |
| P2 | Secret (api key in a URL) reachable by a request logger left at INFO | H | yes |
| V1 | Boundary data not modeled with pydantic (missing validation) | M | no |
| S1 | Missing permission/auth on a state-changing endpoint | H | no |
| T1 | New public function/endpoint without a test | H | no |
