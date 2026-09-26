import { Fragment } from 'react';
import { HELP_KEYS } from '../controls';
import { Panel } from './primitives';

/** Controls list in the top-left corner (Tab hides it). */
export function HelpPanel() {
  return (
    <Panel name="help" id="help" title="CONTROLS" right="TAB HIDES">
      <div className="keys">
        {HELP_KEYS.map(([k, what]) => (
          <Fragment key={k}>
            <kbd>{k}</kbd>
            <span>{what}</span>
          </Fragment>
        ))}
      </div>
    </Panel>
  );
}
