import { START_KEYS } from '../controls';

/** Title card shown until the player clicks. */
export function StartScreen({ onStart }: { onStart: () => void }) {
  return (
    <div id="start" onClick={onStart}>
      <div className="card">
        <h1>FARLIGHT</h1>
        <p className="tag">
          A procedurally generated neighbourhood of 110 star systems, every one built to real scale: stars in solar radii, planets in Earth radii, orbits in
          astronomical units, and light-years between the stars. You start above an Earth-like world. Use the FTL drive to cross a system and the hyperdrive
          to reach another star.
        </p>
        <div className="keys">
          {START_KEYS.map(([k, what]) => (
            <div key={k}>
              <kbd>{k}</kbd>
              <span>{what}</span>
            </div>
          ))}
        </div>
        <p className="note">
          In FTL, W and S set the throttle and the drive slows itself near massive bodies, so aim at a planet and hold W. Planets and stars pull on you: thrust
          away or you fall, and touching down faster than 150 m/s destroys the ship. Thrusters burn hydrogen, the FTL drive burns exotic matter, and everything
          runs on a battery charged by solar panels on the ship's top. Browsers close the tab on Ctrl+W, so use C to descend while thrusting forward.
        </p>
        <button id="go" type="button">
          TAKE THE HELM
        </button>
      </div>
    </div>
  );
}
