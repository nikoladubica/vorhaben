// COMPOSITION — income by project TYPE as proportional `.rank` bars (design file's income screen,
// `#compRank`). The server sorts slices largest-first; the largest is accented red, the rest muted
// grey. Bar widths are relative to the largest share, and the right-aligned figure is the share as
// a whole percentage. An empty composition array renders nothing (the caller hides the panel).

import type { CompositionSlice } from '../../api/dashboard';
import { formatMoney } from '../../domain/format';
import { useTooltip } from '../charts/useTooltip';

interface CompositionBarProps {
  composition: CompositionSlice[];
  baseCurrency: string;
}

export function CompositionBar({ composition, baseCurrency }: CompositionBarProps) {
  const tip = useTooltip();
  if (composition.length === 0) return null;

  const maxShare = composition[0]?.share ?? 0;

  return (
    <div className="rank">
      {composition.map((slice, index) => {
        const pct = Math.round(slice.share * 100);
        const width = maxShare > 0 ? (slice.share / maxShare) * 100 : 0;
        const total = formatMoney(String(slice.total), baseCurrency);
        const content = (
          <>
            <div>
              {slice.label} · <b>{total}</b>
            </div>
            <div>{pct}% of income</div>
          </>
        );
        return (
          <div
            key={slice.type}
            className="rank-row"
            tabIndex={0}
            role="img"
            aria-label={`${slice.label}: ${pct}% of income, ${total}`}
            onMouseMove={(e) => tip.showAt(content, e.clientX, e.clientY)}
            onMouseLeave={tip.hide}
            onFocus={(e) => tip.showAtElement(content, e.currentTarget)}
            onBlur={tip.hide}
          >
            <span className="n">
              {slice.label}
              <small>{total}</small>
            </span>
            <span className="rbar">
              <i className={index === 0 ? '' : 'mute'} style={{ width: `${width}%` }} />
            </span>
            <span className="v num">{pct}%</span>
          </div>
        );
      })}
      {tip.element}
    </div>
  );
}
