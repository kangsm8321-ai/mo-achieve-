import { GoogleGenAI } from '@google/genai';

export interface MediaSearchResult {
  title: string;
  genres: string[];
  coverUrl: string | null;
  externalUrl: string | null;
  summary?: string;
}

export async function searchMedia(title: string, type: 'anime' | 'movie' | 'drama' | 'novel'): Promise<MediaSearchResult> {
  let coverUrl: string | null = null;
  let externalUrl: string | null = null;
  let summary = '';
  let genres: string[] = [];

  const typeLabels: Record<string, string> = {
    movie: '영화',
    drama: '드라마',
    anime: '애니메이션',
    novel: '소설',
  };
  const typeLabel = typeLabels[type] || '작품';

  // 1. Wikipedia Article & Image Search
  try {
    const queries = [`${title} (${typeLabel})`, `${title} ${typeLabel}`, title];

    for (const q of queries) {
      const wUrl =
        'https://ko.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=' +
        encodeURIComponent(q) +
        '&gsrlimit=3&prop=images|info|extracts&inprop=url&exintro=1&explaintext=1';

      const wRes = await fetch(wUrl, { signal: AbortSignal.timeout(6000) });
      const wData = (await wRes.json().catch(() => ({}))) as any;
      const pages = Object.values(wData.query?.pages || {}) as any[];
      const matched = pages.find((p) => p.title.includes(title)) || pages[0];

      if (matched) {
        externalUrl = matched.fullurl || externalUrl;
        if (matched.extract && !summary) {
          summary = matched.extract.slice(0, 300);
        }

        const imgs = (matched.images || []) as any[];
        const poster =
          imgs.find((i) => /포스터|poster|표지|cover/i.test(i.title)) ||
          imgs.find((i) => /\.(jpg|png|webp)$/i.test(i.title) && !/icon|logo|commons|picto|flag|stub/i.test(i.title));

        if (poster) {
          const infoUrl =
            'https://ko.wikipedia.org/w/api.php?action=query&titles=' +
            encodeURIComponent(poster.title) +
            '&prop=imageinfo&iiprop=url&format=json';
          const infoRes = await fetch(infoUrl, { signal: AbortSignal.timeout(4000) });
          const infoData = (await infoRes.json().catch(() => ({}))) as any;
          const p = Object.values(infoData.query?.pages || {})[0] as any;
          coverUrl = p?.imageinfo?.[0]?.url || null;
          if (coverUrl) break;
        }
      }
    }
  } catch {
    // Continue even if wiki fetch fails
  }

  // 2. Specific Wikipedia Image Files search if no poster found yet
  if (!coverUrl) {
    try {
      const fileSearchUrl =
        'https://ko.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=' +
        encodeURIComponent(`${title} 포스터`) +
        '&gsrnamespace=6&gsrlimit=2&prop=imageinfo&iiprop=url';
      const fRes = await fetch(fileSearchUrl, { signal: AbortSignal.timeout(4000) });
      const fData = (await fRes.json().catch(() => ({}))) as any;
      const fPages = Object.values(fData.query?.pages || {}) as any[];
      if (fPages.length && fPages[0]?.imageinfo?.[0]?.url) {
        coverUrl = fPages[0].imageinfo[0].url;
      }
    } catch {
      // Continue
    }
  }

  // 3. For books/novels: try Google Books API if coverUrl not yet found
  if (type === 'novel' && !coverUrl) {
    try {
      const bUrl = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(title) + '&maxResults=1';
      const bRes = await fetch(bUrl, { signal: AbortSignal.timeout(4000) });
      const bData = (await bRes.json().catch(() => ({}))) as any;
      const vol = bData?.items?.[0]?.volumeInfo;
      if (vol) {
        const thumb = vol.imageLinks?.thumbnail || vol.imageLinks?.smallThumbnail;
        if (thumb) {
          coverUrl = thumb.replace(/^http:/, 'https:');
        }
        if (vol.categories?.length && !genres.length) {
          genres = vol.categories.slice(0, 3);
        }
      }
    } catch {
      // Continue
    }
  }

  // 4. Recommend genres with Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const res = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: `작품 "${title}" (종류: ${typeLabel})의 한국어 대표 장르 목록 2~4개만 JSON 배열로 반환해줘. 예: ["액션", "판타지", "모험"]`,
        config: { responseMimeType: 'application/json' },
      });
      const parsed = JSON.parse(res.text?.trim() || '[]');
      if (Array.isArray(parsed) && parsed.length) {
        genres = parsed.slice(0, 5).map((g) => String(g).slice(0, 20));
      }
    } catch {
      // Fallback below
    }
  }

  // 5. Fallback genres extraction from Wikipedia summary if Gemini was not available
  if (!genres.length && summary) {
    const KNOWN_GENRES = [
      '액션', '판타지', '로맨스', '코미디', '스릴러', 'SF', '공포', '호러',
      '미스터리', '드라마', '일상', '모험', '추리', '학원', '범죄', '다큐멘터리',
      '무협', '스포츠', '역사', '서스펜스', '블랙 코미디', '음악', '치유', '가족'
    ];
    genres = KNOWN_GENRES.filter((g) => summary.includes(g)).slice(0, 4);
  }

  return {
    title,
    genres,
    coverUrl,
    externalUrl,
    summary,
  };
}
