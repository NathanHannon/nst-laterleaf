---
description: "Use when modifying GenAI providers, model constants, generation routing, or chat-generation behavior in nst-laterleaf. Enforces provider-neutral contracts, env var conventions, and usage/cost metadata handling."
name: "LaterLeaf GenAI Provider Rules"
applyTo: "src/genai/**/*.ts"
---
# LaterLeaf GenAI Provider Rules

- Keep `GenerationService` provider-neutral. Provider-specific SDK calls belong in `src/genai/providers/*.adapter.ts`.
- Preserve the shared contract in `GenerationProvider` (`generateText`, `generateChatReply`) when changing adapters.
- Keep model-tier semantics stable across providers:
  - `free` = lowest-cost default tier
  - `pro` = higher-quality paid tier
  - `podcast` = long-form/audio-script optimized tier
- Put model IDs in `src/genai/constants/ai-models.ts`; avoid hardcoding model names in service methods.
- For auth/config, prefer provider-specific env vars with fallback aliases (for example, provider key first, generic key second), and throw explicit "not configured" errors when missing.
- Return token usage fields when available from the provider response. Do not fabricate token values.
- Preserve first-turn vs follow-up chat behavior:
  - First turn sends full context prompt
  - Follow-up turns use prior interaction/session IDs when the provider supports them
- Keep embeddings provider behavior explicit. If embeddings remain Gemini-only, keep that dependency visible and intentional.
- When provider routing changes, keep accepted values backward-compatible (`gemini`, `openai`, `openai-compatible`) unless a migration is included.
- If model selection or provider routing logic changes, add or update tests under `src/genai/**/*.spec.ts` for:
  - provider selection
  - model tier mapping (`free`/`pro`/`podcast`)
  - first-turn and follow-up chat behavior
