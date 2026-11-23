# Deploying

The game is a static build (`npm run build` → `dist/`: `index.html` and hashed `assets/`), hosted on
orbcloud as a **webserver** service (static files):

| | |
|---|---|
| Project | `space` (`b2df3a30-c8af-4380-841b-054c3b4ff4c6`) |
| Environment | `space` (the project's default; there's no `production`) |
| Service | `ui`, webserver, public (`221ebc30-93ed-41cc-8b77-181e25bfeaf4`) on `vps-de2` |
| URL | https://space-ui-221ebc30.orbcloud.io |

**Deploy:** `scripts/deploy.sh` (needs `occ` logged in). It builds, uploads every file under
`assets/`, then `index.html` last. Asset names are content hashes and `vite.config.ts` has
`base: './'`, so the build works from any path. Old hashed assets stay on the server until deleted
(harmless).

Saves live in the browser's `localStorage`, per origin: a save from the dev server doesn't carry over
to the deployed site.
