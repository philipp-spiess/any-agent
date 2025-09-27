# Repository Guidelines

## Project Structure & Module Organization
- `src/index.tsx` starts the Ink CLI, wires the session picker, and exposes `getSessions` for other tools.
- `src/codex.ts` aggregates Codex session metadata and pricing; keep filesystem and pricing helpers here.
- `src/pricing.ts` wraps LiteLLM pricing lookups; extend it before touching `codex.ts`.
- `src/ui/SessionPicker.tsx` contains all interactive UI components; new UI belongs under `src/ui/`.
- Vitest specs live in `tests/` (see `tests/index.test.ts` for realistic fixtures). Build output is emitted to `dist/` by `tsdown` and should stay ignored.

## Build, Test, and Development Commands
- `npm install` – install dependencies with the versions locked in `pnpm-lock.yaml`/`bun.lock`.
- `npm run dev` – rebuild on changes using `tsdown --watch`; use while developing CLI interactions.
- `npm run build` – generate the ESM bundle in `dist/`; run before publishing.
- `npm run test` – execute the Vitest suite; CI should mirror this command.
- `npm run typecheck` – run `tsc --noEmit` to catch TS regressions early.
- `npm run release` – bump the version via `bumpp` and publish to npm; only run on a clean main branch.

## Coding Style & Naming Conventions
- Prefer 2-space indentation, single quotes, and omit semicolons, matching existing sources.
- Use PascalCase for React components (`SessionPicker`) and camelCase for helpers (`computeForkSignature`).
- Co-locate domain logic in `src/` root modules and UI-only code in `src/ui/`.
- Keep modules ESM-only; avoid CommonJS patterns or `require`.

## Testing Guidelines
- Write Vitest files as `<feature>.test.ts` in `tests/`; mirror realistic session JSON as in the existing fixture.
- Stub pricing via `LiteLLMPricingFetcher({ offline: true })` to keep tests deterministic.
- New CLI behaviours should assert console output and token accounting, not just data shapes.
- Aim for coverage of error paths (missing directories, malformed rollout files) before merging.

## Commit & Pull Request Guidelines
- Use imperative, present-tense summaries under 72 characters (e.g., `Add session fork detection`); reference issues with `#123` when applicable.
- Run `npm run test` and `npm run typecheck` locally before pushing; include failures and fixes in separate commits when possible.
- PRs must describe the user-facing impact, outline test coverage, and attach CLI screenshots or terminal transcripts for UI tweaks.

## Agent-Specific Notes
- The CLI reads sessions from `$CODEX_HOME/sessions`; set `CODEX_HOME` in your shell or use the temporary directory strategy from `tests/index.test.ts` when experimenting.
- When adding pricing logic, prefer enriching `LiteLLMPricingFetcher` rather than hard-coding costs in session parsing.
