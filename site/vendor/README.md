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
