# Copilot instructions for LaterLeaf Nest backend

These instructions apply to the NestJS backend in this repository, especially files under src/ and related tests.

## Architecture and code structure
- Keep controllers thin and move business logic into services.
- Prefer dependency injection and existing module wiring over creating new ad-hoc instances.
- Follow the existing Nest pattern of features organized under src/<feature>/ with controller, service, DTOs, entities, and module files.
- Preserve the current naming conventions: classes such as XController, XService, XModule, and DTOs under dto/.
- Prefer minimal, focused changes that fit the existing structure rather than introducing new abstractions unless they are clearly justified.

## Backend conventions
- Use TypeScript with explicit types and avoid unnecessary any usage.
- Follow the existing style in this codebase: 4-space indentation, single quotes, semicolons, and straightforward class-based implementations.
- Keep authentication and authorization patterns consistent with the existing Clerk-based setup. Use ClerkAuthGuard and CurrentUser where appropriate.
- When working with user-scoped routes, resolve the internal user via the users service and the Clerk user id rather than assuming direct access.
- For persistence, use the existing TypeORM + service abstraction pattern. When a feature needs PostgreSQL-specific behavior such as pgvector, keep the SQL explicit and document the reason in comments when the logic is non-obvious.

## Service and module guidance
- Add or update modules when introducing a new dependency or feature; do not rely on hidden side effects.
- If a change touches shared infrastructure, review the related modules and downstream consumers before editing.
- Keep cross-cutting concerns such as queues, storage, moderation, content extraction, and AI providers inside their existing service/module boundaries.

## Testing and validation
- Add or update Jest specs alongside behavior changes when practical.
- Prefer small, targeted tests that reflect real behavior and the existing Nest test structure.
- Before claiming a change is complete, verify it with the relevant test or build command when possible.

## Change management
- Preserve existing public behavior unless the task explicitly requires a breaking change.
- If the request is ambiguous or would affect multiple subsystems, ask for clarification rather than making assumptions.
- When in doubt, prefer the simplest change that satisfies the request and fits the current architecture.
