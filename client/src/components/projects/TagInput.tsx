// Free-text chip input for project tags. Type a value and press Enter or comma to add a
// chip; click × (or Backspace on an empty field) to remove one. Value is a string[].
// Hand-built per the design system — no dependency.

import { useState } from 'react';

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  id?: string;
  invalid?: boolean;
}

export function TagInput({ value, onChange, id, invalid }: TagInputProps) {
  const [draft, setDraft] = useState('');

  function addTag(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Dedupe case-insensitively, keeping first-seen casing (matches the server).
    const exists = value.some((t) => t.toLowerCase() === trimmed.toLowerCase());
    if (!exists) {
      onChange([...value, trimmed]);
    }
    setDraft('');
  }

  function removeTag(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      removeTag(value.length - 1);
    }
  }

  return (
    <div className="tag-input" aria-invalid={invalid ? true : undefined}>
      {value.map((tag, i) => (
        <span className="tag chip-removable" key={`${tag}-${i}`}>
          {tag}
          <button
            type="button"
            className="tag-x"
            aria-label={`Remove tag ${tag}`}
            onClick={() => removeTag(i)}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        className="tag-entry"
        value={draft}
        placeholder={value.length === 0 ? 'Add a tag, press Enter' : ''}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => addTag(draft)}
      />
    </div>
  );
}
