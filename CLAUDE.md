# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

- Bun/TypeScript CLI package that exposes GitHub Copilot through local OpenAI-compatible and Anthropic-compatible APIs.
- The proxy is reverse-engineered and depends on GitHub Copilot behavior, so API compatibility changes should be conservative and well-tested.
- Claude Code integration is a first-class path via `copilot-api start --claude-code`.
- The package publishes `dist/`; the CLI binary points to `./dist/main.js`.

## Commands

- Install dependencies: `bun install`
- Development server with watch mode: `bun run dev`
- Production-style local start: `bun run start`
- Build: `bun run build`
- Lint changed/default scope: `bun run lint`
- Lint the full repo: `bun run lint:all`
- Type check: `bun run typecheck`
- Run all tests: `bun test`
- Run a single test file: `bun test tests/anthropic-request.test.ts`
- Check unused files/dependencies: `bun run knip`

CI runs `bun run lint:all`, `bun run typecheck`, `bun test`, and `bun run build` after `bun install`.

## Proxy and model discovery

- Use `--proxy-env` to make upstream GitHub/Copilot requests honor proxy environment variables such as `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`.
- Local verified proxy example: `HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 bun run dev start --verbose --proxy-env --port 4141`.
- After startup, verify model discovery with `curl http://127.0.0.1:4141/v1/models`.
- Models observed from the local Copilot account on 2026-05-19:
  - `claude-opus-4.6-fast`
  - `claude-opus-4.6`
  - `claude-opus-4.7`
  - `claude-sonnet-4.6`
  - `gemini-3.1-pro-preview`
  - `gpt-5.2-codex`
  - `gpt-5.3-codex`
  - `gpt-5.4-mini`
  - `gpt-5.4`
  - `gpt-5.5`
  - `accounts/msft/routers/f185i3v4`
  - `accounts/msft/routers/fmfeto88`
  - `accounts/msft/routers/gdjv4v2v`
  - `gpt-5-mini`
  - `gpt-4o-mini-2024-07-18`
  - `gpt-4o-2024-11-20`
  - `gpt-4o-2024-08-06`
  - `text-embedding-3-small`
  - `text-embedding-3-small-inference`
  - `claude-sonnet-4.5`
  - `claude-opus-4.5`
  - `claude-haiku-4.5`
  - `gemini-3-flash-preview`
  - `gemini-2.5-pro`
  - `gpt-4.1-2025-04-14`
  - `gpt-5.2`
  - `gpt-41-copilot`
  - `gpt-3.5-turbo-0613`
  - `gpt-4`
  - `gpt-4-0613`
  - `gpt-4-0125-preview`
  - `gpt-4o-2024-05-13`
  - `gpt-4-o-preview`
  - `gpt-4.1`
  - `gpt-3.5-turbo`
  - `gpt-4o-mini`
  - `gpt-4o`
  - `text-embedding-ada-002`

## Architecture

- `src/main.ts` is the `citty` CLI root with `start`, `auth`, `check-usage`, and `debug` subcommands.
- `src/start.ts` owns runtime bootstrapping: proxy-from-env setup, GitHub/Copilot token setup, account type, rate limiting, manual approval, model/version caching, and Claude Code environment command generation.
- `src/server.ts` defines the Hono app. It mounts OpenAI-compatible routes at `/chat/completions`, `/models`, `/embeddings`, and their `/v1/*` variants; Anthropic-compatible routes at `/v1/messages`; and the utility route at `/usage`.
- `src/routes/messages/*` contains the Anthropic Messages compatibility layer, including request/response translation, streaming translation, non-streaming translation, and token counting.
- `src/routes/chat-completions/*`, `src/routes/models/*`, and `src/routes/embeddings/*` are the OpenAI-compatible adapters.
- `src/services/github/*` handles GitHub device auth, user lookup, Copilot usage lookup, and Copilot token retrieval.
- `src/services/copilot/*` performs upstream Copilot model, chat completion, and embedding calls.
- `src/lib/*` contains shared runtime state, upstream API config, token refresh, proxy setup, manual approval, rate limiting, shell env generation, and tokenization helpers.
- `pages/index.html` is a separate static usage dashboard deployed by GitHub Pages; it is not rendered by the Hono server.
- `Dockerfile` and `entrypoint.sh` run the built CLI from `dist/main.js`.

## Change guidance

- For API compatibility changes, inspect both the OpenAI and Anthropic route paths and update translation tests for the touched behavior.
- For streaming behavior, check both `src/routes/messages/stream-translation.ts` and `src/routes/messages/non-stream-translation.ts`.
- For auth, token refresh, rate limiting, or manual approval changes, review `src/start.ts`, `src/lib/state.ts`, the relevant `src/lib/*` helper, and `src/services/github/*` together.
- For CLI flag changes, keep `src/start.ts` and README command/options documentation aligned.
- Prefer extending the existing route/service/lib split instead of bypassing it from handlers.

## Testing and verification

- Run targeted tests first when changing translation behavior, for example `bun test tests/anthropic-response.test.ts`.
- Run the CI-equivalent local checks before considering a change complete:
  - `bun run lint:all`
  - `bun run typecheck`
  - `bun test`
  - `bun run build`
