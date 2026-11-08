# Vendored libraries

Third-party code the site serves itself, so no outside script runs on the page.

| File | Library | Version | License |
|---|---|---|---|
| `motion-11.13.5.js` | [Motion](https://motion.dev) (standalone build, `dist/motion.js`) | 11.13.5 | MIT, see `motion-11.13.5.LICENSE.md` |

To update: download `https://cdn.jsdelivr.net/npm/motion@<version>/dist/motion.js`, check it matches the same file from `https://unpkg.com/motion@<version>/dist/motion.js`, save it here with the new version in the name, copy its `LICENSE.md` alongside, and change the one `<script src="vendor/...">` line in `site/index.html`.
