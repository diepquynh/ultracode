# Stack Reference — java-spring

Java + Spring Boot, Maven or Gradle, typically a multi-module monorepo. This reference tells the scout
which component types recur, how to find them, and which invariants to capture per type.

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

Detect the wrapper actually present (`mvnw` vs `gradlew`) and whether `spotless` is configured before writing commands.

## Test framework
JUnit 5 + Mockito. Common patterns: `@ExtendWith(MockitoExtension.class)` + `@Mock`/`@InjectMocks` for services;
`@SpringBootTest` + `MockMvc` for controllers; `@DataJpaTest` (or a full-context boot test) for repositories.

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
- invariants: listener→handler split; idempotency; redrive/retry scheduler; command deserialization.

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
