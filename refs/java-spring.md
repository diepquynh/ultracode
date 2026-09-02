# Stack Reference: java-spring

Java + Spring Boot, Maven or Gradle, typically a multi-module monorepo. This reference tells the scout which
component types recur, how to find them, and which invariants to capture per type.

## Detection signals
- `pom.xml` (Maven) or `build.gradle`/`build.gradle.kts` (Gradle) at root and/or per module.
- Dependency on `spring-boot-starter-*`; a class annotated `@SpringBootApplication`.
- Dominant extension `.java`. Wrapper scripts `mvnw`/`gradlew`.

## Slicing
- Multi-module: one slice per module directory (a dir containing its own `pom.xml`/`build.gradle`).
- Single module: slice by top-level package under `src/main/java/**` (usually one per domain).

## Conventional commands
| Purpose | Maven (wrapper) | Gradle (wrapper) |
| --- | --- | --- |
| build | `./mvnw -q -T1C compile` | `./gradlew classes` |
| test | `./mvnw test` | `./gradlew test` |
| test-one | `./mvnw test -pl {MODULE} -am -Dtest={TEST} -Dsurefire.failIfNoSpecifiedTests=false` | `./gradlew :{MODULE}:test --tests {TEST}` |
| format | `./mvnw spotless:apply` (if spotless present) | `./gradlew spotlessApply` |
| lint | checkstyle/PMD if configured, else null | same |
| run | `./mvnw spring-boot:run -pl {MODULE}` | `./gradlew :{MODULE}:bootRun` |

Detect the wrapper actually present (`mvnw` vs `gradlew`) and whether `spotless` is configured before writing
commands.

## Test framework
JUnit 5 + Mockito. Location: mirror the SUT package under `{module}/src/test/java/**`, class named `{Sut}Test`.
Test doubles: `@Mock`/`@InjectMocks` + `ArgumentCaptor` (pure unit); `@MockitoBean` (the Spring Boot 3.4+/4
replacement for `@MockBean`) in context tests. Slice/context per test type: `@ExtendWith(MockitoExtension.class)`
(service unit), `@DataJpaTest` (repository), `@SpringBootTest(webEnvironment = MOCK)` + `MockMvc` (controller),
`@SpringBootTest(webEnvironment = NONE)` (integration `contextLoads`). Commands: `./mvnw test`; one test
`./mvnw test -pl {MODULE} -am -Dtest={TEST} -Dsurefire.failIfNoSpecifiedTests=false`.

**Capture import packages from the real test. Do not assume.** A Spring Boot 4 / modularized codebase uses
`org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest` and
`org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase` (not the Boot 3
`org.springframework.boot.test.autoconfigure.*` paths). If a module has no `*Test.java`, treat T1 ("new public
method without a unit test") as a gap to fill from this convention, not an existing pattern to mirror.

## Test component catalog

For each test type: **find** (grep, `--include='*.java'`), **capture** invariants from ONE real exemplar,
generate the named **skill** (Archetype D). Propose ONE shared convention skill `unit-test-common` (JUnit 5 +
`@DisplayName` behavior naming, one behavior per `@Test`, static imports, Arrange-Act-Assert / Given-When-Then,
mock collaborators, no Spring context in a unit test). Every test skill below applies it first.

### service unit test: skill `unit-test-services`
- find: `*ServiceTest.java` annotated `@ExtendWith(MockitoExtension.class)` (the test for a `Default*Service`).
- capture: collaborators as `@Mock`, SUT as `@InjectMocks`; `@BeforeEach` stubs shared mocks; fixed time via a
  `private static final ZonedDateTime` constant; one `@Test @DisplayName("Should …")` per path (null arg, empty
  arg, no-op branch, happy path); `when(...).thenReturn(...)` stubs; `verify(..., times/never)`,
  `verifyNoInteractions`, `verifyNoMoreInteractions`; `ArgumentCaptor` + `argThat(...)` for complex-argument
  assertions; assert return value and captured event/args.
- exemplar: `order-rest/src/test/java/com/example/backend/order/service/impl/DefaultOrderServiceTest.java`.

### repository test: skill `unit-test-repository`
- find: `*RepositoryTest.java` that `extends BaseRepositoryTest`.
- capture: per-module abstract `BaseRepositoryTest` carrying `@DataJpaTest` + `@AutoConfigureTestDatabase(replace = NONE)`
  + `@ActiveProfiles("test")` + `@Import(TestDatasourceConfig.class)`. The `replace = NONE` keeps the real
  datasource (this suite runs on real PostgreSQL, not an embedded DB; confirm from the module's
  `application-test.yaml`). Concrete test `@Autowired`s the repository + FK-parent repositories +
  `@PersistenceContext EntityManager`; seeds via entity builders setting EVERY `NOT NULL` column (check the
  Flyway migration under `src/main/resources/db/migration`); `entityManager.flush()` then `clear()` before the
  query under test; tests only `@Query`/derived/paginated methods (never inherited CRUD); `@AfterEach` deletes
  in reverse FK order.
- exemplar: `order-rest/src/test/java/com/example/backend/order/repository/OrderRepositoryTest.java` + sibling `BaseRepositoryTest.java`.

### controller test: skill `unit-test-rest-controller`
- find: `*ControllerTest.java` importing `org.springframework.test.web.servlet.MockMvc`.
- capture: `@ActiveProfiles("test")` + `@SpringBootTest(classes = {Module}Application.class, webEnvironment = MOCK)`;
  every service dependency `@MockitoBean`; `MockMvc` built in `@BeforeEach` via `MockMvcBuilders.webAppContextSetup(webApplicationContext)`;
  auth wired manually (`SecurityContextHolder` + `UsernamePasswordAuthenticationToken`, mocked `TokenService`/`AuthUserService`,
  an `AppUserDetails` principal, and an `AUTHORIZATION` header constant); requests via `mockMvc.perform(get/put(path).header(...).contentType(MediaType.APPLICATION_JSON).content(json))`,
  assertions via `.andExpect(status()...)` + `jsonPath(...)`; stub services with `when(...).thenReturn(...)`; `@AfterEach` resets mocks.
- exemplar: `order-rest/src/test/java/com/example/backend/order/controller/OrderControllerTest.java`.

### integration boot test: reference only (fold into `unit-test-common`, not a separate skill)
- find: `*IntegrationSpringBootTest.java`.
- capture: one per module; a single `contextLoads()` `@Test`; `@SpringBootTest(classes = {Module}Application.class, webEnvironment = NONE)`.
  Use it in `unit-test-common` to draw the unit/integration boundary (unit tests mock collaborators; this boots the whole context).
- exemplar: `order-rest/src/test/java/com/example/backend/OrderIntegrationSpringBootTest.java`.

## Component catalog

For each type: **find** (grep pattern, `--include='*.java'`) then **capture** the listed invariants.

### entity
- find: `@Entity` / `@Table(`
- invariants: base class (e.g. `extends BaseEntity`); `@Id` + `@GeneratedValue` strategy; `@Table` name quoting for reserved words; relationship fetch type (`FetchType.LAZY`); JSONB/`@Type` columns; **reflection registration** in a `*NativeImageHintConfig` (GraalVM) if native; a **Flyway migration** file under `src/main/resources/db/migration` + version bump.

### dto
- find: `record .*Dto` / `class .*Dto` / `@Schema`
- invariants: record vs class; validation annotations (`@NotNull`, `@Size`); Swagger `@Schema`; pagination response wrapper; inheritance/parameter-object variants.

### repository
- find: `extends JpaRepository` / `extends .*Repository` / `@Repository`
- invariants: base repository interface; query-model return types; `@Query`/native query usage; keyset/cursor pagination patterns; projection interfaces.

### service (interface + impl)
- find: interface `.*Service` + `class Default.*Service` / `@Service`
- invariants: interface/impl split; `@Transactional` placement; constructor injection with `final` fields; logging util usage; distributed-lock usage on critical paths.

### rest controller (class + method)
- find: `@RestController` / `@RequestMapping` / `@GetMapping|@PostMapping|@PutMapping|@DeleteMapping`
- invariants: base path; auth annotations (`@PreAuthorize`, security context); request/response DTO types; `ResponseEntity` vs body; exception advice.

### domain event / command
- find: `implements .*Event` / `.*Command` / `publishEvent(` / visitor registrations
- invariants: event/command base type; registration in a central enum/visitor; serialization/reflection registration.

### mq / message handler
- find: `@RabbitListener` / `RedisStream` / `CommandHandler` / `CommandListener`
- invariants: listener/handler split; idempotency; redrive/retry scheduler; command deserialization.

### scheduler
- find: `@Scheduled` / `ShedLock` / `@SchedulerLock`
- invariants: cron/fixedDelay; ShedLock names; virtual-thread executor; ZSet-based delayed execution.

### properties / config
- find: `@ConfigurationProperties` / `@Value` / `application*.yaml`
- invariants: prefix; per-profile yaml (dev/uat/prod); env-var binding.

### exception / advice
- find: `extends .*Exception` / `@RestControllerAdvice` / `@ExceptionHandler`
- invariants: error-code enum; advice mapping to HTTP status; problem-detail body.

## Conventions to look for (seed the convention skill only if consistently observed)
- `final` on locals/fields/params where possible (not interfaces).
- Explicit `this.` for member access.
- No `var`; explicit types.
- No fully-qualified names inline; use imports.
- Single timestamp per method: one `final ZonedDateTime now = ZonedDateTime.now(ZoneOffset.UTC)` reused.
- Constructor injection over field injection.

## Review rule seeds (copy stable IDs into INVENTORY Review Rule Set)
| ID | Rule | Severity | Auto-fixable |
| --- | --- | --- | --- |
| C1 | Missing `final` where value never reassigned | M | yes |
| C2 | Uses `var` instead of explicit type | M | yes |
| C3 | Missing `this.` on member access | L | yes |
| C4 | Fully-qualified name inline instead of import | L | yes |
| C5 | Multiple `now()` calls in one method | M | yes |
| K1 | New JSONB/custom type not registered for reflection | H | yes |
| K2 | New entity without Flyway migration + version bump | H | no |
| L1 | Missing/incorrect `@Transactional` on write path | H | no |
| S1 | Missing auth annotation on a state-changing endpoint | H | no |
| T1 | New public method without a unit test | H | no |
| T8 | Execution path from analysis not covered by a test | M | no |
