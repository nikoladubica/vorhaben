// Filter bar for the projects list: status, type, and tag. State lives in the URL search
// params (via useSearchParams) so filters survive a reload and are shareable. The status
// and type selects commit immediately; the tag text commits on Enter or blur to avoid a
// refetch on every keystroke.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ProjectStatus, ProjectType } from '../../types';

const STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'ended', label: 'Ended' },
  { value: 'idea', label: 'Idea' },
];

export function ProjectFilters({ types }: { types: ProjectType[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const type = searchParams.get('type') ?? '';
  const tag = searchParams.get('tag') ?? '';

  const [tagDraft, setTagDraft] = useState(tag);
  // Keep the local draft in sync when the URL changes elsewhere (e.g. back/forward).
  useEffect(() => {
    setTagDraft(tag);
  }, [tag]);

  function setParam(key: string, value: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <div className="filter-bar">
      <label className="field filter-field">
        <span>Status</span>
        <select value={status} onChange={(e) => setParam('status', e.target.value)}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field filter-field">
        <span>Type</span>
        <select value={type} onChange={(e) => setParam('type', e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field filter-field">
        <span>Tag</span>
        <input
          type="text"
          value={tagDraft}
          placeholder="Filter by tag"
          onChange={(e) => setTagDraft(e.target.value)}
          onBlur={() => setParam('tag', tagDraft.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setParam('tag', tagDraft.trim());
            }
          }}
        />
      </label>
    </div>
  );
}
