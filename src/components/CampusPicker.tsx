import React, { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { CampusItem } from '../../shared/schema.ts';

/** What the picker shows. Kept separate from the data fetching so it can be tested on its own. */
export interface CampusPickerViewProps {
  id: string;
  label: string;
  selected: CampusItem | null;
  /** True while the person is changing an already selected campus. */
  editing: boolean;
  query: string;
  open: boolean;
  loading: boolean;
  results: CampusItem[];
  /** Index of the highlighted option; results.length means the "add campus" option. -1 for none. */
  activeIndex: number;
  cities: string[];
  city: string;
  canRequest: boolean;
  requestOpen: boolean;
  requestCity: string;
  requesting: boolean;
  message: string | null;
  onQueryChange: (value: string) => void;
  onFocus: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSelect: (campus: CampusItem) => void;
  onChange: () => void;
  onCityChange: (value: string) => void;
  onOpenRequest: () => void;
  onRequestCityChange: (value: string) => void;
  onSubmitRequest: () => void;
  onCancelRequest: () => void;
}

const fieldClass =
  'w-full min-h-[44px] bg-[var(--bg,#fff)] border border-[var(--line,#E8EBF0)] rounded-[8px] px-3 text-[15px] text-[var(--text,#17233A)]';

export const CampusPickerView: React.FC<CampusPickerViewProps> = (p) => {
  const inputId = `${p.id}-input`;
  const listId = `${p.id}-list`;
  const optionId = (i: number) => `${p.id}-option-${i}`;
  const optionCount = p.results.length + (p.canRequest ? 1 : 0);
  const showList = p.open && !p.requestOpen && optionCount > 0;

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
            <span className="block text-[15px] text-[var(--text,#17233A)] truncate">{p.selected.name}</span>
            {(p.selected.city || p.selected.status === 'pending') && (
              <span className="block text-[12px] text-[var(--muted,#5B6577)] truncate">
                {[p.selected.city, p.selected.status === 'pending' ? 'Waiting for review' : ''].filter(Boolean).join(' · ')}
              </span>
            )}
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
                {(c.city || c.status === 'pending') && (
                  <span className="block text-[12px] text-[var(--muted,#5B6577)]">
                    {[c.city, c.status === 'pending' ? 'Waiting for review' : ''].filter(Boolean).join(' · ')}
                  </span>
                )}
              </li>
            ))}
            {p.canRequest && (
              <li
                id={optionId(p.results.length)}
                role="option"
                aria-selected={p.activeIndex === p.results.length}
                onMouseDown={(e) => {
                  e.preventDefault();
                  p.onOpenRequest();
                }}
                className={`px-3 py-2 min-h-[44px] cursor-pointer border-t border-[var(--line,#E8EBF0)] text-[14px] font-semibold text-[var(--blue,#244C8A)] ${
                  p.activeIndex === p.results.length ? 'bg-[var(--tint,#EAF0FA)]' : ''
                }`}
              >
                My campus is not listed
              </li>
            )}
          </ul>
        )}
      </div>

      <p role="status" aria-live="polite" className="text-[12px] text-[var(--muted,#5B6577)] min-h-[16px]">
        {p.loading
          ? 'Searching campuses'
          : p.open && p.query.trim() && optionCount === 0
            ? 'No campus found'
            : p.open && p.results.length > 0
              ? `${p.results.length} ${p.results.length === 1 ? 'campus' : 'campuses'} found`
              : ''}
      </p>

      {p.requestOpen && (
        <div className="border border-[var(--line,#E8EBF0)] rounded-[8px] p-3 space-y-2">
          <p className="text-[14px] text-[var(--text,#17233A)]">
            Request <b className="font-semibold">{p.query.trim()}</b> as a new campus
          </p>
          <div>
            <label htmlFor={`${p.id}-request-city`} className="block text-[13px] font-medium text-[var(--muted,#5B6577)] mb-1">
              City (optional)
            </label>
            <input
              id={`${p.id}-request-city`}
              type="text"
              maxLength={60}
              value={p.requestCity}
              onChange={(e) => p.onRequestCityChange(e.target.value)}
              className={fieldClass}
            />
          </div>
          <p className="text-[12px] text-[var(--muted,#5B6577)]">
            New campuses are reviewed before everyone can see them. You can keep going while it is reviewed.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={p.onSubmitRequest}
              disabled={p.requesting}
              className="flex-1 min-h-[44px] rounded-[8px] bg-[var(--blue,#244C8A)] text-[var(--bg,#fff)] text-[13px] font-semibold disabled:opacity-50 cursor-pointer border-0"
            >
              {p.requesting ? 'Requesting...' : 'Request campus'}
            </button>
            <button
              type="button"
              onClick={p.onCancelRequest}
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
  value: CampusItem | null;
  onChange: (campus: CampusItem | null) => void;
  label?: string;
  id?: string;
}

/** Searchable campus picker with a "my campus is not listed" request. */
export const CampusPicker: React.FC<CampusPickerProps> = ({ value, onChange, label = 'Campus', id }) => {
  const autoId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const baseId = id ?? `campus-${autoId}`;

  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<CampusItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [cities, setCities] = useState<string[]>([]);
  const [city, setCity] = useState('');
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestCity, setRequestCity] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputWasShown = useRef(false);

  const inputVisible = !value || editing;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/campuses/cities')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { cities?: string[] };
        if (!cancelled) setCities(data.cities || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced search while the list is open
  useEffect(() => {
    if (!inputVisible || !open) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set('q', query.trim());
        if (city) params.set('city', city);
        const res = await fetch(`/api/campuses?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error('Could not load campuses');
        const data = (await res.json()) as { campuses?: CampusItem[] };
        setResults(data.campuses || []);
        setActiveIndex(-1);
        setMessage(null);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setMessage('Could not load campuses. Check your connection and try again.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, city, open, inputVisible]);

  // Move focus to the field when the person chooses to change their campus
  useEffect(() => {
    if (inputVisible && inputWasShown.current) {
      document.getElementById(`${baseId}-input`)?.focus();
    }
    inputWasShown.current = inputVisible;
  }, [inputVisible, baseId]);

  const trimmed = query.trim();
  // Offer "not listed" only once the search has settled, so it is never highlighted before real results arrive
  const canRequest = !loading && trimmed.length >= 2 && !results.some((r) => r.name.toLowerCase() === trimmed.toLowerCase());
  const optionCount = results.length + (canRequest ? 1 : 0);

  const select = (campus: CampusItem) => {
    onChange(campus);
    setEditing(false);
    setOpen(false);
    setRequestOpen(false);
    setQuery('');
    setMessage(null);
  };

  const openRequest = () => {
    setRequestOpen(true);
    setRequestCity(city);
    setOpen(false);
  };

  const submitRequest = async () => {
    setRequesting(true);
    setMessage(null);
    try {
      const res = await fetch('/api/campuses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, city: requestCity.trim() }),
      });
      const data = (await res.json()) as { campus?: CampusItem; error?: string };
      if (!res.ok || !data.campus) throw new Error(data.error || 'Could not request this campus');
      select(data.campus);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setRequesting(false);
    }
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
      else openRequest();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Tab') {
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
      loading={loading}
      results={results}
      activeIndex={activeIndex}
      cities={cities}
      city={city}
      canRequest={canRequest}
      requestOpen={requestOpen}
      requestCity={requestCity}
      requesting={requesting}
      message={message}
      onQueryChange={(v) => {
        setQuery(v);
        setOpen(true);
        setRequestOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onKeyDown={onKeyDown}
      onSelect={select}
      onChange={() => {
        setEditing(true);
        setOpen(true);
      }}
      onCityChange={(v) => {
        setCity(v);
        setOpen(true);
      }}
      onOpenRequest={openRequest}
      onRequestCityChange={setRequestCity}
      onSubmitRequest={submitRequest}
      onCancelRequest={() => setRequestOpen(false)}
    />
  );
};
