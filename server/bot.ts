import { col, db, now, fsCode, isDbOutage, FieldValue } from './db.ts';
import { tg, sendDocument, downloadFile, TgError } from './telegram';
import { config } from './config';
import { log, uidTag } from './log';
import { searchMedia } from './search.ts';

/* ---------- 상수·타입 ---------- */
const TYPES = { anime: '애니메이션', movie: '영화', drama: '드라마', novel: '소설' } as const;
const STATUSES = { planned: '보고 싶음', in_progress: '진행 중', completed: '완료', dropped: '중단', paused: '보류' } as const;
type MType = keyof typeof TYPES; type MStatus = keyof typeof STATUSES;
const TYPE_KEYS = Object.keys(TYPES) as MType[];
const STATUS_KEYS = Object.keys(STATUSES) as MStatus[];
const unit = (t?: MType) => (t === 'novel' ? '권' : t === 'movie' || !t ? null : '화');
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE = 8;

interface Media {
  id: string; userId: number; title: string; type: MType; status: MStatus; genres: string[];
  rating: number | null; review: string; progress: number | null; totalProgress: number | null;
  coverUrl: string | null; externalUrl: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
}
interface Filters { q?: string; type?: MType; status?: MStatus; genre?: string; min?: number; max?: number; sort?: 'created' | 'rating' }
interface Session {
  step?: string; draft?: Partial<Media> & { draftId: string };
  mediaId?: string; collectionId?: string; filters?: Filters; mode?: 'list' | 'wish'; restoreFileId?: string;
}
type Ctx = { uid: number; chatId: number; messageId?: number };
type Btn = [string, string];
type Row = any[];
type KbInput = any;

/* ---------- 공통 유틸 ---------- */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function buildKeyboard(markup?: KbInput) {
  if (!markup || !Array.isArray(markup) || !markup.length) return undefined;
  const first = markup[0];
  let rows: Btn[][];
  if (Array.isArray(first) && typeof first[0] === 'string' && typeof first[1] === 'string') {
    rows = [markup as Btn[]];
  } else {
    rows = markup.map((item: any) => {
      if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
        return [item as Btn];
      }
      return Array.isArray(item) ? item : [];
    });
  }
  return { inline_keyboard: rows.map(r => r.map(([text, callback_data]) => ({ text, callback_data }))) };
}
const kb = (rows: KbInput) => buildKeyboard(rows);
const short = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function show(ctx: Ctx, text: string, rows?: KbInput) {
  const reply_markup = rows ? buildKeyboard(rows) : undefined;
  if (ctx.messageId) {
    try {
      await tg('editMessageText', { chat_id: ctx.chatId, message_id: ctx.messageId, text, parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } });
      return;
    } catch (e) {
      if (e instanceof TgError && e.description.includes('not modified')) return;
    }
  }
  await tg('sendMessage', { chat_id: ctx.chatId, text, parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } });
}
const send = (ctx: Ctx, text: string, rows?: KbInput) => show({ ...ctx, messageId: undefined }, text, rows);

async function getSession(uid: number): Promise<Session> {
  const s = await col.users().doc(String(uid)).get();
  return (s.data()?.session as Session) ?? {};
}
async function setSession(uid: number, session: Session) {
  await col.users().doc(String(uid)).set({ userId: uid, session, updatedAt: now() }, { mergeFields: ['userId', 'session', 'updatedAt'] });
}
async function logActivity(uid: number, mediaId: string, action: string, detail = '') {
  try { await col.logs().add({ userId: uid, mediaId, action, detail: detail.slice(0, 300), createdAt: now() }); }
  catch (e) { log.error('activity_log_failed', e, { user: uidTag(uid) }); }
}
async function getOwned(uid: number, id: string): Promise<Media | null> {
  if (!ID_RE.test(id)) return null;
  const s = await col.media().doc(id).get();
  const d = s.data();
  return s.exists && d?.userId === uid ? ({ ...d, id: s.id } as Media) : null;
}
async function loadMedia(uid: number, f: Filters = {}): Promise<Media[]> {
  let q: any = col.media().where('userId', '==', uid);
  if (f.type) q = q.where('type', '==', f.type);
  if (f.status) q = q.where('status', '==', f.status);
  const snap = await q.get();
  return snap.docs.map((d: any) => ({ ...(d.data() as Media), id: d.id }));
}
function applyFilters(items: Media[], f: Filters): Media[] {
  let r = items;
  if (f.q) { const q = f.q.toLowerCase(); r = r.filter(m => m.title.toLowerCase().includes(q)); }
  if (f.genre) { const g = f.genre.toLowerCase(); r = r.filter(m => (m.genres ?? []).some(x => x.toLowerCase() === g)); }
  if (f.min != null || f.max != null) {
    r = r.filter(m => typeof m.rating === 'number' && m.rating >= (f.min ?? 0) && m.rating <= (f.max ?? 10));
  }
  return [...r].sort((a, b) => {
    if (f.sort === 'rating') {
      const ar = a.rating ?? -1, br = b.rating ?? -1;
      if (ar !== br) return br - ar;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/* ---------- 입력 검증 ---------- */
const CTRL = /[\u0000-\u001f\u007f]/;
function vTitle(s: string) { const t = s.trim(); return t.length >= 1 && t.length <= 200 && !CTRL.test(t) ? t : null; }
function vRating(s: string): number | null | 'invalid' {
  const t = s.trim();
  if (['없음', '미평가', '-'].includes(t)) return null;
  if (!/^\d{1,2}(\.\d)?$/.test(t)) return 'invalid';
  const n = Number(t); return n >= 0 && n <= 10 ? n : 'invalid';
}
function vGenres(s: string) {
  const g = [...new Set(s.split(/[,，]/).map(x => x.trim()).filter(Boolean))];
  return g.length <= 10 && g.every(x => x.length <= 30 && !CTRL.test(x)) ? g : null;
}
function vProgress(s: string): { progress: number; totalProgress: number | null } | null {
  const m = s.trim().match(/^(\d{1,5})(?:\s*\/\s*(\d{1,5}))?$/);
  if (!m) return null;
  const p = Number(m[1]), t = m[2] ? Number(m[2]) : null;
  return t != null && p > t ? null : { progress: p, totalProgress: t };
}

/* ---------- 화면 ---------- */
const MAIN: Row[] = [
  [['작품 등록', 'm:add'], ['작품 검색', 'm:search']],
  [['내 도감', 'm:all'], ['보고 싶은 작품', 'm:wish']],
  [['통계', 'm:stats'], ['설정', 'm:set']],
];
const home = (ctx: Ctx, note = '') => show(ctx, `${note}<b>My Media Archive</b>\n메뉴를 선택하세요.`, MAIN);

function fmt(m: Partial<Media>): string {
  const u = unit(m.type);
  const prog = m.progress == null ? '-' : `${m.progress}${m.totalProgress != null ? ' / ' + m.totalProgress : ''} ${u}`;
  const imgTag = m.coverUrl ? `<a href="${esc(m.coverUrl)}">&#8205;</a>` : '';
  return [
    `${imgTag}<b>${esc(m.title || '(제목 없음)')}</b>`,
    `종류: ${m.type ? TYPES[m.type] : '-'}`,
    `상태: ${STATUSES[m.status ?? 'planned']}`,
    `장르: ${m.genres?.length ? esc(m.genres.join(', ')) : '-'}`,
    `평점: ${typeof m.rating === 'number' ? `${m.rating} / 10` : '미평가'}`,
    u ? `진행도: ${prog}` : null,
    `감상평: ${m.review ? esc(m.review) : '-'}`,
    m.coverUrl ? `표지: <a href="${esc(m.coverUrl)}">이미지 링크</a>` : null,
    m.externalUrl ? `공식 정보: <a href="${esc(m.externalUrl)}">정보 열기</a>` : null,
    m.createdAt ? `등록: ${m.createdAt.slice(0, 10)}` : null,
    m.completedAt ? `완료: ${m.completedAt.slice(0, 10)}` : null,
  ].filter(Boolean).join('\n');
}

/* ---------- 등록 마법사 ---------- */
const stepsFor = (t?: MType) => ['title', 'genres', 'status', 'rating', 'review', ...(t === 'movie' ? [] : ['progress']), 'confirm'];
const NAV: Row = [['이전', 'a:back'], ['취소', 'a:cancel']];

async function promptStep(ctx: Ctx, s: Session) {
  const d = s.draft!; const u = unit(d.type);
  const skip: Row = [['건너뛰기', 'a:skip']];
  switch (s.step) {
    case 'title': return show(ctx, `[${TYPES[d.type!]}] 제목을 입력하세요. (1~200자)\n입력 시 관련 장르와 포스터/표지가 자동 검색됩니다.`, [NAV]);
    case 'genres': {
      const hasGenres = Boolean(d.genres?.length);
      const gStr = hasGenres ? d.genres!.join(', ') : '';
      const lines = [
        `[${TYPES[d.type!]}] <b>${esc(d.title || '')}</b>`,
        hasGenres ? `\n✨ <b>추천 장르를 찾았습니다:</b>\n👉 <code>${esc(gStr)}</code>` : '',
        d.coverUrl ? `\n🖼 <b>대표 표지/포스터가 자동 연동되었습니다.</b>` : '',
        hasGenres
          ? `\n• 추천 장르를 그대로 등록하시려면 아래 <b>[추천 장르 사용]</b>을 누르세요.\n• 수정하시려면 원하는 장르를 직접 입력하세요 (쉼표 구분).`
          : `\n장르를 쉼표로 구분해 입력하세요. 예: 액션, 판타지`,
      ].filter(Boolean).join('\n');

      const rows: KbInput = hasGenres
        ? [
            [['추천 장르 사용', 'a:use_genres'], ['건너뛰기', 'a:skip']],
            NAV,
          ]
        : [skip, NAV];
      return show(ctx, lines, rows);
    }
    case 'status': return show(ctx, '상태를 선택하세요. (건너뛰면 "보고 싶음")',
      [STATUS_KEYS.slice(0, 3).map((k, i) => [STATUSES[k], `a:s:${i}`] as [string, string]),
       STATUS_KEYS.slice(3).map((k, i) => [STATUSES[k], `a:s:${i + 3}`] as [string, string]), skip, NAV]);
    case 'rating': return show(ctx, '평점을 입력하세요. 0~10, 소수점 한 자리까지. 예: 8.5', [skip, NAV]);
    case 'review': return show(ctx, '감상평을 입력하세요. (최대 2000자)', [skip, NAV]);
    case 'progress': return show(ctx, `진행도를 입력하세요(${u}). 예: 3 또는 3/12`, [skip, NAV]);
    case 'confirm': return show(ctx, `아래 내용으로 등록할까요?\n\n${fmt(d)}`, [[['등록', 'a:ok']], NAV]);
  }
}
async function nextStep(ctx: Ctx, s: Session, dir: 1 | -1) {
  const steps = stepsFor(s.draft?.type);
  const i = steps.indexOf(s.step!) + dir;
  if (i < 0) { s.step = undefined; s.draft = undefined; await setSession(ctx.uid, s); return chooseType(ctx); }
  s.step = steps[i]; await setSession(ctx.uid, s); return promptStep(ctx, s);
}
const chooseType = (ctx: Ctx) => show(ctx, '등록할 작품 종류를 선택하세요.',
  [TYPE_KEYS.slice(0, 2).map(k => [TYPES[k], `a:t:${k}`] as [string, string]),
   TYPE_KEYS.slice(2).map(k => [TYPES[k], `a:t:${k}`] as [string, string]), [['취소', 'a:cancel']]]);

async function confirmCreate(ctx: Ctx, s: Session) {
  const d = s.draft;
  if (!d || s.step !== 'confirm' || !d.title || !d.type) return home(ctx, '만료된 등록 화면입니다.\n\n');
  const t = now(); const status = d.status ?? 'planned';
  const media: Omit<Media, 'id'> = {
    userId: ctx.uid, title: d.title, type: d.type, status, genres: d.genres ?? [],
    rating: d.rating ?? null, review: d.review ?? '', progress: d.progress ?? null, totalProgress: d.totalProgress ?? null,
    coverUrl: d.coverUrl ?? null, externalUrl: d.externalUrl ?? null, createdAt: t, updatedAt: t, completedAt: status === 'completed' ? t : null,
  };
  try {
    await col.media().doc(d.draftId).create(media);
  } catch (e) {
    if (fsCode(e) === 6) { await setSession(ctx.uid, { filters: s.filters }); return home(ctx, '이미 등록된 작품입니다(중복 요청 무시).\n\n'); }
    log.error('media_create_failed', e, { user: uidTag(ctx.uid) });
    return show(ctx, '저장에 실패했습니다. 잠시 후 "등록"을 다시 눌러 주세요.', [[['등록', 'a:ok']], NAV]);
  }
  await setSession(ctx.uid, { filters: s.filters });
  await logActivity(ctx.uid, d.draftId, 'created', d.title);
  return show(ctx, `등록 완료!\n\n${fmt(media)}`, [[['상세 보기', `d:${d.draftId}`], ['계속 등록', 'm:add']], [['메인 메뉴', 'm:home']]]);
}

/* ---------- 검색·목록·상세 ---------- */
function filterText(f: Filters = {}) {
  return [
    `제목: ${f.q ? esc(f.q) : '전체'}`, `종류: ${f.type ? TYPES[f.type] : '전체'}`,
    `상태: ${f.status ? STATUSES[f.status] : '전체'}`, `장르: ${f.genre ? esc(f.genre) : '전체'}`,
    `평점: ${f.min != null ? `${f.min}~${f.max}` : '전체'}`, `정렬: ${f.sort === 'rating' ? '평점순' : '등록순'}`,
  ].join('\n');
}
const searchMenu = (ctx: Ctx, s: Session) => show(ctx, `<b>검색 조건</b>\n${filterText(s.filters)}`, [
  [['제목', 'f:q'], ['종류', 'f:t'], ['상태', 'f:s']],
  [['장르', 'f:g'], ['평점 범위', 'f:r'], ['정렬 전환', 'f:o']],
  [['결과 보기', 'l:0'], ['초기화', 'f:x']], [['메인 메뉴', 'm:home']],
]);

async function showList(ctx: Ctx, s: Session, page: number) {
  const f = s.filters ?? {};
  const items = applyFilters(await loadMedia(ctx.uid, f), f);
  const wish = s.mode === 'wish';
  if (!items.length) {
    return show(ctx, wish ? '보고 싶은 작품이 없습니다.' : '조건에 맞는 작품이 없습니다.\n검색 조건을 바꿔 보세요.',
      [[['작품 등록', 'm:add'], ['검색 조건', 'm:search']], [['메인 메뉴', 'm:home']]]);
  }
  const pages = Math.ceil(items.length / PAGE);
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = items.slice(p * PAGE, p * PAGE + PAGE);
  const lines = slice.map((m, i) => `${p * PAGE + i + 1}. [${TYPES[m.type]}] ${esc(m.title)} · ${typeof m.rating === 'number' ? '★' + m.rating : '미평가'} · ${STATUSES[m.status]}`);
  const rows: Row[] = slice.map(m => [[short(m.title), `d:${m.id}`]] as Row);
  const nav: Row = [];
  if (p > 0) nav.push(['◀ 이전', `l:${p - 1}`]);
  if (p < pages - 1) nav.push(['다음 ▶', `l:${p + 1}`]);
  if (nav.length) rows.push(nav);
  if (wish) rows.push([['랜덤 선택', 'w:rand']]);
  rows.push([['검색 조건', 'm:search'], ['메인 메뉴', 'm:home']]);
  return show(ctx, `<b>${wish ? '보고 싶은 작품' : '목록'}</b> (${items.length}개, ${p + 1}/${pages}쪽)\n\n${lines.join('\n')}`, rows);
}

async function showDetail(ctx: Ctx, id: string, note = '') {
  const m = await getOwned(ctx.uid, id);
  if (!m) return show(ctx, '작품을 찾을 수 없습니다. 삭제되었거나 잘못된 요청입니다.', [[['메인 메뉴', 'm:home']]]);
  const rows: Row[] = [
    [['평점 수정', `r:${id}`], ['상태 변경', `s:${id}`]],
    [['감상평 수정', `v:${id}`], ...(unit(m.type) ? [['진행도 수정', `p:${id}`], ['+1', `pi:${id}`]] as Row : [])],
    [['컬렉션', `c:${id}`], ['활동 기록', `h:${id}`], ['삭제', `x:${id}`]],
    [['목록으로', 'l:0'], ['메인 메뉴', 'm:home']],
  ];
  return show(ctx, `${note}${fmt(m)}`, rows);
}

async function updateMedia(ctx: Ctx, id: string, patch: Partial<Media>, action: string, detail: string) {
  const m = await getOwned(ctx.uid, id);
  if (!m) return show(ctx, '작품을 찾을 수 없습니다.', [[['메인 메뉴', 'm:home']]]);
  await col.media().doc(id).update({ ...patch, updatedAt: now() });
  await logActivity(ctx.uid, id, action, detail);
  return showDetail({ ...ctx, messageId: ctx.messageId }, id, '수정되었습니다.\n\n');
}

/* ---------- 통계 ---------- */
async function showStats(ctx: Ctx) {
  const all = await loadMedia(ctx.uid);
  const rated = all.filter(m => typeof m.rating === 'number');
  const avg = rated.length ? (rated.reduce((a, m) => a + (m.rating as number), 0) / rated.length).toFixed(2) : '-';
  const byType = TYPE_KEYS.map(k => `${TYPES[k]} ${all.filter(m => m.type === k).length}`).join(' · ');
  const byStatus = STATUS_KEYS.map(k => `${STATUSES[k]} ${all.filter(m => m.status === k).length}`).join(' · ');
  const done = all.filter(m => m.status === 'completed');
  const monthly: Record<string, number> = {};
  done.forEach(m => { if (m.completedAt) { const k = m.completedAt.slice(0, 7); monthly[k] = (monthly[k] ?? 0) + 1; } });
  const mLines = Object.entries(monthly).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12).map(([k, v]) => `  ${k}: ${v}`);
  const g: Record<string, { s: number; n: number }> = {};
  rated.forEach(m => (m.genres ?? []).forEach(x => { g[x] ??= { s: 0, n: 0 }; g[x].s += m.rating as number; g[x].n++; }));
  const gLines = Object.entries(g).sort((a, b) => b[1].n - a[1].n).slice(0, 15)
    .map(([k, v]) => `  ${esc(k)}: ${(v.s / v.n).toFixed(2)} (${v.n}개)`);
  return show(ctx, [
    '<b>통계</b>', `전체 등록: ${all.length}`, `종류별: ${byType}`, `상태별: ${byStatus}`,
    `평균 평점: ${avg} (평가 ${rated.length}개, 미평가 제외)`, `완료: ${done.length}`,
    `월별 완료:\n${mLines.join('\n') || '  -'}`, `장르별 평균 평점:\n${gLines.join('\n') || '  -'}`,
  ].join('\n'), [[['메인 메뉴', 'm:home']]]);
}

/* ---------- 컬렉션 ---------- */
async function myCollections(uid: number) {
  const s = await col.collections().where('userId', '==', uid).get();
  return s.docs.map(d => ({ id: d.id, ...(d.data() as { name: string; mediaIds: string[] }) }));
}
async function ownedCollection(uid: number, cid: string) {
  if (!ID_RE.test(cid)) return null;
  const s = await col.collections().doc(cid).get();
  return s.exists && s.data()?.userId === uid ? { id: s.id, ...(s.data() as { name: string; mediaIds: string[] }) } : null;
}
async function collectionsMenu(ctx: Ctx) {
  const cs = await myCollections(ctx.uid);
  const rows: Row[] = cs.slice(0, 20).map(c => [[`${short(c.name)} (${c.mediaIds?.length ?? 0})`, `co:${c.id}`]] as Row);
  rows.push([['새 컬렉션', 'cn'], ['설정', 'm:set']]);
  return show(ctx, cs.length ? '<b>내 컬렉션</b>' : '컬렉션이 없습니다. 새로 만들어 보세요.', rows);
}
async function collectionView(ctx: Ctx, cid: string) {
  const c = await ownedCollection(ctx.uid, cid);
  if (!c) return show(ctx, '컬렉션을 찾을 수 없습니다.', [[['컬렉션 목록', 'm:col']]]);
  const all = await loadMedia(ctx.uid);
  const items = all.filter(m => c.mediaIds?.includes(m.id)).slice(0, 30);
  const rows: Row[] = items.map(m => [[short(m.title), `d:${m.id}`]] as Row);
  rows.push([['이름 변경', `cr:${cid}`], ['컬렉션 삭제', `cx:${cid}`]], [['컬렉션 목록', 'm:col']]);
  return show(ctx, `<b>${esc(c.name)}</b> (${items.length}개)\n작품 상세의 "컬렉션" 버튼으로 추가·제거합니다.`, rows);
}

/* ---------- 내보내기·복원 ---------- */
const MAX_BACKUP = 1024 * 1024;
function isoOr(v: unknown, d: string | null) { return typeof v === 'string' && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : d; }
const urlOr = (v: unknown) => (typeof v === 'string' && /^https?:\/\/\S{1,500}$/.test(v) ? v : null);
const intOr = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 100000 ? (v as number) : null);

function normMedia(r: any, uid: number): Media | string {
  if (!r || typeof r !== 'object') return '객체가 아님';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'id 형식 오류';
  const title = typeof r.title === 'string' ? vTitle(r.title) : null;
  if (!title) return `제목 오류 (${r.id})`;
  if (!TYPE_KEYS.includes(r.type)) return `type 오류 (${r.id})`;
  if (!STATUS_KEYS.includes(r.status)) return `status 오류 (${r.id})`;
  if (r.rating != null && !(typeof r.rating === 'number' && r.rating >= 0 && r.rating <= 10)) return `rating 오류 (${r.id})`;
  const t = now();
  return {
    id: r.id, userId: uid, title, type: r.type, status: r.status,
    genres: Array.isArray(r.genres) ? r.genres.filter((g: unknown) => typeof g === 'string').map((g: string) => g.slice(0, 30)).slice(0, 10) : [],
    rating: typeof r.rating === 'number' ? Math.round(r.rating * 10) / 10 : null,
    review: typeof r.review === 'string' ? r.review.slice(0, 2000) : '',
    progress: intOr(r.progress), totalProgress: intOr(r.totalProgress),
    coverUrl: urlOr(r.coverUrl), externalUrl: urlOr(r.externalUrl),
    createdAt: isoOr(r.createdAt, t)!, updatedAt: isoOr(r.updatedAt, t)!, completedAt: isoOr(r.completedAt, null),
  };
}
function parseBackup(text: string, uid: number) {
  let j: any;
  try { j = JSON.parse(text); } catch { return { error: 'JSON 형식이 아닙니다.' }; }
  if (j?.format !== 'my-media-archive' || j?.version !== 1) return { error: '이 봇에서 내보낸 백업 파일이 아닙니다(format/version 불일치).' };
  if (!Array.isArray(j.media) || j.media.length > 5000) return { error: 'media 배열이 없거나 너무 깁니다.' };
  const media: Media[] = [];
  for (const r of j.media) { const m = normMedia(r, uid); if (typeof m === 'string') return { error: `작품 데이터 오류: ${m}` }; media.push(m); }
  const ids = new Set(media.map(m => m.id));
  const collections = (Array.isArray(j.collections) ? j.collections : [])
    .filter((c: any) => typeof c?.id === 'string' && ID_RE.test(c.id) && typeof c.name === 'string')
    .map((c: any) => ({ id: c.id, userId: uid, name: c.name.slice(0, 50),
      mediaIds: Array.isArray(c.mediaIds) ? c.mediaIds.filter((x: unknown) => typeof x === 'string' && ids.has(x)) : [],
      createdAt: isoOr(c.createdAt, now()), updatedAt: now() }));
  const logs = (Array.isArray(j.activity_logs) ? j.activity_logs : []).slice(0, 20000)
    .filter((l: any) => typeof l?.mediaId === 'string' && ID_RE.test(l.mediaId) && typeof l.action === 'string')
    .map((l: any) => ({ userId: uid, mediaId: l.mediaId, action: l.action.slice(0, 40),
      detail: typeof l.detail === 'string' ? l.detail.slice(0, 300) : '', createdAt: isoOr(l.createdAt, now()) }));
  return { media, collections, logs };
}
async function ownershipMap(colRef: any, ids: string[]) {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 100) {
    const snaps = await db.getAll(...ids.slice(i, i + 100).map(id => colRef.doc(id)));
    snaps.forEach(s => { if (s.exists) out.set(s.id, s.data()!.userId); });
  }
  return out;
}
async function commitAll(ops: ((b: any) => void)[]) {
  for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
}
async function doExport(ctx: Ctx) {
  const [media, cols, logs] = await Promise.all([
    loadMedia(ctx.uid), myCollections(ctx.uid),
    col.logs().where('userId', '==', ctx.uid).get().then(s => s.docs.map(d => { const { userId, ...r } = d.data(); return r; })),
  ]);
  const data = { format: 'my-media-archive', version: 1, exportedAt: now(),
    media: media.map(({ userId, ...r }) => r), collections: cols.map(({ ...c }: any) => { delete c.userId; return c; }), activity_logs: logs };
  await sendDocument(ctx.chatId, `media-archive-${now().slice(0, 10)}.json`, JSON.stringify(data, null, 2),
    `내보내기 완료: 작품 ${media.length}, 컬렉션 ${cols.length}, 기록 ${logs.length}`);
}
async function doRestore(ctx: Ctx, s: Session, overwrite: boolean) {
  if (s.step !== 'restore_confirm' || !s.restoreFileId) return show(ctx, '만료된 복원 요청입니다.', [[['설정', 'm:set']]]);
  const parsed = parseBackup(await downloadFile(s.restoreFileId, MAX_BACKUP), ctx.uid);
  if ('error' in parsed) return show(ctx, `복원 실패: ${parsed.error}`, [[['설정', 'm:set']]]);
  const mOwn = await ownershipMap(col.media(), parsed.media.map(m => m.id));
  const cOwn = await ownershipMap(col.collections(), parsed.collections.map((c: any) => c.id));
  let written = 0, skipped = 0;
  const ops: ((b: any) => void)[] = [];
  for (const m of parsed.media) {
    const owner = mOwn.get(m.id);
    if (owner != null && (owner !== ctx.uid || !overwrite)) { skipped++; continue; }
    const { id, ...data } = m; ops.push(b => b.set(col.media().doc(id), data)); written++;
  }
  for (const c of parsed.collections) {
    const owner = cOwn.get(c.id);
    if (owner != null && (owner !== ctx.uid || !overwrite)) continue;
    const { id, ...data } = c; ops.push(b => b.set(col.collections().doc(id), data));
  }
  const restoredIds = new Set(parsed.media.filter(m => { const o = mOwn.get(m.id); return o == null || (o === ctx.uid && overwrite); }).map(m => m.id));
  parsed.logs.filter((l: any) => restoredIds.has(l.mediaId)).forEach((l: any) => ops.push(b => b.set(col.logs().doc(), l)));
  await commitAll(ops);
  await setSession(ctx.uid, { filters: s.filters });
  return show(ctx, `복원 완료: 작품 ${written}개 저장, ${skipped}개 건너뜀.`, [['내 도감', 'm:all'], ['메인 메뉴', 'm:home']]);
}

/* ---------- 텍스트 입력 처리 ---------- */
async function onText(ctx: Ctx, s: Session, text: string) {
  const d = s.draft;
  switch (s.step) {
    case 'title': {
      const t = vTitle(text);
      if (!t) return send(ctx, '제목은 1~200자여야 합니다. 다시 입력하세요.', [NAV]);
      d!.title = t;
      await show(ctx, `🔍 <b>${esc(t)}</b> 정보 및 표지를 검색하고 있습니다...`);
      try {
        const found = await searchMedia(t, d!.type!);
        if (found.genres?.length) d!.genres = found.genres;
        if (found.coverUrl) d!.coverUrl = found.coverUrl;
        if (found.externalUrl) d!.externalUrl = found.externalUrl;
      } catch (e) {
        log.warn('search_media_failed', { title: t, err: String(e) });
      }
      return nextStep(ctx, s, 1);
    }
    case 'genres': { const g = vGenres(text); if (!g) return send(ctx, '장르는 최대 10개, 각 30자 이하입니다.', [NAV]); d!.genres = g; return nextStep(ctx, s, 1); }
    case 'rating': { const r = vRating(text); if (r === 'invalid') return send(ctx, '평점은 0~10 사이 숫자(소수 한 자리)로 입력하세요. 예: 7.5', [NAV]); d!.rating = r; return nextStep(ctx, s, 1); }
    case 'review': { if (text.length > 2000) return send(ctx, '감상평은 2000자 이하로 입력하세요.', [NAV]); d!.review = text.trim(); return nextStep(ctx, s, 1); }
    case 'progress': { const p = vProgress(text); if (!p) return send(ctx, '형식: 3 또는 3/12 (현재가 전체보다 클 수 없음)', [NAV]); Object.assign(d!, p); return nextStep(ctx, s, 1); }
    case 'e_rating': case 'e_review': case 'e_progress': {
      const id = s.mediaId!; let patch: Partial<Media>; let detail: string;
      if (s.step === 'e_rating') { const r = vRating(text); if (r === 'invalid') return send(ctx, '0~10 숫자 또는 "없음"을 입력하세요.'); patch = { rating: r }; detail = `rating=${r ?? '미평가'}`; }
      else if (s.step === 'e_review') { if (text.length > 2000) return send(ctx, '2000자 이하로 입력하세요.'); patch = { review: text.trim() === '삭제' ? '' : text.trim() }; detail = 'review'; }
      else { const p = vProgress(text); if (!p) return send(ctx, '형식: 3 또는 3/12'); patch = p; detail = `progress=${p.progress}/${p.totalProgress ?? '-'}`; }
      await setSession(ctx.uid, { filters: s.filters, mode: s.mode });
      return updateMedia({ ...ctx, messageId: undefined }, id, patch, s.step.slice(2) + '_updated', detail);
    }
    case 'f_q': case 'f_g': case 'f_r': {
      const f = (s.filters ??= {}); const t = text.trim();
      if (s.step === 'f_q') f.q = t === '-' ? undefined : t.slice(0, 100);
      else if (s.step === 'f_g') f.genre = t === '-' ? undefined : t.slice(0, 30);
      else {
        if (t === '-') { f.min = f.max = undefined; }
        else { const m = t.match(/^(\d{1,2}(?:\.\d)?)\s*-\s*(\d{1,2}(?:\.\d)?)$/); const a = m ? Number(m[1]) : NaN, b = m ? Number(m[2]) : NaN;
          if (!m || a > b || b > 10) return send(ctx, '형식: 7-10 (해제는 -)'); f.min = a; f.max = b; }
      }
      s.step = undefined; await setSession(ctx.uid, s); return searchMenu({ ...ctx, messageId: undefined }, s);
    }
    case 'c_new': case 'c_rename': {
      const name = text.trim(); if (!name || name.length > 50) return send(ctx, '컬렉션 이름은 1~50자입니다.');
      if (s.step === 'c_new') await col.collections().add({ userId: ctx.uid, name, mediaIds: [], createdAt: now(), updatedAt: now() });
      else { const c = await ownedCollection(ctx.uid, s.collectionId!); if (c) await col.collections().doc(c.id).update({ name, updatedAt: now() }); }
      await setSession(ctx.uid, { filters: s.filters }); return collectionsMenu({ ...ctx, messageId: undefined });
    }
    case 'restore_wait': return send(ctx, 'JSON 파일을 "파일"로 첨부해 보내 주세요.', [['취소', 'm:set']]);
    default: return home({ ...ctx, messageId: undefined }, '버튼으로 메뉴를 선택해 주세요.\n\n');
  }
}

/* ---------- 콜백 처리 ---------- */
async function onCallback(ctx: Ctx, s: Session, data: string) {
  const [k, a, b] = data.split(':');
  const keep = { filters: s.filters, mode: s.mode };
  switch (k) {
    case 'm': {
      if (s.step && !['e_rating', 'e_review', 'e_progress'].includes(s.step) && a !== 'add') { s = { ...keep }; await setSession(ctx.uid, s); }
      if (a === 'home') { await setSession(ctx.uid, keep); return home(ctx); }
      if (a === 'add') { await setSession(ctx.uid, keep); return chooseType(ctx); }
      if (a === 'search') return searchMenu(ctx, s);
      if (a === 'all') { s = { mode: 'list', filters: {} }; await setSession(ctx.uid, s); return showList(ctx, s, 0); }
      if (a === 'wish') { s = { mode: 'wish', filters: { status: 'planned' } }; await setSession(ctx.uid, s); return showList(ctx, s, 0); }
      if (a === 'stats') return showStats(ctx);
      if (a === 'col') { await setSession(ctx.uid, keep); return collectionsMenu(ctx); }
      if (a === 'set') { await setSession(ctx.uid, keep); return show(ctx, '<b>설정</b>', [[['컬렉션 관리', 'm:col']], [['데이터 내보내기', 'ex'], ['데이터 복원', 'rs']], [['메인 메뉴', 'm:home']]]); }
      break;
    }
    case 'a': {
      if (a === 'cancel') { await setSession(ctx.uid, keep); return home(ctx, '등록을 취소했습니다.\n\n'); }
      if (a === 't' && TYPE_KEYS.includes(b as MType)) {
        s = { ...keep, step: 'title', draft: { draftId: col.media().doc().id, type: b as MType } };
        await setSession(ctx.uid, s); return promptStep(ctx, s);
      }
      if (!s.draft || !s.step || !stepsFor(s.draft.type).includes(s.step)) return home(ctx, '만료된 등록 화면입니다.\n\n');
      if (a === 'back') return nextStep(ctx, s, -1);
      if (a === 'use_genres' && s.step === 'genres') return nextStep(ctx, s, 1);
      if (a === 'skip' && s.step !== 'title' && s.step !== 'confirm') {
        if (s.step === 'genres') s.draft!.genres = [];
        return nextStep(ctx, s, 1);
      }
      if (a === 's' && s.step === 'status' && STATUS_KEYS[Number(b)]) { s.draft.status = STATUS_KEYS[Number(b)]; return nextStep(ctx, s, 1); }
      if (a === 'ok') return confirmCreate(ctx, s);
      break;
    }
    case 'f': {
      s.filters ??= {};
      if (a === 'q' || a === 'g' || a === 'r') {
        s.step = 'f_' + a; await setSession(ctx.uid, s);
        return show(ctx, a === 'q' ? '검색할 제목(일부)을 입력하세요. 해제: -' : a === 'g' ? '장르명을 입력하세요. 해제: -' : '평점 범위를 입력하세요. 예: 7-10 (미평가 제외), 해제: -', [['뒤로', 'm:search']]);
      }
      if (a === 't') return show(ctx, '종류 필터', [TYPE_KEYS.map(t => [TYPES[t], `ft:${t}`] as [string, string]), [['전체', 'ft:all']]]);
      if (a === 's') return show(ctx, '상태 필터', [STATUS_KEYS.slice(0, 3).map(t => [STATUSES[t], `fs:${t}`] as [string, string]), [...STATUS_KEYS.slice(3).map(t => [STATUSES[t], `fs:${t}`] as [string, string]), ['전체', 'fs:all']]]);
      if (a === 'o') s.filters.sort = s.filters.sort === 'rating' ? 'created' : 'rating';
      if (a === 'x') s.filters = {};
      s.mode = 'list'; await setSession(ctx.uid, s); return searchMenu(ctx, s);
    }
    case 'ft': case 'fs': {
      s.filters ??= {};
      if (k === 'ft') s.filters.type = TYPE_KEYS.includes(a as MType) ? (a as MType) : undefined;
      else s.filters.status = STATUS_KEYS.includes(a as MStatus) ? (a as MStatus) : undefined;
      s.mode = 'list'; await setSession(ctx.uid, s); return searchMenu(ctx, s);
    }
    case 'l': return showList(ctx, s, Number(a) || 0);
    case 'w': {
      const list = (await loadMedia(ctx.uid, { status: 'planned' }));
      if (!list.length) return show(ctx, '보고 싶은 작품이 없습니다.', [[['작품 등록', 'm:add'], ['메인 메뉴', 'm:home']]]);
      const pick = list[Math.floor(Math.random() * list.length)];
      return show(ctx, `<b>오늘의 추천</b>\n\n${fmt(pick)}`, [[['상세 보기', `d:${pick.id}`], ['다시 뽑기', 'w:rand']], [['보고 싶은 작품', 'm:wish']]]);
    }
    case 'd': return showDetail(ctx, a);
    case 'r': case 'v': case 'p': {
      const m = await getOwned(ctx.uid, a); if (!m) return show(ctx, '작품을 찾을 수 없습니다.', [['메인 메뉴', 'm:home']]);
      await setSession(ctx.uid, { ...keep, step: k === 'r' ? 'e_rating' : k === 'v' ? 'e_review' : 'e_progress', mediaId: a });
      return show(ctx, k === 'r' ? '새 평점(0~10)을 입력하세요. 평점 삭제: 없음' : k === 'v' ? '새 감상평을 입력하세요. 삭제: 삭제' : `진행도를 입력하세요(${unit(m.type)}). 예: 5/12`, [['취소', `d:${a}`]]);
    }
    case 'pi': {
      const m = await getOwned(ctx.uid, a); if (!m || !unit(m.type)) return show(ctx, '작품을 찾을 수 없습니다.', [['메인 메뉴', 'm:home']]);
      const p = (m.progress ?? 0) + 1;
      if (m.totalProgress != null && p > m.totalProgress) return showDetail(ctx, a, '이미 마지막 회차/권입니다.\n\n');
      return updateMedia(ctx, a, { progress: p, ...(m.status === 'planned' ? { status: 'in_progress' as MStatus } : {}) }, 'progress_updated', `progress=${p}`);
    }
    case 's': return show(ctx, '변경할 상태를 선택하세요.', [STATUS_KEYS.slice(0, 3).map((t, i) => [STATUSES[t], `ss:${a}:${i}`] as [string, string]), [...STATUS_KEYS.slice(3).map((t, i) => [STATUSES[t], `ss:${a}:${i + 3}`] as [string, string]), ['취소', `d:${a}`]]]);
    case 'ss': {
      const st = STATUS_KEYS[Number(b)]; const m = await getOwned(ctx.uid, a);
      if (!st || !m) return show(ctx, '잘못된 요청입니다.', [['메인 메뉴', 'm:home']]);
      const completedAt = st === 'completed' ? (m.completedAt ?? now()) : null;
      return updateMedia(ctx, a, { status: st, completedAt }, 'status_changed', `${m.status}->${st}`);
    }
    case 'x': {
      const m = await getOwned(ctx.uid, a); if (!m) return show(ctx, '작품을 찾을 수 없습니다.', [['메인 메뉴', 'm:home']]);
      return show(ctx, `<b>${esc(m.title)}</b>을(를) 정말 삭제할까요?\n되돌릴 수 없습니다.`, [['삭제 확인', `xy:${a}`], ['취소', `d:${a}`]]);
    }
    case 'xy': {
      const m = await getOwned(ctx.uid, a); if (!m) return show(ctx, '이미 삭제되었거나 없는 작품입니다.', [['메인 메뉴', 'm:home']]);
      await col.media().doc(a).delete();
      const cs = (await myCollections(ctx.uid)).filter(c => c.mediaIds?.includes(a));
      await Promise.all(cs.map(c => col.collections().doc(c.id).update({ mediaIds: FieldValue.arrayRemove(a), updatedAt: now() })));
      await logActivity(ctx.uid, a, 'deleted', m.title);
      return show(ctx, `삭제했습니다: ${esc(m.title)}`, [['목록으로', 'l:0'], ['메인 메뉴', 'm:home']]);
    }
    case 'h': {
      const m = await getOwned(ctx.uid, a); if (!m) return show(ctx, '작품을 찾을 수 없습니다.', [['메인 메뉴', 'm:home']]);
      const snap = await col.logs().where('userId', '==', ctx.uid).where('mediaId', '==', a).get();
      const rows = snap.docs.map(d => d.data()).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 15)
        .map(l => `${l.createdAt.slice(0, 16).replace('T', ' ')} ${esc(l.action)} ${esc(l.detail ?? '')}`);
      return show(ctx, `<b>${esc(m.title)} 활동 기록</b>\n${rows.join('\n') || '기록 없음'}`, [['상세로', `d:${a}`]]);
    }
    case 'c': {
      const m = await getOwned(ctx.uid, a); if (!m) return show(ctx, '작품을 찾을 수 없습니다.', [['메인 메뉴', 'm:home']]);
      const cs = await myCollections(ctx.uid);
      const rows: Row[] = cs.slice(0, 20).map(c => [[`${c.mediaIds?.includes(a) ? '✓ ' : ''}${short(c.name)}`, `ct:${a}:${c.id}`]] as Row);
      rows.push([['새 컬렉션', 'cn'], ['상세로', `d:${a}`]]);
      return show(ctx, cs.length ? '눌러서 추가/제거 (✓ = 포함됨)' : '컬렉션이 없습니다.', rows);
    }
    case 'ct': {
      const m = await getOwned(ctx.uid, a); const c = await ownedCollection(ctx.uid, b ?? '');
      if (!m || !c) return show(ctx, '잘못된 요청입니다.', [['메인 메뉴', 'm:home']]);
      const has = c.mediaIds?.includes(a);
      await col.collections().doc(c.id).update({ mediaIds: has ? FieldValue.arrayRemove(a) : FieldValue.arrayUnion(a), updatedAt: now() });
      await logActivity(ctx.uid, a, has ? 'collection_remove' : 'collection_add', c.name);
      return onCallback(ctx, s, `c:${a}`);
    }
    case 'cn': await setSession(ctx.uid, { ...keep, step: 'c_new' }); return show(ctx, '새 컬렉션 이름을 입력하세요. (1~50자)', [['취소', 'm:col']]);
    case 'co': return collectionView(ctx, a);
    case 'cr': await setSession(ctx.uid, { ...keep, step: 'c_rename', collectionId: a }); return show(ctx, '새 이름을 입력하세요.', [['취소', `co:${a}`]]);
    case 'cx': return show(ctx, '컬렉션을 삭제할까요? (작품은 삭제되지 않습니다)', [['삭제 확인', `cxy:${a}`], ['취소', `co:${a}`]]);
    case 'cxy': { const c = await ownedCollection(ctx.uid, a); if (c) await col.collections().doc(c.id).delete(); return collectionsMenu(ctx); }
    case 'ex': return show(ctx, '내 데이터 전체를 JSON 파일로 이 채팅에 보냅니다. 진행할까요?', [['내보내기 확인', 'exy'], ['취소', 'm:set']]);
    case 'exy':
      try { await doExport(ctx); return send(ctx, '파일을 안전한 곳에 보관하세요.', MAIN); }
      catch (e) { log.error('export_failed', e, { user: uidTag(ctx.uid) }); return send(ctx, '내보내기에 실패했습니다. 잠시 후 다시 시도하세요.', [['설정', 'm:set']]); }
    case 'rs': await setSession(ctx.uid, { ...keep, step: 'restore_wait' }); return show(ctx, '이 봇에서 내보낸 JSON 파일을 첨부해 보내세요. (최대 1MB)', [['취소', 'm:set']]);
    case 'rso': case 'rss':
      try { return await doRestore(ctx, s, k === 'rso'); }
      catch (e) { log.error('restore_failed', e, { user: uidTag(ctx.uid) }); return show(ctx, '복원 중 오류가 발생했을 수 있습니다. 일부만 저장되었을 수 있으니 내 도감을 확인하세요.', [['설정', 'm:set']]); }
  }
  return home(ctx, '만료되었거나 알 수 없는 버튼입니다.\n\n');
}

async function onDocument(ctx: Ctx, s: Session, doc: any) {
  if (s.step !== 'restore_wait') return send(ctx, '파일은 설정 → 데이터 복원 단계에서만 받습니다.', MAIN);
  if (!doc?.file_id || (doc.file_size ?? 0) > MAX_BACKUP || !/\.json$/i.test(doc.file_name ?? '')) return send(ctx, '1MB 이하의 .json 파일만 가능합니다.', [['취소', 'm:set']]);
  let parsed;
  try { parsed = parseBackup(await downloadFile(doc.file_id, MAX_BACKUP), ctx.uid); }
  catch (e) { log.error('restore_download_failed', e); return send(ctx, '파일을 받지 못했습니다. 다시 보내 주세요.', [['취소', 'm:set']]); }
  if ('error' in parsed) return send(ctx, `검증 실패: ${parsed.error}`, [['취소', 'm:set']]);
  const mine = new Set((await loadMedia(ctx.uid)).map(m => m.id));
  const conflicts = parsed.media.filter(m => mine.has(m.id)).length;
  await setSession(ctx.uid, { filters: s.filters, step: 'restore_confirm', restoreFileId: doc.file_id });
  const rows: Row[] = conflicts
    ? [['덮어쓰기', 'rso'], ['기존 유지(새 항목만)', 'rss']]
    : [['복원 실행', 'rss'], ['취소', 'm:set']];
  return send(ctx, `검증 완료: 작품 ${parsed.media.length}, 컬렉션 ${parsed.collections.length}, 기록 ${parsed.logs.length}\n기존 작품과 ID 충돌: ${conflicts}개\n처리 방법을 선택하세요.`, rows);
}

/* ---------- 진입점 ---------- */
export async function handleUpdate(u: any): Promise<void> {
  const msg = u.message; const cq = u.callback_query;
  const from = msg?.from ?? cq?.from;
  if (!from || typeof from.id !== 'number') return;
  const uid: number = from.id;

  if (!config.allowed.has(uid)) {
    log.warn('unauthorized_user', { user: uidTag(uid) });
    if (cq) await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '사용 권한이 없습니다.' }).catch(() => {});
    else if (msg?.chat?.type === 'private') await tg('sendMessage', { chat_id: msg.chat.id, text: '이 봇은 개인 전용입니다.' }).catch(() => {});
    return;
  }

  if (cq) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    const chatId = cq.message?.chat?.id;
    if (!chatId || cq.message?.chat?.type !== 'private' || typeof cq.data !== 'string' || cq.data.length > 64) return;
    const ctx: Ctx = { uid, chatId, messageId: cq.message.message_id };
    return withErrors(ctx, async () => onCallback(ctx, await getSession(uid), cq.data));
  }

  if (!msg?.chat || msg.chat.type !== 'private') return;
  const ctx: Ctx = { uid, chatId: msg.chat.id };
  return withErrors(ctx, async () => {
    const s = await getSession(uid);
    const text: string | undefined = msg.text;
    if (text?.startsWith('/')) {
      const cmd = text.split(/[\s@]/)[0];
      if (cmd === '/start' || cmd === '/menu' || cmd === '/cancel') {
        const ref = col.users().doc(String(uid));
        if (!(await ref.get()).exists) await ref.create({ userId: uid, createdAt: now(), updatedAt: now(), session: {} }).catch(() => {});
        await setSession(uid, { filters: s.filters });
        return home(ctx, cmd === '/cancel' && s.step ? '진행 중이던 작업을 취소했습니다.\n\n' : '');
      }
      await send(ctx, '지원하지 않는 명령어입니다. /start 로 메뉴를 열 수 있습니다.');
      if (s.draft && s.step) return promptStep(ctx, s);
      return;
    }
    if (msg.document) return onDocument(ctx, s, msg.document);
    if (typeof text === 'string') return onText(ctx, s, text);
    return send(ctx, '텍스트 또는 버튼으로 입력해 주세요.');
  });
}

async function withErrors(ctx: Ctx, fn: () => Promise<unknown>) {
  try { await fn(); }
  catch (e) {
    log.error('handler_failed', e, { user: uidTag(ctx.uid) });
    const text = isDbOutage(e)
      ? '데이터베이스에 일시적으로 연결할 수 없습니다(또는 일일 사용량 초과). 잠시 후 다시 시도해 주세요.'
      : '처리 중 오류가 발생했습니다. /start 로 다시 시작해 주세요.';
    await tg('sendMessage', { chat_id: ctx.chatId, text }).catch(() => {});
  }
}

/** update_id 선점. true = 처음 보는 업데이트 */
export async function claimUpdate(updateId: number): Promise<boolean> {
  try {
    await col.updates().doc(String(updateId)).create({ createdAt: now(), expireAt: new Date(Date.now() + 7 * 864e5) });
    return true;
  } catch (e) {
    if (fsCode(e) === 6) return false;
    throw e;
  }
}
