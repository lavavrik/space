# Touch controls

Phones and tablets get on-screen controls and a compact HUD. Nothing in the simulation knows about
touch: the controls drive the same `Input` the keyboard does.

**When it's on.** `ui/hooks/useTouchMode.ts` puts `touch` on `<body>` for a coarse primary pointer
(`(pointer: coarse)`), or as soon as a finger touches the screen. `?touch` in the address forces it,
to try the layout on a desktop (devtools device mode works too).

**Input** (`game/input/Input.ts`)
- One finger dragging on the view steers, as an unlocked mouse drag does (`TOUCH_LOOK` scales it).
- A short, still touch is a tap: it targets what's under it (`onClick`).
- **No pointer lock on a touch screen.** `Input.touch` is set for a coarse pointer, a forced `?touch`,
  or the first finger anywhere on the page, and `requestLock` does nothing then. A browser that
  grants a lock to a touch page (desktop devtools device mode, a tablet with a mouse) used to get
  one on every Resume, debug jump included, and while a pointer is locked `setPointerCapture`
  throws: the finger was never registered and dragging was dead until reload. A finger now also
  releases any lock it finds, and the finger is registered before capture is asked for.
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
  system map open only a close button shows. The pause menu (with Settings or the debug Jump to list)
  scrolls when it's taller than the window: `#pause` is its own scroll container, which a finger can
  pan despite `body.touch { touch-action: none }` (that only reaches as far as the nearest scroll
  container), and its row is centred with auto margins so its top is never cut off.

**Compact HUD** (`body.touch` rules in `styles/touch.css`). The root font size follows the window's
height instead of its width; the location is two lines, the gauges are slim bars top right, the
target is a name and distance top centre, and the speedometer shows only lit lamps. Tooltips, the
controls list and the mouse-capture hint are hidden. Portrait shows a "turn your device" banner.

**Tooltips.** `Tip` (`ui/components/Tooltip.tsx`) hovers for a mouse only; a tap opens and closes it
(and a tap elsewhere dismisses it). Lamps and gauge badges get a bigger hit area.

**Panels.** The left column is as wide as 40 % of the screen (up to 22 rem), drops the location
while a panel is open, and stops above the stick; panels scroll inside it. The right-hand panels
(planner, navigation, autopilot, guide) sit beside the right thumb's buttons, with the gauges
hidden while one is open. Panel headings are the collapse buttons, with a bigger hit area. The panel
keys strip sits between the speedometer and the right-hand buttons.

**Not done yet:** a choice of which thumb gets the stick; the station window (docked) wasn't
checked on a phone-sized screen; the approach strip is hidden in the compact target card.
