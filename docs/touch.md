# Touch controls

Phones and tablets get on-screen controls and a compact HUD. Nothing in the simulation knows about
touch: the controls drive the same `Input` the keyboard does.

**When it's on.** `ui/hooks/useTouchMode.ts` puts `touch` on `<body>` for a coarse primary pointer
(`(pointer: coarse)`), or as soon as a finger touches the screen. `?touch` in the address forces it,
to try the layout on a desktop (devtools device mode works too).

**Input** (`game/input/Input.ts`)
- One finger dragging on the view steers, as an unlocked mouse drag does (`TOUCH_LOOK` scales it).
- A short, still touch is a tap: it targets what's under it (`onClick`). No pointer lock is asked for.
- Two fingers pinch: one `onWheel` step per `PINCH_STEP` px, so the periscope zoom, map zoom and
  planner altitude work as with the wheel.
- `setKey(code, down)` holds a key, `press(code, shift)` fires one (with Shift held only if asked,
  whatever boost is doing).

**Controls** (`ui/components/TouchControls.tsx`, styled in `styles/touch.css`)
- Left thumb: a stick (strafe, and W / S thrust) with up, down and roll buttons beside it.
- Right thumb: FTL, BOOST (held = Shift), target, next target, all stop, and MORE.
- MORE opens a sheet with the rest of the keyboard's actions (`SHEET`), grouped as in `ui/controls.ts`.
- While the orbit planner, navigation computer or autopilot panel is open, a strip of the keys it
  wants (digits, `[ ]`, direction, `/` search, Enter, Backspace) appears above the speedometer.
- The pause menu and station window have their own buttons, so the controls hide there; with the
  system map open only a close button shows.

**Compact HUD** (`body.touch` rules in `styles/touch.css`). The root font size follows the window's
height instead of its width; the location is two lines, the gauges are slim bars top right, the
target is a name and distance top centre, and the speedometer shows only lit lamps. Tooltips, the
controls list and the mouse-capture hint are hidden. Portrait shows a "turn your device" banner.

**Not done yet:** tap replacements for hover tooltips, narrowing the big panels (cargo, outfit,
station) for small screens, and a choice of which thumb gets the stick.
