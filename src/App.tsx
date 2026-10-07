import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Film, Search, X } from 'lucide-react';

interface VideoRecord {
  id: string;
  code: string;
  title: string;
  metadata: {
    duration?: string | null;
    actresses?: string[];
    studio?: string | null;
    genres?: string[];
    date?: string | null;
    thumbnailUrl?: string | null;
  };
}

const PAGE_SIZE = 24;

export default function App() {
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fetchVideos = useCallback(async (search: string, currentPage: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String((currentPage - 1) * PAGE_SIZE));
      if (search.trim()) params.set('q', search.trim());

      const response = await fetch('/api/videos?' + params.toString());
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load catalog');

      setVideos(data.videos || []);
      setTotal(Number(data.total || 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load catalog');
      setVideos([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchVideos(query, page);
  }, [fetchVideos, query, page]);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput('');
    setQuery('');
    setPage(1);
  };

  const goToPage = (next: number) => {
    const target = Math.min(Math.max(next, 1), totalPages);
    setPage(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-4 sm:px-6">
          <a href="/" className="flex shrink-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold">PJ</div>
            <div className="hidden sm:block">
              <div className="font-semibold">PiratecultJAV</div>
              <div className="text-[11px] text-slate-500">Indexed video catalog</div>
            </div>
          </a>

          <form onSubmit={submitSearch} className="relative ml-auto w-full max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search by code, title or description..."
              className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2.5 pl-10 pr-10 text-sm outline-none focus:border-indigo-500"
              aria-label="Search indexed videos"
            />
            {searchInput && (
              <button type="button" onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200" aria-label="Clear search">
                <X className="h-4 w-4" />
              </button>
            )}
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-7 sm:px-6">
        <div className="mb-7">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{query ? 'Search results' : 'Latest indexed posts'}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {loading ? 'Loading catalog...' : String(total.toLocaleString()) + ' indexed posts'}
            {query ? ' for “' + query + '”' : ''}
          </p>
        </div>

        {error && <div className="mb-6 rounded-xl border border-rose-900/60 bg-rose-950/30 p-4 text-sm text-rose-300">{error}</div>}

        {loading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
                <div className="aspect-[3/4] animate-pulse bg-slate-800" />
                <div className="space-y-2 p-3"><div className="h-4 animate-pulse rounded bg-slate-800" /><div className="h-3 w-2/3 animate-pulse rounded bg-slate-800" /></div>
              </div>
            ))}
          </div>
        ) : videos.length === 0 ? (
          <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 text-center">
            <Film className="mb-3 h-8 w-8 text-slate-600" />
            <h2 className="font-medium text-slate-300">No indexed posts found</h2>
            <p className="mt-1 text-sm text-slate-500">{query ? 'Try another code or search term.' : 'There are no available indexed posts yet.'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {videos.map((video) => {
              const thumbnail = video.metadata?.thumbnailUrl || '';
              const actresses = video.metadata?.actresses || [];
              return (
                <article key={video.id} className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 transition hover:-translate-y-0.5 hover:border-slate-700">
                  <div className="relative aspect-[3/4] overflow-hidden bg-slate-900">
                    {thumbnail ? (
                      <img src={thumbnail} alt={video.title || video.code} loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
                    ) : (
                      <div className="flex h-full items-center justify-center"><Film className="h-10 w-10 text-slate-700" /></div>
                    )}
                    <div className="absolute left-2 top-2 rounded-md bg-slate-950/85 px-2 py-1 font-mono text-[11px] font-semibold text-indigo-300">{video.code}</div>
                  </div>
                  <div className="p-3">
                    <h2 className="line-clamp-2 text-sm font-medium leading-5 text-slate-200" title={video.title}>{video.title || video.code}</h2>
                    {actresses.length > 0 && <p className="mt-1 line-clamp-1 text-xs text-slate-500">{actresses.join(', ')}</p>}
                    {video.metadata?.studio && <p className="mt-1 line-clamp-1 text-xs text-slate-500">Studio: {video.metadata.studio}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-slate-600">
                      {video.metadata?.duration && <span className="rounded bg-slate-800 px-1.5 py-0.5">{video.metadata.duration}</span>}
                      {video.metadata?.date && <span className="rounded bg-slate-800 px-1.5 py-0.5">{video.metadata.date}</span>}
                    </div>
                    {(video.metadata?.genres || []).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(video.metadata?.genres || []).slice(0, 3).map((genre) => (
                          <span key={genre} className="rounded bg-indigo-950/60 px-1.5 py-0.5 text-[10px] text-indigo-300">{genre}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {!loading && totalPages > 1 && (
          <nav className="mt-8 flex items-center justify-center gap-2" aria-label="Catalog pagination">
            <button onClick={() => goToPage(page - 1)} disabled={page <= 1} className="rounded-lg border border-slate-800 p-2 text-slate-400 hover:bg-slate-900 disabled:opacity-30" aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(5, totalPages) }).map((_, index) => {
                let pageNumber = index + 1;
                if (totalPages > 5) {
                  if (page <= 3) pageNumber = index + 1;
                  else if (page >= totalPages - 2) pageNumber = totalPages - 4 + index;
                  else pageNumber = page - 2 + index;
                }
                return (
                  <button key={pageNumber} onClick={() => goToPage(pageNumber)} className={pageNumber === page ? 'min-w-9 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white' : 'min-w-9 rounded-lg border border-slate-800 px-3 py-2 text-sm text-slate-400 hover:bg-slate-900'}>
                    {pageNumber}
                  </button>
                );
              })}
            </div>
            <button onClick={() => goToPage(page + 1)} disabled={page >= totalPages} className="rounded-lg border border-slate-800 p-2 text-slate-400 hover:bg-slate-900 disabled:opacity-30" aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </button>
          </nav>
        )}

        {!loading && total > 0 && <p className="mt-4 text-center text-xs text-slate-600">Page {page} of {totalPages}</p>}
      </main>

      <footer className="border-t border-slate-900 py-8 text-center text-xs text-slate-600">PiratecultJAV · Public indexed catalog</footer>
    </div>
  );
}
