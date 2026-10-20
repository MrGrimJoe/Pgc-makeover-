import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { CampusItem } from '../../shared/schema.ts';
import { CAMPUSES } from '../../shared/campuses.ts';
import { cleanCampusOther, normalizeCampusText } from '../../shared/campus.ts';

/** What a person picked: a campus from the bundled list, or free text for a campus that is not listed. */
export type CampusChoice = { campus: CampusItem; other?: undefined } | { campus?: undefined; other: string };

/** What the picker shows. Kept separate from the state handling so it can be tested on its own. */
export interface CampusPickerViewProps {
  id: string;
  label: string;
  selected: CampusChoice | null;
  /** True while the person is changing an already selected campus. */
  editing: boolean;
  query: string;
  open: boolean;
  results: CampusItem[];
  /** Index of the highlighted option; results.length means the "not listed" option. -1 for none. */
  activeIndex: number;
  cities: string[];
  city: string;
  canOther: boolean;
  otherOpen: boolean;
  otherText: string;
  message: string | null;
  onQueryChange: (value: string) => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSelect: (campus: CampusItem) => void;
  onChange: () => void;
  onCityChange: (value: string) => void;
  onOpenOther: () => void;
  onOtherTextChange: (value: string) => void;
  onSubmitOther: () => void;
  onCancelOther: () => void;
}

const fieldClass =
  'w-full min-h-[44px] bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 text-[15px] text-[var(--text,#17233A)]';

export const CampusPickerView: React.FC<CampusPickerViewProps> = (p) => {
  const inputId = `${p.id}-input`;
  const listId = `${p.id}-list`;
  const optionId = (i: number) => `${p.id}-option-${i}`;
  const optionCount = p.results.length + (p.canOther ? 1 : 0);
  const showList = p.open && !p.otherOpen && optionCount > 0;

  if (p.selected && !p.editing) {
    return (
      <div>
        <p id={`${p.id}-label`} className="block text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1">
          {p.label}
        </p>
        <div
          role="group"
          aria-labelledby={`${p.id}-label`}
          className="flex items-center justify-between gap-3 min-h-[44px] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 py-1.5"
        >
          <div className="min-w-0">
            <span className="block text-[15px] text-[var(--text,#17233A)] truncate">
              {p.selected.campus ? p.selected.campus.name : p.selected.other}
            </span>
            <span className="block text-[12px] text-[var(--muted,#5B6577)] truncate">
              {p.selected.campus ? p.selected.campus.city : 'Other campus'}
            </span>
          </div>
          <button
            type="button"
            onClick={p.onChange}
            className="min-h-[44px] px-2 text-[13px] font-semibold text-[var(--blue,#244C8A)] cursor-pointer bg-transparent border-0"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-[13px] font-medium text-[var(--muted,#5B6577)]">
        {p.label}
      </label>

      {p.cities.length > 0 && (
        <select
          aria-label="Filter campuses by city"
          value={p.city}
          onChange={(e) => p.onCityChange(e.target.value)}
          className={`${fieldClass} cursor-pointer`}
        >
          <option value="">All cities</option>
          {p.cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}

      <div className="relative">
        <div className="flex items-center gap-2 border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 min-h-[44px] bg-[var(--bg,#fff)]">
          <Search className="w-4 h-4 shrink-0 stroke-[1.7] text-[var(--muted,#5B6577)]" aria-hidden="true" />
          <input
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && p.activeIndex >= 0 ? optionId(p.activeIndex) : undefined}
            autoComplete="off"
            maxLength={80}
            value={p.query}
            placeholder="Start typing your campus name"
            onChange={(e) => p.onQueryChange(e.target.value)}
            onFocus={p.onFocus}
            onKeyDown={p.onKeyDown}
            className="flex-1 min-w-0 border-0 bg-transparent text-[15px] text-[var(--text,#17233A)] outline-none"
          />
        </div>

        {showList && (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${p.label} suggestions`}
            className="absolute z-20 left-0 right-0 mt-1 max-h-[260px] overflow-auto bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] shadow-lg py-1"
          >
            {p.results.map((c, i) => (
              <li
                key={c.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === p.activeIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  p.onSelect(c);
                }}
                className={`px-3 py-2 min-h-[44px] cursor-pointer ${i === p.activeIndex ? 'bg-[var(--tint,#EAF0FA)]' : ''}`}
              >
                <span className="block text-[15px] text-[var(--text,#17233A)]">{c.name}</span>
                {c.city && <span className="block text-[12px] text-[var(--muted,#5B6577)]">{c.city}</span>}
              </li>
            ))}
            {p.canOther && (
              <li
                id={optionId(p.results.length)}
                role="option"
                aria-selected={p.activeIndex === p.results.length}
                onMouseDown={(e) => {
                  e.preventDefault();
                  p.onOpenOther();
                }}
                className={`px-3 py-2 min-h-[44px] cursor-pointer border-t border-[var(--line,#E8EBF0)] text-[14px] font-semibold text-[var(--blue,#244C8A)] ${
                  p.activeIndex === p.results.length ? 'bg-[var(--tint,#EAF0FA)]' : ''
                }`}
              >
                My campus is not listed (type it in)
              </li>
            )}
          </ul>
        )}
      </div>

      <p role="status" aria-live="polite" className="text-[12px] text-[var(--muted,#5B6577)] min-h-[16px]">
        {p.open && p.query.trim() && optionCount === 0
          ? 'No campus found'
          : p.open && p.results.length > 0
            ? `${p.results.length} ${p.results.length === 1 ? 'campus' : 'campuses'} found`
            : ''}
      </p>

      {p.otherOpen && (
        <div className="border border-[var(--line,#E8EBF0)] rounded-[8px] p-3 space-y-2">
          <div>
            <label htmlFor={`${p.id}-other`} className="block text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1">
              Other campus
            </label>
            <input
              id={`${p.id}-other`}
              type="text"
              maxLength={80}
              value={p.otherText}
              onChange={(e) => p.onOtherTextChange(e.target.value)}
              className={fieldClass}
            />
          </div>
          <p className="text-[12px] text-[var(--muted,#5B6577)]">
            Other campuses are shown on your profile but are not used to find people on your campus.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={p.onSubmitOther}
              className="flex-1 min-h-[44px] rounded-[8px] bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] text-[13px] font-semibold cursor-pointer border-0"
            >
              Use this campus
            </button>
            <button
              type="button"
              onClick={p.onCancelOther}
              className="min-h-[44px] px-4 rounded-[8px] border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)] text-[13px] font-semibold cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {p.message && (
        <p role="alert" className="text-[13px] text-[var(--danger,#B23A40)]">
          {p.message}
        </p>
      )}
    </div>
  );
};

interface CampusPickerProps {
  value: CampusChoice | null;
  onChange: (choice: CampusChoice | null) => void;
  label?: string;
  id?: string;
}

const RESULT_LIMIT = 20;
const CITIES = [...new Set(CAMPUSES.map((c) => c.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** Filters the bundled list: name prefix first, then name contains, then city-only matches. */
export function filterCampuses(query: string, city: string, limit = RESULT_LIMIT): CampusItem[] {
  const q = normalizeCampusText(query);
  const c = normalizeCampusText(city);
  const ranked: Array<{ rank: number; item: CampusItem }> = [];
  for (const item of CAMPUSES) {
    if (c && normalizeCampusText(item.city) !== c) continue;
    const name = item.name.toLowerCase();
    let rank = 0;
    if (q) {
      if (name.startsWith(q)) rank = 0;
      else if (name.includes(q)) rank = 1;
      else if (item.city.toLowerCase().includes(q)) rank = 2;
      else continue;
    }
    ranked.push({ rank, item });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
  return ranked.slice(0, limit).map((r) => r.item);
}

/** Searchable campus picker over the list that ships with the app, plus an "other campus" text field. */
export const CampusPicker: React.FC<CampusPickerProps> = ({ value, onChange, label = 'Campus', id }) => {
  const autoId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const baseId = id ?? `campus-${autoId}`;

  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [city, setCity] = useState('');
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const inputWasShown = useRef(false);

  const inputVisible = !value || editing;
  const results = useMemo(() => (open ? filterCampuses(query, city) : []), [query, city, open]);

  // Move focus to the field when the person chooses to change their campus
  useEffect(() => {
    if (inputVisible && inputWasShown.current) {
      document.getElementById(`${baseId}-input`)?.focus();
    }
    inputWasShown.current = inputVisible;
  }, [inputVisible, baseId]);

  const trimmed = query.trim();
  const canOther = trimmed.length >= 2 && !results.some((r) => r.name.toLowerCase() === trimmed.toLowerCase());
  const optionCount = results.length + (canOther ? 1 : 0);

  const finish = (choice: CampusChoice) => {
    onChange(choice);
    setEditing(false);
    setOpen(false);
    setOtherOpen(false);
    setQuery('');
    setMessage(null);
  };

  const select = (campus: CampusItem) => finish({ campus });

  const openOther = () => {
    setOtherOpen(true);
    setOtherText(trimmed);
    setOpen(false);
  };

  const submitOther = () => {
    const cleaned = cleanCampusOther(otherText);
    if (!cleaned) {
      setMessage('Enter 2 to 80 characters, without < or >.');
      return;
    }
    finish({ other: cleaned });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      if (optionCount === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => (i < 0 ? (step === 1 ? 0 : optionCount - 1) : (i + step + optionCount) % optionCount));
    } else if (e.key === 'Enter' && open && activeIndex >= 0) {
      e.preventDefault();
      const chosen = results[activeIndex];
      if (chosen) select(chosen);
      else openOther();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <CampusPickerView
      id={baseId}
      label={label}
      selected={value}
      editing={editing}
      query={query}
      open={open}
      results={results}
      activeIndex={activeIndex}
      cities={CITIES}
      city={city}
      canOther={canOther}
      otherOpen={otherOpen}
      otherText={otherText}
      message={message}
      onQueryChange={(v) => {
        setQuery(v);
        setOpen(true);
        setActiveIndex(-1);
      }}
      onFocus={() => setOpen(true)}
      onKeyDown={onKeyDown}
      onSelect={select}
      onChange={() => setEditing(true)}
      onCityChange={(v) => {
        setCity(v);
        setActiveIndex(-1);
      }}
      onOpenOther={openOther}
      onOtherTextChange={setOtherText}
      onSubmitOther={submitOther}
      onCancelOther={() => {
        setOtherOpen(false);
        setMessage(null);
      }}
    />
  );
};
