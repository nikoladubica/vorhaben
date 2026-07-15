// One check-in row — the two-question unit shared by the daily nudge, the Weekly Close, and (in
// compact form) the project page (§2.2, ticket 27). Purely presentational: it renders the two
// pickers side by side plus a quiet "Didn't touch it" answer, and bubbles every answer up through
// `onLog(kind, value)`. The host owns persistence and coverage — this component holds no state and
// makes no API calls.
//
// Both questions are independently answerable, and both are skippable (skipping records nothing).
// "Didn't touch it" is the third, quiet answer: it POSTs an `untouched` event (value null) and
// resolves the whole row — a project no one touched today has nothing to rate. Distinct from
// dismissing the nudge, which records nothing.

import type { Feeling, MoodKind, Trend } from '../../types';
import { FeelingPicker } from '../canvas/FeelingPicker';
import { TrendPicker } from '../canvas/TrendPicker';

interface CheckInRowProps {
  // The project name — shown when the surface lists several projects (the nudge). Omitted where the
  // name already heads the surface (the project page, a Weekly Close step).
  name?: string;
  // Current answers to reflect on the triggers (a legacy feeling still renders; see FeelingPicker).
  feeling: Feeling | null;
  trend: Trend | null;
  // Whether each question has been answered today (directly or via "didn't touch it"). Distinct from
  // the value: an explicit Clear answers the question with a null value.
  feelingAnswered: boolean;
  trendAnswered: boolean;
  // True once "didn't touch it" resolved the row today.
  untouched: boolean;
  // Answer one question. `untouched` always carries a null value.
  onLog: (kind: MoodKind, value: Feeling | Trend | null) => void;
}

export function CheckInRow({
  name,
  feeling,
  trend,
  feelingAnswered,
  trendAnswered,
  untouched,
  onLog,
}: CheckInRowProps) {
  return (
    <div className="checkin-row">
      {name && <span className="checkin-name">{name}</span>}
      <div className="checkin-picks">
        <div className={`mood-pick${feelingAnswered ? ' is-answered' : ''}`}>
          <FeelingPicker value={feeling} onChange={(v) => onLog('feeling', v)} />
        </div>
        <div className={`mood-pick${trendAnswered ? ' is-answered' : ''}`}>
          <TrendPicker value={trend} onChange={(v) => onLog('trend', v)} />
        </div>
        <button
          type="button"
          className="checkin-untouched"
          aria-pressed={untouched}
          onClick={() => onLog('untouched', null)}
        >
          Didn&rsquo;t touch it
        </button>
      </div>
    </div>
  );
}
