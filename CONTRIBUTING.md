# Contributing to Koryomi

Thanks for your interest. Bug reports, feature ideas, and pull requests are all welcome.

## Project layout
- `bff/`: the Fastify + TypeScript API (auth, library scanner, image server, sources, scheduled updater).
- `web/`: the Next.js PWA (reader, library, discover, admin).
- `docs/`: the user guide and screenshots.
- Source adapters live in the separate `koryomi-sources` pack, not in this repo.

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

## Reporting bugs
Open an issue with the bug-report template. Include what you did, what happened, what you expected, and your setup (deploy method, browser, device).

## License
By contributing, you agree your contributions are licensed under the project's MPL-2.0 license.
