import { useEffect, useState, useMemo } from 'react';
import {
  Search,
  Star,
  Film,
  Tv,
  BookOpen,
  Sparkles,
  ExternalLink,
  X,
  Server,
  Layers,
  Calendar,
  MessageSquare,
  Lock,
  RefreshCw,
  Clock,
  CheckCircle2,
  Bookmark,
  Award
} from 'lucide-react';

interface MediaItem {
  id: string;
  userId: number;
  title: string;
  type: 'anime' | 'movie' | 'drama' | 'novel';
  status: 'planned' | 'in_progress' | 'completed' | 'dropped' | 'paused';
  genres: string[];
  rating: number | null;
  review: string;
  progress: number | null;
  totalProgress: number | null;
  coverUrl: string | null;
  externalUrl: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const TYPE_CONFIG = {
  anime: { label: '애니메이션', icon: Sparkles, color: 'text-indigo-600 bg-indigo-50 border-indigo-200' },
  movie: { label: '영화', icon: Film, color: 'text-rose-600 bg-rose-50 border-rose-200' },
  drama: { label: '드라마', icon: Tv, color: 'text-amber-600 bg-amber-50 border-amber-200' },
  novel: { label: '소설', icon: BookOpen, color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
};

const STATUS_CONFIG = {
  completed: { label: '완료', color: 'bg-emerald-100 text-emerald-800' },
  in_progress: { label: '진행 중', color: 'bg-blue-100 text-blue-800' },
  planned: { label: '보고 싶음', color: 'bg-neutral-100 text-neutral-700' },
  paused: { label: '보류', color: 'bg-amber-100 text-amber-800' },
  dropped: { label: '중단', color: 'bg-red-100 text-red-700' },
};

export default function App() {
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Filters & Search
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'created' | 'rating' | 'title'>('created');
  
  // Modal for Viewing Review and Details
  const [activeMedia, setActiveMedia] = useState<MediaItem | null>(null);

  // Health modal toggle
  const [showHealth, setShowHealth] = useState(false);
  const [healthData, setHealthData] = useState<any>(null);

  const fetchMedia = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/media');
      const data = await res.json();
      if (data.ok && Array.isArray(data.media)) {
        setMediaList(data.media);
      } else {
        throw new Error(data.error || '목록을 불러오지 못했습니다.');
      }
    } catch (e: any) {
      setError(e.message || '네트워크 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const fetchHealth = async () => {
    try {
      const res = await fetch('/health');
      const data = await res.json();
      setHealthData(data);
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    fetchMedia();
    fetchHealth();
  }, []);

  // Filtered & Sorted items
  const filteredList = useMemo(() => {
    return mediaList
      .filter((item) => {
        if (selectedType !== 'all' && item.type !== selectedType) return false;
        if (selectedStatus !== 'all' && item.status !== selectedStatus) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase().trim();
          const matchesTitle = item.title?.toLowerCase().includes(q);
          const matchesReview = item.review?.toLowerCase().includes(q);
          const matchesGenres = (item.genres || []).some((g) => g.toLowerCase().includes(q));
          if (!matchesTitle && !matchesReview && !matchesGenres) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'rating') {
          return (b.rating ?? -1) - (a.rating ?? -1);
        }
        if (sortBy === 'title') {
          return a.title.localeCompare(b.title, 'ko');
        }
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      });
  }, [mediaList, selectedType, selectedStatus, searchQuery, sortBy]);

  // Statistics
  const stats = useMemo(() => {
    const total = mediaList.length;
    const completed = mediaList.filter((m) => m.status === 'completed').length;
    const inProgress = mediaList.filter((m) => m.status === 'in_progress').length;
    const rated = mediaList.filter((m) => typeof m.rating === 'number');
    const avgRating = rated.length
      ? (rated.reduce((sum, m) => sum + (m.rating || 0), 0) / rated.length).toFixed(1)
      : null;
    return { total, completed, inProgress, avgRating };
  }, [mediaList]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: mediaList.length, anime: 0, movie: 0, drama: 0, novel: 0 };
    mediaList.forEach((m) => {
      if (counts[m.type] !== undefined) counts[m.type]++;
    });
    return counts;
  }, [mediaList]);

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100 flex flex-col font-sans">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 bg-neutral-900/90 backdrop-blur-md border-b border-neutral-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-amber-500 to-indigo-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/20 font-bold">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-lg tracking-tight text-white">My Media Archive</h1>
                <span className="text-[10px] uppercase font-semibold tracking-wider px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                  Read Only
                </span>
              </div>
              <p className="text-xs text-neutral-400 hidden sm:block">텔레그램 봇으로 기록한 나만의 미디어 서재 &amp; 감상평</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                fetchHealth();
                setShowHealth(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-300 transition-colors cursor-pointer"
            >
              <Server className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden sm:inline">서버/봇 상태</span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            </button>

            <button
              onClick={fetchMedia}
              disabled={loading}
              title="새로고침"
              className="p-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Banner with Stats */}
        <section className="mb-8 p-6 rounded-2xl bg-gradient-to-br from-neutral-800/90 to-neutral-850 border border-neutral-800 relative overflow-hidden shadow-xl">
          <div className="absolute top-0 right-0 -mt-10 -mr-10 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>
          
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-400 mb-1">
                <Sparkles className="w-4 h-4" />
                <span>Personal Media Showcase</span>
              </div>
              <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                나만의 감상 도감
              </h2>
              <p className="text-sm text-neutral-400 mt-1 max-w-xl">
                텔레그램 봇에서 등록한 애니메이션, 영화, 드라마, 소설과 작성한 감상평을 한눈에 열람할 수 있는 온라인 서재입니다.
              </p>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-neutral-900/80 border border-neutral-750 px-4 py-3 rounded-xl">
                <div className="text-xs text-neutral-400 font-medium">총 보관 작품</div>
                <div className="text-2xl font-bold text-white mt-0.5 tabular-nums">{stats.total}개</div>
              </div>
              <div className="bg-neutral-900/80 border border-neutral-750 px-4 py-3 rounded-xl">
                <div className="text-xs text-neutral-400 font-medium">완료한 작품</div>
                <div className="text-2xl font-bold text-emerald-400 mt-0.5 tabular-nums">{stats.completed}개</div>
              </div>
              <div className="bg-neutral-900/80 border border-neutral-750 px-4 py-3 rounded-xl">
                <div className="text-xs text-neutral-400 font-medium">진행 중</div>
                <div className="text-2xl font-bold text-sky-400 mt-0.5 tabular-nums">{stats.inProgress}개</div>
              </div>
              <div className="bg-neutral-900/80 border border-neutral-750 px-4 py-3 rounded-xl">
                <div className="text-xs text-neutral-400 font-medium">평균 평점</div>
                <div className="text-2xl font-bold text-amber-400 mt-0.5 tabular-nums flex items-center gap-1">
                  {stats.avgRating ? `★ ${stats.avgRating}` : '-'}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Filter & Controls Bar */}
        <section className="mb-8 space-y-4">
          {/* Top row: Type Tabs & Search */}
          <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
            {/* Type selector tabs */}
            <div className="flex items-center gap-1.5 p-1 bg-neutral-800/80 border border-neutral-750 rounded-xl overflow-x-auto scrollbar-none">
              {[
                { id: 'all', label: '전체', icon: Layers },
                { id: 'anime', label: '애니', icon: Sparkles },
                { id: 'movie', label: '영화', icon: Film },
                { id: 'drama', label: '드라마', icon: Tv },
                { id: 'novel', label: '소설', icon: BookOpen },
              ].map((tab) => {
                const Icon = tab.icon;
                const active = selectedType === tab.id;
                const count = typeCounts[tab.id] ?? 0;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setSelectedType(tab.id)}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium transition-all whitespace-nowrap cursor-pointer ${
                      active
                        ? 'bg-neutral-700 text-white shadow-xs font-semibold'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-750/50'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{tab.label}</span>
                    <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${active ? 'bg-neutral-900 text-neutral-300' : 'bg-neutral-850 text-neutral-500'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Search Input */}
            <div className="relative flex-1 lg:max-w-md">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                type="text"
                placeholder="제목, 감상평, 장르 태그로 검색..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-neutral-800/80 border border-neutral-750 rounded-xl pl-10 pr-4 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Sub Filters: Status and Sorting */}
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-400 pt-2 border-t border-neutral-800">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium mr-1 text-neutral-500">상태:</span>
              {[
                { id: 'all', label: '전체' },
                { id: 'completed', label: '완료' },
                { id: 'in_progress', label: '진행 중' },
                { id: 'planned', label: '보고 싶음' },
                { id: 'paused', label: '보류' },
                { id: 'dropped', label: '중단' },
              ].map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedStatus(s.id)}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    selectedStatus === s.id
                      ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 font-semibold'
                      : 'hover:bg-neutral-800 text-neutral-400'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-neutral-500">정렬:</span>
              <select
                value={sortBy}
                onChange={(e: any) => setSortBy(e.target.value)}
                className="bg-neutral-800 border border-neutral-750 text-neutral-300 rounded-lg px-2.5 py-1 text-xs focus:outline-none cursor-pointer"
              >
                <option value="created">최신 등록순</option>
                <option value="rating">평점 높은순</option>
                <option value="title">가나다순</option>
              </select>
            </div>
          </div>
        </section>

        {/* Gallery Grid */}
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="animate-pulse bg-neutral-800/50 rounded-2xl p-3 border border-neutral-800 aspect-[3/4] flex flex-col justify-end">
                <div className="h-4 bg-neutral-700/60 rounded mb-2 w-3/4"></div>
                <div className="h-3 bg-neutral-700/40 rounded w-1/2"></div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-8 text-center bg-red-950/20 border border-red-800/40 rounded-2xl my-8">
            <p className="text-red-400 font-medium mb-3">{error}</p>
            <button
              onClick={fetchMedia}
              className="px-4 py-2 text-xs font-semibold bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg transition-colors cursor-pointer"
            >
              다시 시도
            </button>
          </div>
        ) : filteredList.length === 0 ? (
          <div className="text-center py-16 px-4 bg-neutral-850/50 border border-neutral-800 rounded-2xl">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-500">
              <Bookmark className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-neutral-200 mb-1">
              {searchQuery || selectedType !== 'all' || selectedStatus !== 'all'
                ? '조건에 맞는 작품이 없습니다.'
                : '아직 등록된 작품이 없습니다.'}
            </h3>
            <p className="text-xs text-neutral-400 max-w-md mx-auto mb-6">
              {searchQuery || selectedType !== 'all' || selectedStatus !== 'all'
                ? '검색어나 필터 조건을 변경하여 다시 확인해 보세요.'
                : '텔레그램 봇에서 /start 를 누른 뒤 「작품 등록」 메뉴로 첫 작품과 감상평을 기록해 보세요!'}
            </p>
            {(searchQuery || selectedType !== 'all' || selectedStatus !== 'all') && (
              <button
                onClick={() => {
                  setSelectedType('all');
                  setSelectedStatus('all');
                  setSearchQuery('');
                }}
                className="px-4 py-2 text-xs font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg transition-colors cursor-pointer"
              >
                필터 초기화
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredList.map((item) => {
              const typeInfo = TYPE_CONFIG[item.type] || TYPE_CONFIG.movie;
              const statusInfo = STATUS_CONFIG[item.status] || STATUS_CONFIG.planned;
              const TypeIcon = typeInfo.icon;
              const hasReview = Boolean(item.review?.trim());

              return (
                <div
                  key={item.id}
                  onClick={() => setActiveMedia(item)}
                  className="group relative bg-neutral-850 border border-neutral-800 hover:border-neutral-700 rounded-2xl overflow-hidden flex flex-col transition-all duration-200 hover:-translate-y-1 hover:shadow-xl hover:shadow-neutral-950/40 cursor-pointer"
                >
                  {/* Poster / Cover Image Container (3:4 aspect ratio) */}
                  <div className="relative w-full aspect-[3/4] bg-neutral-900 overflow-hidden">
                    {item.coverUrl ? (
                      <img
                        src={item.coverUrl}
                        alt={item.title}
                        loading="lazy"
                        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                        onError={(e: any) => {
                          e.target.style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-neutral-800 to-neutral-900 flex flex-col items-center justify-center p-4 text-center">
                        <TypeIcon className="w-10 h-10 text-neutral-600 mb-2" />
                        <span className="text-xs font-medium text-neutral-500 line-clamp-2 px-2">
                          {item.title}
                        </span>
                      </div>
                    )}

                    {/* Gradient Overlay for Text readability */}
                    <div className="absolute inset-0 bg-gradient-to-t from-neutral-900 via-transparent to-black/40"></div>

                    {/* Badges on Top */}
                    <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between pointer-events-none">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md flex items-center gap-1 shadow-sm backdrop-blur-sm border ${typeInfo.color}`}>
                        <TypeIcon className="w-3 h-3" />
                        {typeInfo.label}
                      </span>

                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-md shadow-sm backdrop-blur-sm ${statusInfo.color}`}>
                        {statusInfo.label}
                      </span>
                    </div>

                    {/* Rating badge bottom right */}
                    <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1 bg-black/75 backdrop-blur-md px-2 py-0.5 rounded-lg border border-neutral-800 text-xs font-bold text-amber-400">
                      <Star className="w-3 h-3 fill-amber-400" />
                      <span>{typeof item.rating === 'number' ? item.rating.toFixed(1) : '-'}</span>
                    </div>

                    {/* Review Badge indicator */}
                    {hasReview && (
                      <div className="absolute bottom-2.5 left-2.5 bg-indigo-600/80 backdrop-blur-md p-1 rounded-md text-white shadow-xs" title="감상평 작성됨">
                        <MessageSquare className="w-3 h-3" />
                      </div>
                    )}
                  </div>

                  {/* Card Content */}
                  <div className="p-3.5 flex-1 flex flex-col justify-between">
                    <div>
                      <h4 className="font-bold text-sm text-neutral-100 group-hover:text-indigo-400 transition-colors line-clamp-1 mb-1">
                        {item.title}
                      </h4>

                      {/* Genre chips */}
                      <div className="flex flex-wrap gap-1 mb-2">
                        {(item.genres || []).slice(0, 2).map((g, idx) => (
                          <span
                            key={idx}
                            className="text-[10px] text-neutral-400 bg-neutral-800 px-1.5 py-0.5 rounded"
                          >
                            #{g}
                          </span>
                        ))}
                      </div>

                      {/* Short review teaser */}
                      {hasReview && (
                        <p className="text-[11px] text-neutral-400 line-clamp-2 italic font-serif bg-neutral-900/60 p-1.5 rounded-md border border-neutral-800/60 mb-2">
                          &ldquo;{item.review}&rdquo;
                        </p>
                      )}
                    </div>

                    {/* Footer progress & date */}
                    <div className="pt-2 border-t border-neutral-800/80 flex items-center justify-between text-[11px] text-neutral-500">
                      <span>
                        {item.progress !== null
                          ? `${item.progress}${item.totalProgress ? `/${item.totalProgress}` : ''} ${item.type === 'novel' ? '권' : '화'}`
                          : item.type === 'movie' ? '영화' : '-'}
                      </span>
                      <span>
                        {item.completedAt ? item.completedAt.slice(0, 10) : item.createdAt.slice(0, 10)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Review & Details Modal */}
      {activeMedia && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-neutral-900 border border-neutral-750 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-850">
              <div className="flex items-center gap-2 text-xs font-semibold text-neutral-400">
                <Bookmark className="w-4 h-4 text-indigo-400" />
                <span>작품 상세 및 감상평 (읽기 전용)</span>
              </div>
              <button
                onClick={() => setActiveMedia(null)}
                className="p-1 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-6">
              {/* Media Summary Top */}
              <div className="flex flex-col sm:flex-row gap-5 items-start">
                {/* Poster */}
                <div className="w-32 sm:w-40 aspect-[3/4] bg-neutral-800 rounded-xl overflow-hidden shrink-0 border border-neutral-750 shadow-md">
                  {activeMedia.coverUrl ? (
                    <img
                      src={activeMedia.coverUrl}
                      alt={activeMedia.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center text-neutral-500">
                      <Layers className="w-8 h-8 mb-2" />
                      <span className="text-xs">표지 없음</span>
                    </div>
                  )}
                </div>

                {/* Details */}
                <div className="flex-1 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-md border ${TYPE_CONFIG[activeMedia.type]?.color}`}>
                      {TYPE_CONFIG[activeMedia.type]?.label}
                    </span>
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-md ${STATUS_CONFIG[activeMedia.status]?.color}`}>
                      {STATUS_CONFIG[activeMedia.status]?.label}
                    </span>
                    {activeMedia.rating !== null && (
                      <span className="text-xs font-bold text-amber-400 bg-amber-950/40 border border-amber-800/50 px-2 py-0.5 rounded-md flex items-center gap-1">
                        <Star className="w-3 h-3 fill-amber-400" />
                        {activeMedia.rating} / 10
                      </span>
                    )}
                  </div>

                  <h3 className="text-2xl font-black text-white tracking-tight leading-snug">
                    {activeMedia.title}
                  </h3>

                  {/* Genres */}
                  {activeMedia.genres?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {activeMedia.genres.map((g, idx) => (
                        <span key={idx} className="text-xs bg-neutral-800 text-neutral-300 px-2 py-0.5 rounded-md">
                          #{g}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Progress & Dates */}
                  <div className="grid grid-cols-2 gap-2 text-xs text-neutral-400 pt-2 border-t border-neutral-800">
                    <div>
                      <span className="text-neutral-500 block">진행도:</span>
                      <span className="font-medium text-neutral-200">
                        {activeMedia.progress !== null
                          ? `${activeMedia.progress}${activeMedia.totalProgress ? ` / ${activeMedia.totalProgress}` : ''} ${activeMedia.type === 'novel' ? '권' : '화'}`
                          : '-'}
                      </span>
                    </div>
                    <div>
                      <span className="text-neutral-500 block">등록일:</span>
                      <span className="font-medium text-neutral-200">{activeMedia.createdAt.slice(0, 10)}</span>
                    </div>
                    {activeMedia.completedAt && (
                      <div>
                        <span className="text-neutral-500 block">완료일:</span>
                        <span className="font-medium text-emerald-400">{activeMedia.completedAt.slice(0, 10)}</span>
                      </div>
                    )}
                    {activeMedia.externalUrl && (
                      <div>
                        <span className="text-neutral-500 block">외부 정보:</span>
                        <a
                          href={activeMedia.externalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-400 hover:underline flex items-center gap-1"
                        >
                          공식 링크 <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Dedicated Review Section */}
              <div className="space-y-2 pt-2">
                <div className="flex items-center gap-2 text-sm font-bold text-neutral-200">
                  <MessageSquare className="w-4 h-4 text-indigo-400" />
                  <span>내 감상평 (Review)</span>
                </div>

                <div className="bg-neutral-800/60 border border-neutral-750 rounded-xl p-5 relative">
                  {activeMedia.review?.trim() ? (
                    <p className="text-sm sm:text-base leading-relaxed text-neutral-200 whitespace-pre-wrap font-serif">
                      {activeMedia.review}
                    </p>
                  ) : (
                    <p className="text-sm text-neutral-500 italic">
                      작성된 감상평이 없습니다. 텔레그램 봇에서 상세 화면을 열어 「감상평 수정」으로 남기실 수 있습니다.
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Modal Footer with Read-only notice */}
            <div className="px-6 py-3.5 bg-neutral-850 border-t border-neutral-800 flex items-center justify-between text-xs text-neutral-400">
              <div className="flex items-center gap-1.5 text-neutral-400">
                <Lock className="w-3.5 h-3.5 text-amber-500" />
                <span>웹사이트는 감상평 열람 전용입니다 (수정은 텔레그램 봇에서 진행).</span>
              </div>
              <button
                onClick={() => setActiveMedia(null)}
                className="px-4 py-1.5 bg-neutral-750 hover:bg-neutral-700 text-white rounded-lg transition-colors cursor-pointer"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Server & Health Modal */}
      {showHealth && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-neutral-900 border border-neutral-750 w-full max-w-lg rounded-2xl shadow-2xl p-6">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-neutral-800">
              <div className="flex items-center gap-2">
                <Server className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-base text-white">서버 및 텔레그램 봇 연동 상태</h3>
              </div>
              <button
                onClick={() => setShowHealth(false)}
                className="text-neutral-400 hover:text-neutral-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="p-3 bg-neutral-800/80 rounded-xl border border-neutral-750">
                <span className="text-xs text-neutral-400 block mb-1">Firestore DB</span>
                <span className="text-sm font-bold text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> 연결 정상 (OK)
                </span>
              </div>
              <div className="p-3 bg-neutral-800/80 rounded-xl border border-neutral-750">
                <span className="text-xs text-neutral-400 block mb-1">텔레그램 봇</span>
                <span className="text-sm font-bold text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> 실시간 수신 활성화
                </span>
              </div>
            </div>

            <div className="bg-neutral-950 p-4 rounded-xl font-mono text-xs text-neutral-300 overflow-x-auto mb-6">
              <pre>{JSON.stringify(healthData, null, 2)}</pre>
            </div>

            <button
              onClick={() => setShowHealth(false)}
              className="w-full py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-xl text-xs font-semibold transition-colors cursor-pointer"
            >
              확인 완료
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
