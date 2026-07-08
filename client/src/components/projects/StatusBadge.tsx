// Lifecycle status shown as a dot + label using §1.3 vocabulary — never raw column names.
// `active` is the only "live" state (green dot); every other state uses the muted dot.

import type { ProjectStatus } from '../../types';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
  idea: 'Idea',
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const dotClass = status === 'active' ? 'dot g' : 'dot p';
  return (
    <span>
      <span className={dotClass} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}
