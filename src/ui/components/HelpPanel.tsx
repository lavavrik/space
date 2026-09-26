import { Fragment } from "react";
import { GROUPS, KEYBOARD } from "../controls";
import { Panel, cx } from "./primitives";

/** Width of one key unit on the schema, in px. */
const U = 21;

/**
 * Controls (Tab hides, heading collapses): a keyboard schema with the keys the game uses coloured
 * by group, and a legend of what each does, in the same colours.
 */
export function HelpPanel() {
  return (
    <Panel name="help" id="help" title="CONTROLS" right="TAB HIDES">
      <div className="kb" aria-hidden="true">
        {KEYBOARD.map((row, r) => (
          <div key={r} className="kbrow">
            {row.map(([label, w, group], i) => (
              <span
                key={i}
                className={cx("kc", group, group && "on", !label && "gap")}
                style={{ width: w * U - 2 }}
              >
                {label}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="klegend">
        {GROUPS.map((g) => (
          <div key={g.id} className={cx("kgroup", g.id)}>
            <div className="kgt">{g.title}</div>
            <div className="keys">
              {g.keys.map(([k, what]) => (
                <Fragment key={k + what}>
                  <kbd>{k}</kbd>
                  <span>{what}</span>
                </Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
