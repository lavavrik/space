import type { GuideView } from '../../game/hud/types';
import { Bar, cx } from './primitives';

/** Step-by-step progress for orbit insertion, holds, hyperjumps and tanker rendezvous. */
export function ManeuverGuide({ guide }: { guide: GuideView }) {
  return (
    <section id="guide" className="pan">
      <div className="h">
        <span>{guide.title}</span>
        <span id="gEta">{guide.eta}</span>
      </div>
      <div className="gsub">{guide.sub}</div>
      <ol id="gSteps">
        {guide.steps.map((s) => (
          <li key={s.num} className={s.className}>
            <span className="n">{s.badge}</span>
            <span className="t">{s.title}</span>
            <span className="e">{s.eta}</span>
            <span className="d">{s.detail}</span>
            <Bar frac={s.prog} />
            {s.extra && <span className="x">{s.extra}</span>}
          </li>
        ))}
      </ol>
      {guide.end && <div className={cx('gend', guide.end.warn && 'bad')}>{guide.end.text}</div>}
      <div className="sub">
        <span>{guide.foot}</span>
        <span>{guide.time}</span>
      </div>
    </section>
  );
}
