import React, { useState, useEffect } from 'react';
import type { PostItem, TrendItem, SuggestedPersonItem } from '../../shared/schema.ts';
import { PostCard } from '../components/PostCard.tsx';
import { Search, X } from 'lucide-react';
import { Avatar } from '../components/Avatar.tsx';

interface SearchPageProps {
  currentUserId: string;
  /** Whether the signed-in person has set a class / campus, which decides the default tab. */
  hasClass?: boolean;
  hasCampus?: boolean;
  onViewAuthorProfile: (username: string) => void;
}

type ScopeTab = 'my_class' | 'campus' | 'everyone';

const SCOPE_PARAM: Record<ScopeTab, 'class' | 'campus' | 'all'> = {
  my_class: 'class',
  campus: 'campus',
  everyone: 'all',
};

interface SuggestedPerson {
  username: string;
  displayName: string;
  avatarMediaId: string | null;
  /** "Class of 2026 · Central Campus" style line. */
  subtitle: string;
  isFollowing: boolean;
}

export const SearchPage: React.FC<SearchPageProps> = ({
  currentUserId,
  hasClass = true,
  hasCampus = true,
  onViewAuthorProfile,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [scopeTab, setScopeTab] = useState<ScopeTab>(hasClass ? 'my_class' : hasCampus ? 'campus' : 'everyone');
  const [scopeMissing, setScopeMissing] = useState<'class' | 'campus' | null>(null);
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [results, setResults] = useState<PostItem[]>([]);
  // People come only from a real API result (GET /api/people/suggested).
  const [people, setPeople] = useState<SuggestedPerson[]>([]);
  const [peopleLoaded, setPeopleLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/trends?window=24h')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { trends?: TrendItem[] };
        setTrends(data.trends || []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/people/suggested?limit=10')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { people?: SuggestedPersonItem[] };
        if (cancelled) return;
        setPeople(
          (data.people || []).map((p) => ({
            username: p.username,
            displayName: p.display_name,
            avatarMediaId: p.avatar_media_id,
            subtitle: [p.class_name, p.campus_name].filter(Boolean).join(' · '),
            isFollowing: false,
          }))
        );
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPeopleLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const executeSearch = async (query: string, tab: ScopeTab = scopeTab) => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setActiveSearch('');
      setScopeMissing(null);
      return;
    }
    setActiveSearch(q);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=${SCOPE_PARAM[tab]}&limit=30`);
      if (!res.ok) {
        throw new Error('Search failed');
      }
      const data = (await res.json()) as { posts: PostItem[]; scope_missing?: 'class' | 'campus' };
      setResults(data.posts || []);
      setScopeMissing(data.scope_missing ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeSearch(searchQuery);
  };

  const handleClear = () => {
    setSearchQuery('');
    setActiveSearch('');
    setResults([]);
    setScopeMissing(null);
  };

  const handleScopeChange = (tab: ScopeTab) => {
    setScopeTab(tab);
    // Searching again with the new scope keeps what the person typed
    if (activeSearch) executeSearch(activeSearch, tab);
  };

  const handleTrendClick = (slug: string) => {
    setSearchQuery(slug);
    executeSearch(slug);
  };

  const handleTogglePersonFollow = async (index: number, username: string) => {
    const person = people[index];
    if (!person) return;
    const nextFollowing = !person.isFollowing;

    setPeople((prev) =>
      prev.map((p, i) => (i === index ? { ...p, isFollowing: nextFollowing } : p))
    );

    try {
      const method = nextFollowing ? 'POST' : 'DELETE';
      await fetch(`/api/users/${encodeURIComponent(username)}/follow`, { method });
    } catch {
      // Ignore
    }
  };

  return (
    <div className="w-full max-w-[430px] mx-auto pb-16 bg-[var(--bg,#fff)]">
      {/* 44px search field, 12px radius, 1px border, subtle background, search icon at left */}
      <form onSubmit={handleSearchSubmit} className="p-3 pb-2">
        <div className="flex items-center gap-2 bg-[var(--bg2,#F8F9FC)] border border-[var(--line,#E8EBF0)] rounded-[12px] px-3 h-[44px] text-[var(--muted,#5B6577)]">
          <Search className="w-5 h-5 shrink-0 stroke-[1.7]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search people and #topics"
            aria-label="Search people and #topics"
            className="flex-1 border-0 bg-transparent text-[var(--text,#17233A)] text-[15px] outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={handleClear}
              title="Clear search"
              aria-label="Clear search"
              className="text-[var(--muted,#5B6577)] hover:text-[var(--text,#17233A)] cursor-pointer bg-transparent border-0 min-h-[44px] min-w-[44px] flex items-center justify-center p-0 -mr-2"
            >
              <X className="w-4 h-4 stroke-[1.7]" />
            </button>
          )}
        </div>
      </form>

      {/* Scope tabs: My class / Campus / Everyone */}
      <div className="flex border-b border-[var(--line,#E8EBF0)]">
        {(['my_class', 'campus', 'everyone'] as const).map((tab) => {
          const label = tab === 'my_class' ? 'My class' : tab === 'campus' ? 'Campus' : 'Everyone';
          const isActive = scopeTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => handleScopeChange(tab)}
              aria-pressed={isActive}
              className={`flex-1 min-h-[44px] py-3 text-center text-[14px] font-semibold transition-colors cursor-pointer border-b-2 bg-transparent ${
                isActive
                  ? 'text-[var(--text,#17233A)] border-[var(--blue,#244C8A)]'
                  : 'text-[var(--muted,#5B6577)] border-transparent hover:text-[var(--text,#17233A)]'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* When searching: show results */}
      {activeSearch ? (
        <div>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--line,#E8EBF0)] text-[13px] text-[var(--muted,#5B6577)]">
            <span>Results for &ldquo;{activeSearch}&rdquo;</span>
            <button
              type="button"
              onClick={handleClear}
              className="text-[var(--blue,#244C8A)] hover:underline cursor-pointer bg-transparent border-0 p-0"
            >
              Clear
            </button>
          </div>

          {loading && (
            <div className="divide-y divide-[var(--line,#E8EBF0)]">
              {[1, 2].map((i) => (
                <div key={i} className="py-4 px-4 space-y-3">
                  <div className="w-32 h-4 skeleton-box rounded" />
                  <div className="w-full h-4 skeleton-box rounded" />
                </div>
              ))}
            </div>
          )}

          {!loading && scopeMissing && (
            <div className="py-16 text-center text-[13px] text-[var(--muted,#5B6577)] px-4">
              Add your {scopeMissing === 'class' ? 'class' : 'campus'} in Edit profile to search it.
            </div>
          )}

          {!loading && !scopeMissing && results.length === 0 && !error && (
            <div className="py-16 text-center text-[13px] text-[var(--muted,#5B6577)] px-4">
              No results found for &ldquo;{activeSearch}&rdquo;
            </div>
          )}

          {!loading && results.length > 0 && (
            <div>
              {results.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  currentUserId={currentUserId}
                  onViewAuthorProfile={onViewAuthorProfile}
                  onTopicClick={(slug) => {
                    setSearchQuery(slug);
                    executeSearch(slug);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Default Search Screen: Trending & People sections */
        <div className="py-1">
          {/* Section: Trending */}
          <h3 className="mx-4 mt-4 mb-1 text-[13px] font-semibold text-[var(--muted,#5B6577)] uppercase tracking-[0.4px]">
            Trending
          </h3>

          {trends.length > 0 ? (
            trends.slice(0, 5).map((t) => (
              <button
                key={t.slug}
                type="button"
                onClick={() => handleTrendClick(t.slug)}
                className="w-full text-left flex items-center gap-3 px-4 py-2.5 min-h-[56px] hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer transition-colors bg-transparent border-0"
              >
                <b className="font-semibold text-[15px] block text-[var(--text,#17233A)]">
                  #{t.slug}
                </b>
              </button>
            ))
          ) : (
            <p className="mx-4 my-3 text-[13px] text-[var(--muted,#5B6577)]">
              No trending topics yet
            </p>
          )}

          {/* Section: People */}
          <h3 className="mx-4 mt-4 mb-1 text-[13px] font-semibold text-[var(--muted,#5B6577)] uppercase tracking-[0.4px]">
            People
          </h3>

          {people.length === 0 && (
            <p className="mx-4 my-3 text-[13px] text-[var(--muted,#5B6577)]">
              {!peopleLoaded
                ? 'Loading...'
                : hasClass || hasCampus
                  ? 'No people to show'
                  : 'Add your class and campus in Edit profile to see people near you'}
            </p>
          )}

          {people.map((person, idx) => (
            <div
              key={person.username}
              className="flex items-center gap-3 px-4 py-2.5 min-h-[56px] hover:bg-[var(--bg2,#F8F9FC)] transition-colors"
            >
              <button
                type="button"
                onClick={() => onViewAuthorProfile(person.username)}
                aria-label={`View profile of @${person.username}`}
                className="shrink-0 border-0 p-0 bg-transparent cursor-pointer rounded-full"
              >
                <Avatar mediaId={person.avatarMediaId} displayName={person.displayName} username={person.username} size={32} />
              </button>
              <div
                className="flex-1 min-w-0 cursor-pointer"
                onClick={() => onViewAuthorProfile(person.username)}
              >
                <b className="font-semibold text-[15px] block text-[var(--text,#17233A)] truncate">
                  {person.displayName}
                </b>
                <small className="text-[var(--muted,#5B6577)] block text-[13px] truncate">
                  {person.subtitle}
                </small>
              </div>
              <button
                type="button"
                onClick={() => handleTogglePersonFollow(idx, person.username)}
                className={`min-h-[44px] px-3.5 rounded-[8px] text-[13px] font-semibold transition-colors cursor-pointer flex items-center justify-center ${
                  person.isFollowing
                    ? 'border border-[var(--line,#E8EBF0)] bg-[var(--bg,#fff)] text-[var(--text,#17233A)]'
                    : 'bg-[var(--blue,#244C8A)] border border-[var(--blue,#244C8A)] text-white'
                }`}
              >
                {person.isFollowing ? 'Following' : 'Follow'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
