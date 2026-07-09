// Tags: every tag the user has, with how many projects wear it. Rename in place (commit on Enter
// or blur); because a rename can merge into an existing tag, the whole list is refreshed after.
// Delete strips the label from its projects, so the confirm states how many are affected.

import { useCallback, useEffect, useState } from 'react';
import { type Tag, deleteTag, listTags, renameTag } from '../../api/tags';

export function TagsSection() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    listTags()
      .then(setTags)
      .catch(() => setLoadError('Could not load tags.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  function startEdit(tag: Tag) {
    setActionError(null);
    setEditingId(tag.id);
    setDraft(tag.name);
  }

  async function commitEdit(tag: Tag) {
    const name = draft.trim();
    setEditingId(null);
    if (name === '' || name === tag.name) return;
    try {
      await renameTag(tag.id, name);
      refresh();
    } catch {
      setActionError('Could not rename the tag. Please try again.');
    }
  }

  async function onDelete(tag: Tag) {
    const ok = window.confirm(
      `Delete “${tag.name}”? ${tag.project_count} project(s) will lose this label.`,
    );
    if (!ok) return;
    setActionError(null);
    try {
      await deleteTag(tag.id);
      refresh();
    } catch {
      setActionError('Could not delete the tag. Please try again.');
    }
  }

  return (
    <div className="set-sec">
      <h4>Tags</h4>
      <p className="desc">
        Labels shared across your projects. Renaming a tag onto an existing name merges the two;
        deleting one removes it from every project that used it.
      </p>

      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}

      {loading ? (
        <p className="table-empty">Loading…</p>
      ) : loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : tags.length === 0 ? (
        <p className="table-empty">No tags yet. Add tags when you create or edit a project.</p>
      ) : (
        <ul className="tag-list">
          {tags.map((tag) => (
            <li className="tag-list-row" key={tag.id}>
              {editingId === tag.id ? (
                <input
                  className="cell-input"
                  autoFocus
                  value={draft}
                  aria-label={`Rename tag ${tag.name}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitEdit(tag)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitEdit(tag);
                    } else if (e.key === 'Escape') {
                      setEditingId(null);
                    }
                  }}
                />
              ) : (
                <button type="button" className="tag-name-btn" onClick={() => startEdit(tag)}>
                  {tag.name}
                </button>
              )}
              <span className="tag-count num">
                used in {tag.project_count} project{tag.project_count === 1 ? '' : 's'}
              </span>
              <div className="row-actions">
                <button type="button" className="row-btn" onClick={() => startEdit(tag)}>
                  Rename
                </button>
                <button type="button" className="row-btn danger" onClick={() => onDelete(tag)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
