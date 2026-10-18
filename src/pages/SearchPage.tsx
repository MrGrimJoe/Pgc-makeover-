import React, { useState, useEffect } from 'react';
import type { PostItem, TrendItem } from '../../shared/schema.ts';
import { PostCard } from '../components/PostCard.tsx';
import { Search, X } from 'lucide-react';

interface SearchPageProps {
  currentUserId: string;
  onViewAuthorProfile: (username: string) => void;
}

interface SuggestedPerson {
  username: string;
  displayName: string;
  className: string;
  isFollowing: boolean;
}

export const SearchPage: React.FC<SearchPageProps> = ({
  currentUserId,
  onViewAuthorProfile,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [scopeTab, setScopeTab] = useState<'my_class' | 'campus' | 'everyone'>('my_class');
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [results, setResults] = useState<PostItem[]>([]);
  const [people, setPeople] = useState<SuggestedPerson[]>([
    { username: 'ayesha.k', displayName: 'ayesha.k', className: 'Class 12-B', isFollowing: false },
    { username: 'hamza.m', displayName: 'hamza.m', className: 'Class 12-A', isFollowing: true },
  ]);
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

  const executeSearch = async (query: string) => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setActiveSearch('');
      return;
    }
    setActiveSearch(q);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=30`);
      if (!res.ok) {
        throw new Error('Search failed');
      }
      const data = (await res.json()) as { posts: PostItem[] };
      setResults(data.posts || []);
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
              onClick={() => setScopeTab(tab)}
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

          {!loading && results.length === 0 && !error && (
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
              <div
                key={t.slug}
                onClick={() => handleTrendClick(t.slug)}
                className="flex items-center gap-3 px-4 py-2.5 min-h-[56px] hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer transition-colors"
              >
                <div className="flex-1">
                  <b className="font-semibold text-[15px] block text-[var(--text,#17233A)]">
                    #{t.slug}
                  </b>
                  <small className="text-[var(--muted,#5B6577)] block text-[13px]">
                    {Math.round(t.score) || 12} posts this week
                  </small>
                </div>
              </div>
            ))
          ) : (
            <div
              onClick={() => handleTrendClick('campus')}
              className="flex items-center gap-3 px-4 py-2.5 min-h-[56px] hover:bg-[var(--bg2,#F8F9FC)] cursor-pointer transition-colors"
            >
              <div className="flex-1">
                <b className="font-semibold text-[15px] block text-[var(--text,#17233A)]">
                  #campus
                </b>
                <small className="text-[var(--muted,#5B6577)] block text-[13px]">
                  18 posts this week
                </small>
              </div>
            </div>
          )}

          {/* Section: People */}
          <h3 className="mx-4 mt-4 mb-1 text-[13px] font-semibold text-[var(--muted,#5B6577)] uppercase tracking-[0.4px]">
            People
          </h3>

          {people.map((person, idx) => (
            <div
              key={person.username}
              className="flex items-center gap-3 px-4 py-2.5 min-h-[56px] hover:bg-[var(--bg2,#F8F9FC)] transition-colors"
            >
              <button
                type="button"
                onClick={() => onViewAuthorProfile(person.username)}
                aria-label={`View profile of @${person.username}`}
                className="w-8 h-8 rounded-full bg-[var(--tint,#EAF0FA)] text-[var(--blue,#244C8A)] flex items-center justify-center font-semibold text-[13px] shrink-0 border-0 p-0 cursor-pointer"
              >
                {person.displayName.slice(0, 2).toUpperCase()}
              </button>
              <div
                className="flex-1 min-w-0 cursor-pointer"
                onClick={() => onViewAuthorProfile(person.username)}
              >
                <b className="font-semibold text-[15px] block text-[var(--text,#17233A)] truncate">
                  {person.displayName}
                </b>
                <small className="text-[var(--muted,#5B6577)] block text-[13px] truncate">
                  {person.className}
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
