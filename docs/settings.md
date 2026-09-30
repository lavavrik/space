# Settings

The pause menu's **Settings** panel (`ui/components/PauseMenu.tsx SettingsBox`, `game/settings.ts`).
Each change applies at once (`Game.setSetting`). Settings are kept in the browser (localStorage
`farlight.settings`), apart from the save game, so a new game keeps them. A setting added later
takes its default.

| Setting | Options | What it does |
| --- | --- | --- |
| Volume | 0–100 % | everything's loudness (the master gain × the mix's own level) |
| Cabin hum | 0–100 % | the life support's hum, what you hear sitting still |
| Frame rate | Display · 60 fps | 60: the display's in-between refreshes are skipped (cooler, quieter), and the dynamic resolution aims for 60 |
| Dynamic resolution | On · Off | `gpu/dynres.ts`; `?fullres` in the URL still turns it off whatever this says |
| Resolution | 100 · 75 · 50 % | the scene's resolution at most, as a share of the canvas's; the dynamic resolution scales within it, and the HUD stays sharp |
| Clouds | High · Low · Off | volumetric clouds with all their steps, half of them, or none (the flat deck all the way down) |
| Bloom, Lens flare, FTL blur | On · Off | the post effects (docs/post.md); bloom off also skips its passes |

Mute stays where it was (⇧P, and the pause menu's Sound button): it's a switch, the volume a level.
