# Contributing to Uchiyomi

Thanks for your interest. Bug reports, feature ideas, and pull requests are all welcome.

## Project layout
- `bff/`: the Fastify + TypeScript API (auth, library scanner, image server, sources, scheduled updater).
- `web/`: the Next.js PWA (reader, library, discover, admin).
- `docs/`: the user guide and screenshots.
- Source adapters live in the separate `yomi-sources` pack, not in this repo.

## Run it locally
```bash
cp .env.example .env      # point LIBRARY_PATH at your manga
docker compose up -d
```
Open http://localhost:3000, create the admin account, and add a source by URL.

## Pull requests
- Keep changes focused: one topic per PR.
- Match the existing TypeScript style and formatting.
- For anything user-facing, a short note in `docs/USAGE.md` is appreciated.
- Please don't hardcode new default sources that point at specific sites. The engine system already reaches whole families of sites by URL, which is the point.

## Tests
Run them with `npm test` in `bff/` or `web/` (Node 20+; the runner is Node's built-in test runner via `tsx`,
so there's nothing extra to install beyond `npm install`).

Most tests are plain unit tests over pure helpers. A few rules — the reading-progress ones — are enforced in
SQL, so they run against a real Postgres and are skipped unless you point them at one:

```
TEST_DATABASE_URL=postgres://test:test@127.0.0.1:5432/uchiyomi_test npm test
```

CI runs both suites (with a throwaway Postgres) on every pull request.

If you're fixing a bug, a test that fails before the fix and passes after is the most useful thing you can
add — several of the existing ones exist because something broke quietly and nobody noticed for weeks.

## Reporting bugs
Open an issue with the bug-report template. Include what you did, what happened, what you expected, and your setup (deploy method, browser, device).

## License
By contributing, you agree your contributions are licensed under the project's MPL-2.0 license.
