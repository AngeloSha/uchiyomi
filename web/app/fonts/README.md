# Bundled fonts

Three latin-subset variable `.woff2` files, byte-identical to what Google Fonts serves for these families.

They are committed rather than fetched because `next/font/google` downloads from `fonts.gstatic.com` **at
build time**. A blip there fails the image build outright — which is exactly how v0.5.1 first shipped
half-published, with the API image pushed and the web image not. Keeping them here also means the image
builds behind a firewall, and with no third-party request.

| File | Family | Licence |
| --- | --- | --- |
| `SpaceGrotesk-latin.woff2` | [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) | SIL Open Font License 1.1 |
| `Inter-latin.woff2` | [Inter](https://fonts.google.com/specimen/Inter) | SIL Open Font License 1.1 |
| `Unbounded-latin.woff2` | [Unbounded](https://fonts.google.com/specimen/Unbounded) | SIL Open Font License 1.1 |

The OFL permits bundling and redistribution, including in a commercial or differently-licensed project, as
long as the fonts are not sold on their own and the licence travels with them.

To refresh one: request `https://fonts.googleapis.com/css2?family=<Family>&display=swap` with a modern
browser User-Agent, take the `latin` `@font-face` block's `woff2` URL, and replace the file. Keep the weight
range in `../layout.tsx` in step with the family's real axis.
