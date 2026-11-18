# Vendored libraries

Third-party code the site serves itself, so no outside script runs on the page.

| File | Library | Version | License |
|---|---|---|---|
| `motion-11.13.5.js` | [Motion](https://motion.dev) (standalone build, `dist/motion.js`) | 11.13.5 | MIT, see `motion-11.13.5.LICENSE.md` |
| `three-0.128.0.min.js` | [three.js](https://threejs.org) (r128, `build/three.min.js`) | 0.128.0 | MIT, see `three-0.128.0.LICENSE` |

To update Motion: download `https://cdn.jsdelivr.net/npm/motion@<version>/dist/motion.js`, check it matches the same file from `https://unpkg.com/motion@<version>/dist/motion.js`, save it here with the new version in the name, copy its `LICENSE.md` alongside, and change the one `<script src="vendor/...">` line in `site/index.html`.

To update three.js: download `https://cdn.jsdelivr.net/npm/three@<version>/build/three.min.js`, check it matches the same file from `https://unpkg.com/three@<version>/build/three.min.js`, save it here with the new version in the name, copy its `LICENSE` alongside, and change the one path in `site/plum.js` that loads it. Plum was modelled on r128; a newer three.js renames some of the colour settings it uses (`outputEncoding`, `sRGBEncoding`), so check every pose after an update.
