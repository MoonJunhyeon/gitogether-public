// 에픽 보드 필터 (보기, 상태, 담당자, Jira 상태, 에픽, 검색)와 "에픽만 보기" 화면
import { RotateCcw, Search } from 'lucide-react'
import type { Epic, Issue, JiraInfo } from './github'

export const NONE = '__none' // 미분류(No milestone) 또는 담당자 미지정

export type Filters = {
  view: 'tasks' | 'epics' // 작업까지 보기 | 에픽만 보기
  status: 'open' | 'all' | 'closed' // 진행 중만 | 완료 포함 | 완료만
  assignee: string // '' 모두, NONE 미지정, 그 외 담당자 이름
  jira: '' | 'new' | 'indeterminate' | 'done' // Jira 상태 분류
  epic: string // '' 모두, NONE 미분류, 그 외 에픽 key
  q: string // 제목 또는 #번호
  hideEmpty: boolean // 보이는 이슈가 없는 에픽 칸 숨기기
  needsSummary: boolean // 요약이 필요한 이슈만
}
export const DEFAULT_FILTERS: Filters = {
  view: 'tasks', status: 'open', assignee: '', jira: '', epic: '', q: '', hideEmpty: false, needsSummary: false,
}

// 이 PC에 기억 (개인 설정이라 저장 못 해도 기본값으로 동작)
const KEY = 'gto:boardFilters'
export const loadFilters = (): Filters => {
  try { return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return DEFAULT_FILTERS }
}
export const saveFilters = (f: Filters) => { try { localStorage.setItem(KEY, JSON.stringify(f)) } catch { /* 이번 실행에만 적용 */ } }

const statusOk = (f: Filters, i: Issue) => f.status === 'all' || i.state === (f.status === 'open' ? 'open' : 'closed')

// 상태 필터를 뺀 나머지 조건 (에픽 진행률은 상태와 상관없이 세야 해서 따로 둠)
export function matchesExceptStatus(f: Filters, i: Issue, jira?: JiraInfo) {
  const q = f.q.trim().toLowerCase().replace(/^#/, '')
  return (!f.assignee || (f.assignee === NONE ? !i.assignee : i.assignee === f.assignee))
    && (!f.jira || jira?.category === f.jira)
    && (!f.epic || i.epic === (f.epic === NONE ? '' : f.epic))
    && (!q || i.title.toLowerCase().includes(q) || String(i.number) === q)
    && (!f.needsSummary || i.needsSummary)
}
export const matches = (f: Filters, i: Issue, jira?: JiraInfo) => statusOk(f, i) && matchesExceptStatus(f, i, jira)

export function FilterBar({ f, onChange, assignees, epics, hasJira, shown, total, views = true }: {
  f: Filters; onChange: (f: Filters) => void; assignees: string[]; epics: Epic[]; hasJira: boolean; shown: number; total: number
  views?: boolean // 작업까지/에픽만 전환 (흐름 탭에는 없음)
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...f, [k]: v })
  const changed = JSON.stringify({ ...f, view: 'tasks' }) !== JSON.stringify(DEFAULT_FILTERS)
  return (
    <div className="filter-bar" role="toolbar" aria-label="보드 필터">
      {views && <div className="segmented" role="radiogroup" aria-label="보기">
        {(['tasks', 'epics'] as const).map((v) => (
          // 보기를 바꾸면 다른 필터는 모두 초기화 (이전 보기에서 걸어 둔 조건이 숨어서 남지 않게)
          <button key={v} role="radio" aria-checked={f.view === v} className={f.view === v ? 'on' : ''}
            onClick={() => onChange({ ...DEFAULT_FILTERS, view: v })}>
            {v === 'tasks' ? '작업까지' : '에픽만'}
          </button>
        ))}
      </div>}
      <label className="search">
        <Search size={14} />
        <input placeholder="제목 또는 #번호" value={f.q} onChange={(e) => set('q', e.target.value)} aria-label="검색" />
      </label>
      <select value={f.status} onChange={(e) => set('status', e.target.value as Filters['status'])} aria-label="상태">
        <option value="open">진행 중만</option>
        <option value="all">완료 포함</option>
        <option value="closed">완료만</option>
      </select>
      <select value={f.assignee} onChange={(e) => set('assignee', e.target.value)} aria-label="담당자">
        <option value="">담당자: 모두</option>
        <option value={NONE}>담당자 없음</option>
        {assignees.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      {hasJira && (
        <select value={f.jira} onChange={(e) => set('jira', e.target.value as Filters['jira'])} aria-label="Jira 상태">
          <option value="">Jira: 모두</option>
          <option value="new">Jira: 할 일</option>
          <option value="indeterminate">Jira: 진행 중</option>
          <option value="done">Jira: 완료</option>
        </select>
      )}
      <select value={f.epic} onChange={(e) => set('epic', e.target.value)} aria-label="에픽">
        <option value="">에픽: 모두</option>
        <option value={NONE}>No milestone</option>
        {epics.map((e) => <option key={e.key} value={e.key}>{e.title}</option>)}
      </select>
      <button className={f.hideEmpty ? 'toggle on' : 'toggle'} aria-pressed={f.hideEmpty} onClick={() => set('hideEmpty', !f.hideEmpty)}>빈 에픽 숨기기</button>
      <button className={f.needsSummary ? 'toggle on' : 'toggle'} aria-pressed={f.needsSummary} onClick={() => set('needsSummary', !f.needsSummary)}>요약 필요만</button>
      {changed && (
        <button className="ghost" onClick={() => onChange({ ...DEFAULT_FILTERS, view: f.view })} title="필터 초기화"><RotateCcw />초기화</button>
      )}
      <span className="grow" />
      <span className="muted shown">{shown === total ? `${total}개` : `${shown} / ${total}개`}</span>
    </div>
  )
}

// 에픽만 보기: 에픽별 진행률(완료/전체)과 개수. 누르면 그 에픽의 작업 보기로
export function EpicOverview({ f, epics, issues, jira, showNone, onOpen, onMenu }: {
  f: Filters; epics: Epic[]; issues: Issue[]; jira: Map<string, JiraInfo>; showNone: boolean; onOpen: (epicKey: string) => void
  onMenu: (e: React.MouseEvent, epic?: Epic) => void // 우클릭 메뉴 (epic 없음 = No milestone)
}) {
  const tile = (key: string, title: string, epic?: Epic) => {
    const mine = issues.filter((i) => i.epic === key && matchesExceptStatus({ ...f, epic: '' }, i, jira.get(`${i.repo}#${i.number}`)))
    const done = mine.filter((i) => i.state === 'closed').length
    const pct = mine.length ? Math.round((done / mine.length) * 100) : 0
    const summary = mine.filter((i) => i.state === 'open' && i.needsSummary).length
    return (
      <button key={key || NONE} className="epic-tile" onClick={() => onOpen(key || NONE)} onContextMenu={(e) => onMenu(e, epic)}>
        <div className="epic-tile-head">
          <span className={`dot ${epic && !epic.closed ? 'yellow' : ''}`} />
          <span className="title">{title}</span>
          {epic?.jiraKey && <span className="badge">{epic.jiraKey}</span>}
          {epic?.closed && <span className="badge done">완료</span>}
        </div>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="완료율">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="epic-tile-meta">
          <span>진행 중 {mine.length - done}</span>
          <span>완료 {done}</span>
          <span>{pct}%</span>
          {summary > 0 && <span className="summary-need">요약 필요 {summary}</span>}
        </div>
      </button>
    )
  }
  return (
    <div className="epic-grid">
      {showNone && tile('', 'No milestone')}
      {epics.map((e) => tile(e.key, e.title, e))}
      {!epics.length && !showNone && <p className="muted">조건에 맞는 에픽이 없습니다.</p>}
    </div>
  )
}
