# Vendored libraries

Third-party code and fonts the site serves itself, so the pages fetch nothing from another site.

| File | Library | Version | License |
|---|---|---|---|
| `motion-11.13.5.js` | [Motion](https://motion.dev) (standalone build, `dist/motion.js`) | 11.13.5 | MIT, see `motion-11.13.5.LICENSE.md` |
| `three-0.128.0.min.js` | [three.js](https://threejs.org) (r128, `build/three.min.js`) | 0.128.0 | MIT, see `three-0.128.0.LICENSE` |
| `inter-tight-5.3.0-latin-wght.woff2` | [Inter Tight](https://github.com/rsms/inter-tight), variable, Latin subset (`@fontsource-variable/inter-tight`, `files/inter-tight-latin-wght-normal.woff2`) | 5.3.0 | SIL Open Font License 1.1, see `inter-tight-5.3.0.LICENSE.txt` |
| `geist-mono-5.3.0-latin-wght.woff2` | [Geist Mono](https://github.com/vercel/geist-font), variable, Latin subset (`@fontsource-variable/geist-mono`, `files/geist-mono-latin-wght-normal.woff2`) | 5.3.0 | SIL Open Font License 1.1, see `geist-mono-5.3.0.LICENSE.txt` |

The fonts are the same files the dashboard ships in `src/dashboard/assets/fonts`. To update them: download the file from `https://cdn.jsdelivr.net/npm/@fontsource-variable/<font>@<version>/files/<font>-latin-wght-normal.woff2`, check it matches the same file from unpkg, save it here with the new version in the name, copy the package's `LICENSE` alongside, and change the `@font-face` rules in `site/site.css` and the one `<link rel="preload">` line in every page.

To update Motion: download `https://cdn.jsdelivr.net/npm/motion@<version>/dist/motion.js`, check it matches the same file from `https://unpkg.com/motion@<version>/dist/motion.js`, save it here with the new version in the name, copy its `LICENSE.md` alongside, and change the one `<script src="vendor/...">` line in `site/index.html`.

To update three.js: download `https://cdn.jsdelivr.net/npm/three@<version>/build/three.min.js`, check it matches the same file from `https://unpkg.com/three@<version>/build/three.min.js`, save it here with the new version in the name, copy its `LICENSE` alongside, and change the one path in `site/plum.js` that loads it. Plum was modelled on r128; a newer three.js renames some of the colour settings it uses (`outputEncoding`, `sRGBEncoding`), so check every pose after an update.

# Agent marks

The "Works with" line in the landing page's hero names each agent Atrium runs, with its maker's mark where the owner allows one, as an inline SVG. Each mark belongs to its owner (see `terms.html`); the site shows them only to name the CLIs Atrium runs, and Atrium isn't affiliated with or endorsed by any of them.

| Mark | Owner | Source | License |
|---|---|---|---|
| Claude Code | Anthropic | [Simple Icons](https://simpleicons.org) 16.38.0, `icons/claudecode.svg` (its data names `https://code.claude.com` as the source). The same file from jsDelivr and unpkg matched. | The drawing is CC0 1.0 through Simple Icons; the mark is Anthropic's trademark. |
| Codex (the OpenAI Blossom) | OpenAI | OpenAI's brand page, [openai.com/brand](https://openai.com/brand/), "Download logos": `https://cdn.openai.com/brand/openai-logos.zip`, `SVGs/OAI_OpenAI-Blossom_Black.svg`. Simple Icons no longer carries an OpenAI icon. | OpenAI's Marks usage terms on that page: used only next to the OpenAI product it names, not more prominent than Atrium's own name, with no implied endorsement, and never recoloured. |
| Gemini (Antigravity) | Google | No mark: Google asks for approval before its marks are used, so the line shows the name alone. | |

The paths are copied unchanged. Only the Blossom's `viewBox` differs: it's cut to the mark's own bounds (the download pads it with clear space), so both marks draw at the same size, and the space around them comes from the page's layout. Both marks are filled with `--mark` (site.css), which is plain white on the dark theme and plain black on the light one, because OpenAI allows the Blossom in no other colour. They're quieted at rest and brightened on hover with opacity alone.
