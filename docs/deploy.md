# Deploying

The game is a static build (`npm run build` → `dist/`: `index.html` and hashed `assets/`), hosted on
orbcloud as a **webserver** service (static files):

| | |
|---|---|
| Project | `commonsafe` (`b2df3a30-c8af-4380-841b-054c3b4ff4c6`) |
| Environment | `commonsafe` (the project's default; there's no `production`) |
| Service | `ui`, webserver, public (`10d32890-180a-40c1-9467-081b442622ff`) on `vps-de2` |
| URL | https://commonsafe-ui-10d32890.orbcloud.io |

**Deploy:** `scripts/deploy.sh` (needs `occ` logged in). It builds, uploads every file under
`assets/`, then `index.html` last. Asset names are content hashes and `vite.config.ts` has
`base: './'`, so the build works from any path. Old hashed assets stay on the server until deleted
(harmless).

Saves live in the browser's `localStorage`, per origin: a save from the dev server doesn't carry over
to the deployed site.
