import { Fragment } from 'react';
import { HELP_KEYS } from '../controls';
import { Heading } from './primitives';

/** Controls list in the top-left corner (Tab hides it). */
export function HelpPanel() {
  return (
    <div id="help">
      <Heading right="TAB HIDES">CONTROLS</Heading>
      {HELP_KEYS.map(([k, what]) => (
        <Fragment key={k}>
          <kbd>{k}</kbd>
          <span>{what}</span>
        </Fragment>
      ))}
    </div>
  );
}
