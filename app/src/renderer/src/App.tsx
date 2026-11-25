import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  Archive, BookOpen, Bot, MessageCircleQuestion, CheckCircle2, ListPlus, ListTree, ChevronRight, Eye, Flag, Hash, Link2, MoveRight, Pencil, Monitor, Rocket, Route, Moon, Sun, SunMoon, RotateCcw, Download, ExternalLink, FolderGit2, GitMerge, Loader2, SquareArrowOutUpRight, Upload, KeyRound, LayoutGrid, Plus, RefreshCw, Settings, Sparkles, Workflow, X,
} from 'lucide-react'
import {
  assign, checkProfile, closeEpic, createEpic, loadBoard, loadJira, loadProfiles, publishProfile, renameEpic, saveProfile, setAuth, setIssueState, summarizeIssue,
  type Epic, type Issue, type JiraInfo, type Profile, type ProfileFile,
} from './github'
import Actions from './Actions'
import appIcon from '../../../resources/icon.svg' // 창 아이콘과 같은 그림
import { ImportEpicsDialog, JiraPanel, NewIssueDialog, SubIssuesPanel } from './Panels'
import { DEFAULT_FILTERS, EpicOverview, FilterBar, loadFilters, matches, NONE, saveFilters, type Filters } from './Filters'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { DeployList, FlowPanel, FlowTable } from './Flow'
import Assistant, { copyText, type ChatMsg } from './Assistant'
import Guide from './Guide'
import { loadDeploys, loadReleases, type DeployRow, type Release } from './pipeline'

const ago = (now: number, t: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 15 ? '방금' : s < 60 ? `${s}초 전` : `${Math.floor(s / 60)}분 전`
}
const cardId = (i: Issue) => `${i.repo}#${i.number}`

const NEW_PROFILE = {
  name: '',
  jira: { baseUrl: 'https://your-site.atlassian.net', project: 'PRJ', types: { epic: '10000', issue: '10012' } },
  repos: ['your-org/'],
  label: 'jira',
  mapping: { epic: 'milestone' },
  assignees: {},
}

type Editing = { file: string; sha?: string; text: string; before?: Profile }

// 요약에 코드 diff를 보낼지: 이 PC의 개인 설정 (기본 끔)
const DIFF_PREF = 'gto:summaryWithDiff'
const readDiffPref = () => { try { return localStorage.getItem(DIFF_PREF) === 'true' } catch { return false } }
const writeDiffPref = (v: boolean) => { try { localStorage.setItem(DIFF_PREF, String(v)) } catch { /* 저장 못 해도 이번 실행에는 적용 */ } }

type Tab = 'board' | 'flow' | 'deploy' | 'actions' | 'assistant' | 'settings' | 'guide'
// bottom = 사이드바 맨 아래에 따로 둔다
const TABS: { id: Tab; label: string; icon: ReactNode; bottom?: boolean }[] = [
  { id: 'board', label: '에픽 보드', icon: <LayoutGrid /> },
  { id: 'flow', label: '흐름', icon: <Route /> },
  { id: 'deploy', label: '배포', icon: <Rocket /> },
  { id: 'actions', label: 'Actions', icon: <Workflow /> },
  { id: 'assistant', label: '도우미', icon: <MessageCircleQuestion /> },
  { id: 'settings', label: '설정', icon: <Settings /> },
  { id: 'guide', label: '가이드', icon: <BookOpen />, bottom: true },
]

export default function App() {
  const [token, setToken] = useState<string | null>()
  const [tab, setTab] = useState<Tab>('board')
  const [files, setFiles] = useState<ProfileFile[]>([])
  const [cur, setCur] = useState(0)
  const [editing, setEditing] = useState<Editing>()
  const [epics, setEpics] = useState<Epic[]>([])
  const [issues, setIssues] = useState<Issue[]>([])
  const [jira, setJira] = useState(new Map<string, JiraInfo>())
  const [releases, setReleases] = useState<Map<string, Release>>() // 카드 id → 개발 배포·태그·배포 (흐름)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>() // 설정 화면 알림
  const [newEpic, setNewEpic] = useState('')
  const [dragging, setDragging] = useState<Issue>()
  const [job, setJob] = useState<{ label: string; done: number; total: number; current?: Issue }>() // 요약 진행 상황
  const [withDiff, setWithDiff] = useState(readDiffPref)
  const [newIssue, setNewIssue] = useState<{ epic?: Epic; parent?: Issue }>() // 이슈 만들기 창 (칸의 에픽 또는 상위 이슈가 정해짐)
  const [jiraView, setJiraView] = useState<Issue>() // Jira 미리보기 패널
  const [subView, setSubView] = useState<Issue>() // 하위 작업 패널 (오른쪽 패널은 하나만)
  const [flowView, setFlowView] = useState<Issue>() // 흐름 패널
  const [chat, setChat] = useState<ChatMsg[]>([]) // 도우미 대화 (탭을 옮겨도 유지, 앱을 끄면 사라짐)
  const closeDrawers = () => { setJiraView(undefined); setSubView(undefined); setFlowView(undefined) }
  const showJira = (i: Issue) => { closeDrawers(); setJiraView(i) }
  const showSubs = (i: Issue) => { closeDrawers(); setSubView(i) }
  const showFlow = (i: Issue) => { closeDrawers(); setFlowView(i) }
  // 카드의 버튼은 같은 이슈의 패널이 열려 있으면 닫는다
  const same = (a: Issue | undefined, b: Issue) => !!a && cardId(a) === cardId(b)
  const toggleJira = (i: Issue) => (same(jiraView, i) ? setJiraView(undefined) : showJira(i))
  const toggleSubs = (i: Issue) => (same(subView, i) ? setSubView(undefined) : showSubs(i))
  const toggleFlow = (i: Issue) => (same(flowView, i) ? setFlowView(undefined) : showFlow(i))
  const [importing, setImporting] = useState(false) // Jira 에픽 가져오기 창
  const [menu, setMenu] = useState<MenuState>() // 우클릭 메뉴
  const [renamingEpic, setRenamingEpic] = useState<string>() // 이름을 바꾸는 중인 에픽 칸
  const newEpicInput = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState(new Set<string>()) // 선택한 카드 id (일괄 이동, 상태 변경)
  const anchor = useRef<string | undefined>(undefined) // Shift 범위 선택의 기준 카드
  const dragEndedAt = useRef(0) // 드래그 직후 따라오는 click은 선택으로 치지 않음
  const [filters, setFilters] = useState<Filters>(loadFilters)
  useEffect(() => saveFilters(filters), [filters])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const profile = files[cur]?.profile

  useEffect(() => { window.gto.getToken().then((t) => { if (t) setAuth(t); setToken(t) }) }, [])

  const loadAll = (select?: string) =>
    loadProfiles()
      .then((fs) => { setFiles(fs); setCur(Math.max(0, fs.findIndex((f) => f.file === select))) })
      .catch((e) => setError(String(e)))
  useEffect(() => { if (token) loadAll() }, [token])

  // 보드 다시 읽기. 겹쳐서 부르면 마지막 요청의 응답만 반영한다 (늦게 온 옛 응답이 최신 화면을 덮지 않게)
  const loadSeq = useRef(0)
  const [loadedAt, setLoadedAt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const reload = () => {
    if (!profile) return
    const seq = ++loadSeq.current
    const latest = () => seq === loadSeq.current
    setRefreshing(true)
    loadBoard(profile)
      .then((b) => {
        if (!latest()) return
        setEpics(b.epics); setIssues(b.issues); setLoadedAt(Date.now())
        // 흐름(태그·배포)은 보드가 뜬 뒤에 이어서 읽는다. 실패해도 보드는 그대로
        return loadReleases(b.issues).then((m) => latest() && setReleases(m))
          .catch((e) => latest() && setError((prev) => `${prev}
배포 흐름 조회 실패: ${e}`.trim()))
      })
      .catch((e) => latest() && setError(String(e)))
      .finally(() => latest() && setRefreshing(false))
    // F5: Jira 정보는 있으면 붙이고, 실패해도 보드는 쓸 수 있게
    window.gto.jiraConfigured().then((ok) => { if (ok) return loadJira(profile).then((m) => latest() && setJira(m)) })
      .catch((e) => latest() && setError((prev) => `${prev}\nJira 조회 실패: ${e}`.trim()))
  }
  useEffect(reload, [profile])

  // 배포 탭: 볼 때만 읽는다 (탭을 열 때, 보드를 다시 읽을 때)
  const [deploys, setDeploys] = useState<{ rows?: DeployRow[]; error?: string }>({})
  useEffect(() => {
    if (tab !== 'deploy' || !profile) return
    let alive = true
    loadDeploys(profile.repos).then((rows) => alive && setDeploys({ rows }), (e) => alive && setDeploys({ error: String(e) }))
    return () => { alive = false }
  }, [tab, profile, loadedAt])

  // GitHub에 쓴 뒤: 바로 한 번, 그리고 Actions가 Jira에 반영할 시간(보통 30초~1분)을 두고 몇 번 더 읽는다
  const followUps = useRef<number[]>([])
  const [waitingJira, setWaitingJira] = useState(false)
  const refreshAfterWrite = () => {
    reload()
    followUps.current.forEach(clearTimeout)
    setWaitingJira(true)
    followUps.current = [20_000, 50_000, 90_000].map((ms, i, all) =>
      window.setTimeout(() => { reloadRef.current(); if (i === all.length - 1) setWaitingJira(false) }, ms))
  }

  // 자동 새로고침: 창으로 돌아올 때, 그리고 보고 있는 동안 2분마다. 끄는 중·작성 중·요약 중에는 건너뛴다
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  const idle = useRef(true)
  idle.current = (tab === 'board' || tab === 'flow' || tab === 'deploy') && !dragging && !newIssue && !importing && !editing && !job
  const loadedAtRef = useRef(0)
  loadedAtRef.current = loadedAt
  const [now, setNow] = useState(Date.now()) // "n분 전" 표시용
  useEffect(() => {
    const refresh = () => { if (idle.current && document.visibilityState === 'visible') reloadRef.current() }
    const onFocus = () => { if (Date.now() - loadedAtRef.current > 10_000) refresh() }
    const auto = window.setInterval(refresh, 120_000)
    const clock = window.setInterval(() => setNow(Date.now()), 15_000)
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(auto); clearInterval(clock); window.removeEventListener('focus', onFocus); followUps.current.forEach(clearTimeout) }
  }, [])

  // Esc: 선택 해제 (입력 중일 때는 제외)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof Element && e.target.closest('input, textarea, select')
      if (e.key === 'Escape' && !typing) setSelected(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // 오른쪽 패널: 패널 밖(보드 바탕, 다른 카드 등)을 누르거나 Esc면 닫힘.
  // 우클릭 메뉴, 패널에서 연 창, 패널을 여닫는 카드 버튼(data-drawer-toggle)은 빼고
  const drawerOpen = !!jiraView || !!subView || !!flowView
  useEffect(() => {
    if (!drawerOpen) return
    const keep = (t: EventTarget | null) => t instanceof Element && !!t.closest('.drawer, .menu, .backdrop, [data-drawer-toggle]')
    const close = closeDrawers
    const onDown = (e: MouseEvent) => { if (!keep(e.target)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof Element && e.target.closest('.backdrop'))) close() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [drawerOpen])
  // 필터에 맞는 이슈와 에픽 칸. 하위 작업은 칸에 따로 두지 않고 상위 카드의 "하위 n/m"과 하위 작업 패널로 본다
  const tops = issues.filter((i) => !i.parent)
  const visible = tops.filter((i) => matches(filters, i, jira.get(cardId(i))))
  const visibleEpics = epics.filter((e) =>
    (filters.status !== 'open' || !e.closed)
    && (!filters.epic || filters.epic === e.key)
    && (!filters.hideEmpty || visible.some((i) => i.epic === e.key)))
  const showNone = (!filters.epic || filters.epic === NONE) && (!filters.hideEmpty || visible.some((i) => !i.epic))
  const visibleIds = visible.map(cardId).join(',')
  // 보이지 않게 된 카드(닫힘, 필터로 가려짐)는 선택에서 뺀다
  useEffect(() => {
    const ids = new Set(visibleIds.split(','))
    setSelected((s) => (([...s].every((id) => ids.has(id))) ? s : new Set([...s].filter((id) => ids.has(id)))))
  }, [visibleIds])

  // 프로필 → 각 레포 Actions Variable
  const publish = async (p: Profile) => {
    setNotice({ ok: true, text: `Actions에 프로필 반영 중… (${p.repos.join(', ')})` })
    const failed = await publishProfile(p)
    setNotice(failed.length
      ? { ok: false, text: `Actions Variable 반영 실패 (토큰에 Variables 쓰기 권한이 필요합니다)\n${failed.join('\n')}` }
      : { ok: true, text: `프로필 "${p.name}"을 ${p.repos.length}개 레포의 Variable GTO_PROFILE에 반영했습니다.` })
  }

  // GitHub 쓰기 후 보드 다시 읽기 (+ Jira 반영 따라가기)
  const act = (f: () => Promise<unknown>) => f().then(refreshAfterWrite, (e) => setError(String(e)))

  if (token === undefined) return null
  if (!token) {
    return (
      <div className="app">
        <TitleBar crumbs={['시작하기']} />
        <div className="welcome">
          <div className="panel">
            <h2><KeyRound /> GitHub 토큰</h2>
            <GithubTokenForm onSaved={setToken} />
          </div>
        </div>
      </div>
    )
  }

  // 카드들을 에픽(target '' = 미분류)으로 옮긴다. 화면을 먼저 바꾸고 API는 뒤에
  const moveTo = async (moving: Issue[], target: string) => {
    moving = moving.filter((i) => i.epic !== target)
    if (!moving.length) return
    const ids = new Set(moving.map(cardId))
    setIssues((all) => all.map((i) => (ids.has(cardId(i)) ? { ...i, epic: target } : i)))
    const epic = epics.find((e) => e.key === target)
    const failed: string[] = []
    // 순서대로: 같은 레포에 마일스톤이 없을 때 여러 장이 동시에 만들지 않게
    for (const i of moving) await assign(i, epic).catch((e) => failed.push(`#${i.number}: ${e}`))
    if (failed.length) setError(`이동 실패 ${failed.length}건\n${failed.join('\n')}`)
    refreshAfterWrite()
  }

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    setDragging(undefined)
    dragEndedAt.current = Date.now()
    const target = over && (over.id === NONE ? '' : String(over.id))
    const issue = issues.find((i) => cardId(i) === active.id)
    if (!issue || target === null) return
    // 선택된 카드를 끌면 선택한 카드 전부, 아니면 그 카드만
    await moveTo(selected.has(cardId(issue)) ? issues.filter((i) => selected.has(cardId(i))) : [issue], target)
  }

  // 클릭: 하나만 선택(다시 누르면 해제), Ctrl/⌘: 추가·빼기, Shift: 같은 칸에서 범위 선택
  const onCardClick = (i: Issue, e: React.MouseEvent) => {
    if (Date.now() - dragEndedAt.current < 250 || (e.target as HTMLElement).closest('a, button')) return
    const id = cardId(i)
    setSelected((s) => {
      if (e.shiftKey && anchor.current) {
        const col = issues.filter((x) => x.epic === i.epic).map(cardId)
        const [a, b] = [col.indexOf(anchor.current), col.indexOf(id)].sort((x, y) => x - y)
        if (a >= 0) return new Set([...s, ...col.slice(a, b + 1)])
      }
      anchor.current = id
      if (e.ctrlKey || e.metaKey) { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }
      return s.size === 1 && s.has(id) ? new Set() : new Set([id])
    })
  }

  const selectedIssues = issues.filter((i) => selected.has(cardId(i)))
  const bulkState = async (state: 'open' | 'closed', from: Issue[] = selectedIssues) => {
    const targets = from.filter((i) => i.state !== state)
    setSelected(new Set())
    // 화면부터 바꾼다 (실패한 카드는 다시 읽으면 원래대로)
    const ids = new Set(targets.map(cardId))
    setIssues((all) => all.map((i) => (ids.has(cardId(i)) ? { ...i, state } : i)))
    const failed: string[] = []
    for (const i of targets) await setIssueState(i, state).catch((e) => failed.push(`#${i.number}: ${e}`))
    if (failed.length) setError(`상태 변경 실패 ${failed.length}건\n${failed.join('\n')}`)
    refreshAfterWrite()
  }

  // 요약이 필요한 이슈들을 하나씩 요약 (에픽 하나 또는 전체). 실패한 이슈가 있어도 나머지는 계속한다.
  const summarizeAll = async (targets: Issue[], label: string) => {
    if (!targets.length || job) return
    if (!(await window.gto.claudeConfigured())) return setError('요약 엔진을 먼저 설정하세요 (설정 화면)')
    setError('')
    const failed: string[] = []
    for (const [n, issue] of targets.entries()) {
      setJob({ label, done: n, total: targets.length, current: issue })
      await summarizeIssue(issue, withDiff).catch((e) => failed.push(`#${issue.number}: ${e}`))
    }
    setJob(undefined)
    if (failed.length) setError(`요약 실패 ${failed.length}건\n${failed.join('\n')}`)
    refreshAfterWrite()
  }
  const pending = (epic?: string) => issues.filter((i) => i.state === 'open' && i.needsSummary && (epic === undefined || i.epic === epic))

  // ── 우클릭 메뉴 ──
  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, items }) }
  const copy = (text: string) => copyText(text).catch((e) => setError(`복사 실패: ${e}`))
  const openEpics = epics.filter((e) => !e.closed)
  const milestoneUrl = (e: Epic) => { const [repo, n] = Object.entries(e.byRepo)[0]; return `https://github.com/${repo}/milestone/${n}` }

  // 카드: 선택된 카드를 누르면 선택 전체에, 아니면 그 카드만 선택하고 그 카드에 (Finder와 같은 방식)
  const cardMenu = (i: Issue): MenuItem[] => {
    const many = selected.has(cardId(i)) && selected.size > 1
    if (!many) { setSelected(new Set([cardId(i)])); anchor.current = cardId(i) }
    const targets = many ? selectedIssues : [i]
    const label = many ? `${targets.length}개` : `#${i.number}`
    const move: MenuItem[] = [
      { label: 'No milestone', disabled: targets.every((t) => !t.epic), onSelect: () => moveTo(targets, '') },
      ...openEpics.map((e): MenuItem => ({ label: e.title, disabled: targets.every((t) => t.epic === e.key), onSelect: () => moveTo(targets, e.key) })),
    ]
    return [
      ...(!many ? [
        { label: 'GitHub에서 열기', icon: <ExternalLink />, hint: '더블클릭', onSelect: () => window.open(i.url, '_blank') },
        { label: 'Jira에서 보기', icon: <SquareArrowOutUpRight />, onSelect: () => showJira(i) },
        'separator' as const,
        { label: `하위 작업 보기${i.subs.total ? ` (${i.subs.done}/${i.subs.total})` : ''}`, icon: <ListTree />, onSelect: () => showSubs(i) },
        { label: '하위 작업 만들기', icon: <ListPlus />, onSelect: () => setNewIssue({ parent: i }) },
        'separator' as const,
      ] : []),
      { label: `${label} 에픽으로 이동`, icon: <MoveRight />, submenu: move },
      ...(targets.some((t) => t.state === 'open')
        ? [{ label: `${label} 닫기 (완료)`, icon: <CheckCircle2 />, onSelect: () => confirm(`${targets.filter((t) => t.state === 'open').length}개 이슈를 닫을까요? Jira 작업은 완료로 바뀝니다.`) && bulkState('closed', targets) }]
        : []),
      ...(targets.some((t) => t.state === 'closed') ? [{ label: `${label} 다시 열기`, icon: <RotateCcw />, onSelect: () => bulkState('open', targets) }] : []),
      'separator',
      ...(!many ? [
        { label: '이슈 링크 복사', icon: <Link2 />, onSelect: () => copy(i.url) },
        { label: `커밋용 번호 복사 (#${i.number})`, icon: <Hash />, onSelect: () => copy(`#${i.number}`) },
      ] : [
        { label: '선택 해제', icon: <X />, hint: 'Esc', onSelect: () => setSelected(new Set()) },
      ]),
    ]
  }

  // 에픽 칸 (key '' = No milestone)
  const columnMenu = (e?: Epic): MenuItem[] => {
    const key = e?.key ?? ''
    const n = pending(key).length
    return [
      { label: e ? '이 에픽에 이슈 만들기' : '이슈 만들기', icon: <Plus />, onSelect: () => setNewIssue({ epic: e }) },
      { label: e ? '이 에픽만 보기' : '이 칸만 보기', icon: <Eye />, onSelect: () => setFilters({ ...filters, view: 'tasks', epic: e ? e.key : NONE }) },
      { label: `작업 요약${n ? ` (${n})` : ''}`, icon: <Sparkles />, disabled: !n || !!job, onSelect: () => summarizeAll(pending(key), e?.title ?? 'No milestone') },
      ...(e ? [
        'separator' as const,
        {
          label: '이름 바꾸기', icon: <Pencil />, hint: '더블클릭',
          // 에픽만 보기에는 이름을 바꿀 칸이 없으므로 그 에픽의 작업 보기로 바꾼 뒤 칸의 이름 편집을 연다
          onSelect: () => { if (filters.view === 'epics') setFilters({ ...DEFAULT_FILTERS, view: 'tasks', epic: e.key }); setRenamingEpic(e.key) },
        },
        ...(e.jiraKey && profile ? [{ label: `Jira에서 에픽 열기 (${e.jiraKey})`, icon: <SquareArrowOutUpRight />, onSelect: () => window.open(`${profile.jira.baseUrl}/browse/${e.jiraKey}`, '_blank') }] : []),
        { label: 'GitHub 마일스톤 열기', icon: <ExternalLink />, onSelect: () => window.open(milestoneUrl(e), '_blank') },
        'separator' as const,
        { label: '에픽 닫기', icon: <Archive />, danger: true, onSelect: () => confirm(`"${e.title}" 에픽을 모든 레포에서 닫을까요?`) && act(() => closeEpic(e)) },
      ] : []),
    ]
  }

  // 보드 바탕
  const boardMenu = (): MenuItem[] => [
    { label: '새 이슈', icon: <Plus />, onSelect: () => setNewIssue({}) },
    { label: '새 마일스톤…', icon: <Flag />, onSelect: () => newEpicInput.current?.focus() },
    'separator',
    { label: '보이는 카드 전체 선택', icon: <CheckCircle2 />, disabled: !visible.length, onSelect: () => setSelected(new Set(visible.map(cardId))) },
    { label: '새로고침', icon: <RefreshCw />, onSelect: reload },
    { label: '필터 초기화', icon: <RotateCcw />, onSelect: () => setFilters({ ...DEFAULT_FILTERS, view: filters.view }) },
  ]

  const card = (i: Issue) => (
    <Card key={cardId(i)} issue={i} jira={jira.get(cardId(i))} busy={job?.current === i} selected={selected.has(cardId(i))}
      onClick={(e) => onCardClick(i, e)} onMenu={(e) => openMenu(e, cardMenu(i))} onJira={() => toggleJira(i)} onSubs={() => toggleSubs(i)} />
  )
  const cardsOf = (epic: string) => visible.filter((i) => i.epic === epic).map(card)
  const current = TABS.find((t) => t.id === tab)!

  return (
    <div className="app">
      <TitleBar crumbs={[profile?.name ?? '', editing ? (editing.sha ? '프로필 편집' : '새 프로필') : current.label]} />
      <div className="app-body">
      <aside className="sidebar">
        <div className="section-label">프로필</div>
        <select value={cur} onChange={(e) => setCur(Number(e.target.value))}>
          {files.map((f, i) => <option key={f.file} value={i}>{f.profile.name}</option>)}
        </select>
        <div className="section-label">메뉴</div>
        {TABS.map((t) => (
          <button key={t.id} className={['nav-item', tab === t.id && !editing && 'on', t.bottom && 'nav-bottom'].filter(Boolean).join(' ')}
            onClick={() => { setTab(t.id); setEditing(undefined) }}>
            {t.icon}{t.label}
          </button>
        ))}
        {profile && (
          <div className="sidebar-foot">
            <div><span className="dot green" />Jira {profile.jira.project}</div>
            {profile.repos.map((r) => <div key={r} className="muted"><FolderGit2 size={11} style={{ marginRight: 6, verticalAlign: -1 }} />{r.split('/')[1]}</div>)}
          </div>
        )}
      </aside>

      <main className="content">
        {editing ? (
          <ProfileEditor value={editing} onCancel={() => setEditing(undefined)}
            onSaved={(file, p) => { setEditing(undefined); setTab('settings'); loadAll(file); publish(p) }} />
        ) : (
          <>
            <header className="topbar">
              <h1>{tab === 'assistant' ? '프로젝트 도우미' : current.label}</h1>
              {tab === 'guide' && <span className="sub">설정부터 유지보수까지 실제 화면으로 순서대로 봅니다 · ← → 키로 넘깁니다</span>}
              {tab === 'assistant' && <span className="sub">코드와 보드를 읽고 답합니다. 코드를 고치지는 않습니다.</span>}
              {tab === 'deploy' && (
                <span className="sub">정식 태그가 붙으면 release 워크플로가 빌드해 릴리스를 만듭니다 · {loadedAt > 0 && `${ago(now, loadedAt)} 갱신`}</span>
              )}
              {tab === 'flow' && (
                <span className="sub">이슈 → Jira → 커밋 → 개발 배포 → 태그 → 배포 · {releases ? `${ago(now, loadedAt)} 갱신` : '태그·배포 확인 중…'}</span>
              )}
              {tab === 'board' && (
                <span className="sub">
                  진행 중 {tops.filter((i) => i.state === 'open').length}개 · 에픽 {epics.filter((e) => !e.closed).length}개
                  {loadedAt > 0 && <> · <span title={new Date(loadedAt).toLocaleString()}>{refreshing ? '갱신 중…' : `${ago(now, loadedAt)} 갱신`}</span></>}
                  {waitingJira && <> · <span className="waiting"><Loader2 className="spin" size={12} />Jira 반영 확인 중</span></>}
                </span>
              )}
              <span className="grow" />
              {(tab === 'flow' || tab === 'deploy') && (
                <button className="icon ghost" onClick={reload} disabled={refreshing} title="새로고침"><RefreshCw className={refreshing ? 'spin' : undefined} /></button>
              )}
              {tab === 'board' && (
                <>
                  <button className="icon ghost" onClick={reload} disabled={refreshing} title="새로고침"><RefreshCw className={refreshing ? 'spin' : undefined} /></button>
                  <button disabled={!!job || !pending().length} onClick={() => summarizeAll(pending(), '전체')}
                    title="커밋이 새로 쌓인 이슈를 모두 Claude로 요약해 이슈 본문에 씁니다 (Jira에도 반영)">
                    <Sparkles />전체 요약{pending().length ? ` (${pending().length})` : ''}
                  </button>
                  <form onSubmit={(e) => {
                    e.preventDefault()
                    if (!profile || !newEpic.trim()) return
                    act(() => createEpic(profile, newEpic.trim())).then(() => setNewEpic(''))
                  }}>
                    <input ref={newEpicInput} placeholder="새 마일스톤 (= Jira 에픽)" value={newEpic} onChange={(e) => setNewEpic(e.target.value)} />
                    <button title="프로필의 모든 레포에 같은 이름으로 만듭니다"><Plus />마일스톤 만들기</button>
                  </form>
                  <button className="icon" onClick={() => setImporting(true)} title="Jira에 이미 있는 에픽을 마일스톤으로 가져오기"><Download /></button>
                  <button className="primary" onClick={() => setNewIssue({})}><Plus />이슈 만들기</button>
                </>
              )}
            </header>

            {tab === 'board' && job && (
              <div className="banner info">
                <Loader2 className="spin" size={14} />
                {job.label} 요약 중 {job.done + 1}/{job.total} · #{job.current?.number} {job.current?.title}
              </div>
            )}
            {(tab === 'board' || tab === 'flow') && error && (
              <div className="banner closable">
                <span className="grow">{error}</span>
                <button className="link" onClick={() => setError('')} title="닫기"><X size={14} /></button>
              </div>
            )}

            <div className="view">
              {tab === 'actions' && profile && <Actions profile={profile} />}
              {tab === 'guide' && <Guide onOpen={(menu) => setTab(TABS.find((t) => t.label === menu)?.id ?? 'board')} />}
              {tab === 'assistant' && profile && (
                <Assistant profile={profile} epics={epics} issues={issues} jira={jira} releases={releases} chat={chat} setChat={setChat} />
              )}

              {tab === 'settings' && (
                <div className="settings">
                  {notice && <div className={notice.ok ? 'banner ok' : 'banner'} style={{ margin: 0 }}>{notice.text}</div>}
                  <section className="panel">
                    <h2><SunMoon />화면 테마</h2>
                    <p className="desc">시스템 설정을 따르거나 라이트/다크로 고정합니다. 이 PC에 저장됩니다.</p>
                    <ThemePicker />
                  </section>
                  <section className="panel">
                    <h2><FolderGit2 />프로필</h2>
                    <p className="desc">레포 묶음, Jira 프로젝트, 담당자 매핑. 저장하면 설정 레포에 커밋되고,
                      Actions가 읽도록 각 레포의 Variable <code>GTO_PROFILE</code>에도 반영됩니다.</p>
                    <div className="row">
                      {profile && (
                        <button onClick={() => publish(profile)} title="프로필을 각 레포의 Actions Variable(GTO_PROFILE)로 올립니다">
                          <Upload />Actions에 반영
                        </button>
                      )}
                      {files[cur] && (
                        <button onClick={() => setEditing({
                          file: files[cur].file, sha: files[cur].sha, before: profile, text: JSON.stringify(profile, null, 2),
                        })}>"{profile?.name}" 편집</button>
                      )}
                      <button onClick={() => setEditing({ file: 'new-profile.json', text: JSON.stringify(NEW_PROFILE, null, 2) })}>
                        <Plus />새 프로필
                      </button>
                    </div>
                  </section>
                  <section className="panel">
                    <h2><KeyRound />GitHub 토큰 <span className="badge required">필수</span></h2>
                    <GithubTokenForm onSaved={(t) => { setToken(t); loadAll() }} />
                  </section>
                  <section className="panel">
                    <h2><GitMerge />Jira 토큰 <span className="badge required">필수</span> <span className="badge">조회 전용</span></h2>
                    <JiraTokenForm onSaved={reload} />
                  </section>
                  <section className="panel">
                    <h2><Bot />작업 요약 엔진</h2>
                    <SummaryEngine />
                    <label className="check">
                      <input type="checkbox" checked={withDiff} onChange={(e) => { setWithDiff(e.target.checked); writeDiffPref(e.target.checked) }} />
                      요약할 때 코드 diff도 보내기 (끄면 커밋 메시지와 파일 목록만 보냄)
                    </label>
                  </section>
                </div>
              )}

              {tab === 'flow' && (
                <FilterBar f={filters} onChange={setFilters} assignees={Object.keys(profile?.assignees ?? {})} views={false}
                  epics={epics.filter((e) => filters.status !== 'open' || !e.closed)} hasJira={jira.size > 0}
                  shown={visible.length} total={tops.filter((i) => filters.status === 'all' || i.state === (filters.status === 'open' ? 'open' : 'closed')).length} />
              )}
              {tab === 'deploy' && <DeployList rows={deploys.rows} error={deploys.error} issues={issues} releases={releases} />}
              {tab === 'flow' && profile && (
                <FlowTable epics={visibleEpics} issues={visible} jira={jira} releases={releases} jiraBase={profile.jira.baseUrl} onOpen={toggleFlow} />
              )}
              {tab === 'board' && (
                <FilterBar f={filters} onChange={setFilters} assignees={Object.keys(profile?.assignees ?? {})}
                  epics={epics.filter((e) => filters.status !== 'open' || !e.closed)} hasJira={jira.size > 0}
                  shown={visible.length} total={tops.filter((i) => filters.status === 'all' || i.state === (filters.status === 'open' ? 'open' : 'closed')).length} />
              )}
              {tab === 'board' && filters.view === 'epics' && (
                <EpicOverview f={filters} epics={visibleEpics} issues={tops} jira={jira} showNone={showNone}
                  onOpen={(key) => setFilters({ ...filters, view: 'tasks', epic: key })}
                  onMenu={(ev, e) => openMenu(ev, columnMenu(e))} />
              )}
              {tab === 'board' && filters.view === 'tasks' && (
                <DndContext sensors={sensors} onDragEnd={onDragEnd}
                  onDragStart={({ active }) => setDragging(issues.find((i) => cardId(i) === active.id))}
                  onDragCancel={() => setDragging(undefined)}>
                  <div className="board" onContextMenu={(e) => openMenu(e, boardMenu())} onClick={(e) => {
                    if (Date.now() - dragEndedAt.current < 250) return
                    if (!(e.target as Element).closest('[aria-selected], button, a, input, select, form')) setSelected(new Set())
                  }}>
                    {showNone && (
                      <Column id={NONE} title="No milestone" onAdd={() => setNewIssue({})}
                        renaming={false} setRenaming={() => {}} onMenu={(ev) => openMenu(ev, columnMenu())}
                        pending={pending('').length} busy={!!job} onSummarize={() => summarizeAll(pending(''), 'No milestone')}>
                        {cardsOf('')}
                      </Column>
                    )}
                    {visibleEpics.map((e) => (
                      <Column key={e.key} id={e.key} title={e.title} onAdd={() => setNewIssue({ epic: e })}
                        renaming={renamingEpic === e.key} setRenaming={(on) => setRenamingEpic(on ? e.key : undefined)}
                        onMenu={(ev) => openMenu(ev, columnMenu(e))}
                        pending={pending(e.key).length} busy={!!job} onSummarize={() => summarizeAll(pending(e.key), e.title)}
                        onRename={(t) => act(() => renameEpic(e, t))}
                        onClose={() => confirm(`"${e.title}" 에픽을 모든 레포에서 닫을까요?`) && act(() => closeEpic(e))}>
                        {cardsOf(e.key)}
                      </Column>
                    ))}
                  </div>
                  <DragOverlay>{dragging && (
                    <CardBody issue={dragging} jira={jira.get(cardId(dragging))} overlay
                      count={selected.has(cardId(dragging)) ? selected.size : 1} />
                  )}</DragOverlay>
                </DndContext>
              )}
              {tab === 'board' && profile && newIssue && (
                <NewIssueDialog profile={profile} epics={epics} epic={newIssue.epic} parent={newIssue.parent} onClose={() => setNewIssue(undefined)}
                  onCreated={() => { setNewIssue(undefined); refreshAfterWrite() }} />
              )}
              {tab === 'board' && selected.size > 0 && (
                // 선택한 카드 일괄 작업: 이동, 닫기(Jira 완료), 다시 열기(완료 포함 필터일 때)
                <div className="selection-bar" role="toolbar" aria-label="선택한 이슈 일괄 작업">
                  <span className="count-label">{selected.size}개 선택</span>
                  <select value="" aria-label="에픽으로 이동"
                    onChange={(e) => { const t = e.target.value; if (t) moveTo(selectedIssues, t === NONE ? '' : t).then(() => setSelected(new Set())) }}>
                    <option value="">에픽으로 이동…</option>
                    <option value={NONE}>No milestone</option>
                    {epics.map((e) => <option key={e.key} value={e.key}>{e.title}</option>)}
                  </select>
                  {selectedIssues.some((i) => i.state === 'open') && (
                    <button onClick={() => confirm(`${selectedIssues.filter((i) => i.state === 'open').length}개 이슈를 닫을까요? Jira 작업은 완료로 바뀝니다.`) && bulkState('closed')}>
                      <CheckCircle2 />닫기 (완료)
                    </button>
                  )}
                  {selectedIssues.some((i) => i.state === 'closed') && (
                    <button onClick={() => bulkState('open')}><RotateCcw />다시 열기</button>
                  )}
                  <button onClick={() => setSelected(new Set(visible.map(cardId)))}>보이는 것 전체 선택</button>
                  <button className="ghost" onClick={() => setSelected(new Set())} title="Esc">선택 해제</button>
                </div>
              )}
              {tab === 'board' && profile && importing && (
                <ImportEpicsDialog profile={profile} onClose={() => setImporting(false)} onDone={refreshAfterWrite} />
              )}
              {(tab === 'board' || tab === 'flow') && profile && flowView && (
                <FlowPanel issue={flowView} jira={jira.get(cardId(flowView))} release={releases?.get(cardId(flowView))}
                  jiraBase={profile.jira.baseUrl} onClose={() => setFlowView(undefined)} />
              )}
              {tab === 'board' && profile && jiraView && (
                <JiraPanel profile={profile} issue={jiraView} knownKey={jira.get(cardId(jiraView))?.key} onClose={() => setJiraView(undefined)} />
              )}
              {tab === 'board' && subView && (
                <SubIssuesPanel issue={subView} jira={jira} version={loadedAt} onCreate={() => setNewIssue({ parent: subView })}
                  onChanged={refreshAfterWrite} onClose={() => setSubView(undefined)} />
              )}
              <ContextMenu menu={menu} onClose={() => setMenu(undefined)} />
            </div>
          </>
        )}
      </main>
      </div>
    </div>
  )
}

// 앱이 그리는 제목 표시줄. 끌어서 창 이동, 오른쪽 창 버튼 자리는 비워 둠 (main/index.ts의 titleBarOverlay)
const TitleBar = ({ crumbs }: { crumbs: string[] }) => (
  <div className={`titlebar ${window.gto.platform}`}>
    <div className="tb-side">
      <img className="brand-mark" src={appIcon} alt="" />
      Gitogether
    </div>
    <div className="tb-main">
      {crumbs.filter(Boolean).map((c, i) => (
        <span key={i} className={i ? 'crumb on' : 'crumb'}>{i > 0 && <ChevronRight />}{c}</span>
      ))}
    </div>
  </div>
)

// 접어 둔 에픽(칸 id)은 이 PC(브라우저)에 기억한다
const CLOSED_EPICS = 'gto.closedEpics'
const closedEpics = (): string[] => { try { return JSON.parse(localStorage.getItem(CLOSED_EPICS) ?? '[]') } catch { return [] } }
const saveClosedEpics = (ids: string[]) => { try { localStorage.setItem(CLOSED_EPICS, JSON.stringify(ids)) } catch { /* 저장 못 해도 이번 실행에는 적용 */ } }

function Column({ id, title, children, pending, busy, renaming, setRenaming, onAdd, onSummarize, onRename, onClose, onMenu }: {
  id: string; title: string; children: ReactNode[]; pending: number; busy: boolean
  renaming: boolean; setRenaming: (on: boolean) => void // 이름 바꾸기는 우클릭 메뉴에서도 시작하므로 상태를 밖에서 갖는다
  onAdd: () => void; onSummarize: () => void; onRename?: (title: string) => void; onClose?: () => void
  onMenu: (e: React.MouseEvent) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const [open, setOpen] = useState(() => !closedEpics().includes(id))
  const toggle = () => { setOpen(!open); saveClosedEpics(open ? [...closedEpics(), id] : closedEpics().filter((x) => x !== id)) }
  return (
    <section ref={setNodeRef} className={`col${isOver ? ' over' : ''}${open ? '' : ' closed'}`}
      onContextMenu={(e) => { if (!(e.target as Element).closest('[aria-selected]')) onMenu(e) }}>
      <div className="col-head">
        <button className="link disclosure" onClick={toggle} aria-expanded={open} title={open ? '접기' : '펼치기'}><ChevronRight /></button>
        <span className={`dot ${onRename ? 'yellow' : ''}`} />
        {renaming ? (
          <form className="grow" onSubmit={(e) => {
            e.preventDefault()
            const t = new FormData(e.currentTarget).get('t')?.toString().trim()
            setRenaming(false)
            if (t && t !== title) onRename!(t)
          }}>
            <input name="t" defaultValue={title} autoFocus onBlur={() => setRenaming(false)} />
          </form>
        ) : (
          <span className="title" title={onRename && '더블클릭해서 이름 변경'} onDoubleClick={() => onRename && setRenaming(true)}>{title}</span>
        )}
        <span className="count">{children.length}</span>
        {pending > 0 && (
          <button className="link summarize" disabled={busy} onClick={onSummarize}
            title="이 에픽에서 커밋이 새로 쌓인 이슈를 요약합니다">
            <Sparkles size={12} />요약 {pending}
          </button>
        )}
        <span className="actions">
          <button className="link" onClick={onAdd} title="이 칸에 이슈 만들기"><Plus size={14} /></button>
          {onClose && <button className="link" onClick={onClose} title="에픽 닫기 (모든 레포)"><X size={13} /></button>}
        </span>
      </div>
      {!open ? null : children.length ? children : <div className="empty">{onRename ? '이슈를 끌어다 놓으세요' : '미분류 이슈 없음'}</div>}
    </section>
  )
}

type CardProps = {
  issue: Issue; jira?: JiraInfo; busy?: boolean; selected?: boolean
  onClick?: (e: React.MouseEvent) => void; onMenu?: (e: React.MouseEvent) => void; onJira?: () => void; onSubs?: () => void
  overlay?: boolean; count?: number
}

function Card(props: CardProps) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: cardId(props.issue) })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={{ opacity: isDragging ? 0.35 : 1 }}
      onClick={props.onClick} onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) window.open(props.issue.url, '_blank') }} onContextMenu={props.onMenu}
      aria-selected={props.selected} title="클릭: 선택 · Ctrl/⌘: 여러 개 · Shift: 범위 · 더블클릭: GitHub에서 열기">
      <CardBody {...props} />
    </div>
  )
}

const CardBody = ({ issue, jira, busy, selected, onJira, onSubs, overlay, count }: CardProps) => (
  <article className={['card', overlay && 'overlay', selected && 'selected', issue.state === 'closed' && 'closed'].filter(Boolean).join(' ')}>
    {overlay && count! > 1 && <span className="drag-count">{count}</span>}
    <div className="card-title">
      <span className={`dot ${issue.state === 'closed' || jira?.category === 'done' ? '' : 'green'}`} />
      <span>{issue.title}</span>
    </div>
    <div className="card-meta">
      <span className="repo">{issue.repo.split('/')[1]}#{issue.number}</span>
      {issue.assignee && <span className="assignee">{issue.assignee}</span>}
      {issue.state === 'closed' && <span className="badge done">완료</span>}
      {jira && (
        <>
          <span className="badge">{jira.key}</span>
          <span className={`badge ${jira.category}`}>{jira.status}</span>
        </>
      )}
      {busy ? <span className="badge indeterminate"><Loader2 className="spin" size={10} />요약 중</span>
        : issue.needsSummary ? <span className="badge indeterminate" title="요약 뒤에 새 커밋이 있음">요약 필요</span>
        : issue.summarized && <span className="badge done">요약됨</span>}
    </div>
    {!overlay && (
      // 드래그가 시작되지 않게 버튼의 포인터 이벤트를 카드로 넘기지 않음
      <div className="card-foot" onPointerDown={(e) => e.stopPropagation()}>
        <a className="link" href={issue.url} target="_blank"><ExternalLink size={12} /> GitHub</a>
        <button className="link" data-drawer-toggle onClick={onJira}><SquareArrowOutUpRight size={12} /> Jira에서 보기</button>
        {issue.subs.total > 0 && (
          <button className="link" data-drawer-toggle onClick={onSubs} title="하위 작업 완료 / 전체">
            <ListTree size={12} /> 하위 {issue.subs.done}/{issue.subs.total}
          </button>
        )}
      </div>
    )}
  </article>
)

function ProfileEditor({ value, onCancel, onSaved }: { value: Editing; onCancel: () => void; onSaved: (file: string, profile: Profile) => void }) {
  const [text, setText] = useState(value.text)
  const [file, setFile] = useState(value.file)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    let p
    try { p = JSON.parse(text) } catch (e) { return setErr(`JSON 오류: ${(e as Error).message}`) }
    const problem = checkProfile(p, value.before) ?? (/^[\w.-]+\.json$/.test(file) ? null : '파일 이름은 영문, 숫자, -, _ 와 .json')
    if (problem) return setErr(problem)
    setSaving(true)
    try {
      await saveProfile({ file, sha: value.sha, profile: p })
      onSaved(file, p)
    } catch (e) {
      setErr(String(e))
      setSaving(false)
    }
  }

  return (
    <div className="editor">
      <div className="bar">
        <h2>{value.sha ? '프로필 편집' : '새 프로필'}</h2>
        <input value={file} onChange={(e) => setFile(e.target.value)} disabled={!!value.sha} />
        <span className="grow" />
        <button onClick={onCancel}>취소</button>
        <button className="primary" onClick={save} disabled={saving}>저장 (커밋)</button>
      </div>
      {err && <div className="banner">{err}</div>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    </div>
  )
}

function GithubTokenForm({ onSaved }: { onSaved: (t: string) => void }) {
  const [t, setT] = useState('')
  const [configured, setConfigured] = useState<boolean>()
  useEffect(() => { window.gto.getToken().then((x) => setConfigured(!!x)) }, [])
  const lock = useLock(configured)
  return (
    <form className="stack" onSubmit={async (e) => {
      e.preventDefault()
      if (!t.trim()) return
      await window.gto.setToken(t.trim())
      setAuth(t.trim())
      setT('')
      setConfigured(true)
      lock.done()
      onSaved(t.trim())
    }}>
      <p className="desc">프로필 레포의 Issues 읽기/쓰기 권한이 필요합니다. Actions 화면에서 워크플로를 수정하려면 workflow 권한(fine-grained: Workflows write)도 필요합니다.
        {STORED} <Configured value={configured} /></p>
      <input type="password" disabled={lock.locked} placeholder={lock.locked ? '저장됨' : 'ghp_... 또는 github_pat_...'} value={t} onChange={(e) => setT(e.target.value)} />
      <LockButtons lock={lock} />
    </form>
  )
}

// 이미 설정된 값은 잠가 두고 "변경"을 눌러야 고칠 수 있게
function useLock(configured?: boolean) {
  const [editing, setEditing] = useState(false)
  return { locked: !!configured && !editing, configured: !!configured, edit: () => setEditing(true), done: () => setEditing(false) }
}
const LockButtons = ({ lock }: { lock: ReturnType<typeof useLock> }) => (
  <div className="row">
    {lock.locked ? <button type="button" onClick={lock.edit}><Pencil />변경</button> : (
      <>
        <button className="primary">저장</button>
        {lock.configured && <button type="button" className="ghost" onClick={lock.done}>취소</button>}
      </>
    )}
  </div>
)

function ThemePicker() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>()
  useEffect(() => { window.gto.getTheme().then(setTheme) }, [])
  const choose = (t: 'system' | 'light' | 'dark') => window.gto.setTheme(t).then(() => setTheme(t))
  const options = [
    { id: 'system', label: '시스템 설정', icon: <Monitor /> },
    { id: 'light', label: '라이트', icon: <Sun /> },
    { id: 'dark', label: '다크', icon: <Moon /> },
  ] as const
  return (
    <div className="segmented" role="radiogroup" aria-label="화면 테마">
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={theme === o.id} className={theme === o.id ? 'on' : ''} onClick={() => choose(o.id)}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  )
}

const ENGINES = [
  { id: 'claude', label: 'Claude CLI', hint: 'Claude Code에 로그인한 계정(Pro/Max 구독)으로 요약합니다', cmd: 'claude' },
  { id: 'codex', label: 'Codex CLI', hint: 'Codex CLI에 로그인한 ChatGPT 계정(Plus/Pro 구독)으로 요약합니다', cmd: 'codex' },
  { id: 'antigravity', label: 'Antigravity CLI', hint: 'Antigravity CLI에 로그인한 Google 계정으로 요약합니다', cmd: 'agy' },
  { id: 'api', label: 'API 키', hint: 'Anthropic API 키로 요약합니다 (구독과 별도로 사용량만큼 과금)', cmd: '' },
] as const

// CLI 엔진은 이 PC(웹이면 서버 PC)에 설치·로그인된 CLI를 실행해 그 구독으로 요약한다
function SummaryEngine() {
  const [engine, setEngine] = useState<(typeof ENGINES)[number]['id']>()
  const [keySet, setKeySet] = useState<boolean>()
  const [editing, setEditing] = useState(false)
  useEffect(() => { window.gto.getEngine().then(setEngine) }, [])
  useEffect(() => { window.gto.claudeConfigured().then(setKeySet) }, [engine])
  const cur = ENGINES.find((o) => o.id === engine)
  // CLI는 고르면 설정 끝 (로그인은 CLI가 관리), API 키는 키가 저장돼 있어야 설정됨
  const ready = engine !== undefined && (engine !== 'api' || !!keySet)
  const locked = ready && !editing
  return (
    <div className="stack">
      <p className="desc">보드 카드의 "작업 요약"에만 씁니다. 요약은 이슈 본문 작업 내용 칸에 쓰이고, 동기화로 Jira에도 반영됩니다.
        {' '}<Configured value={engine === undefined ? undefined : ready} /></p>
      <div className="row">
        <div className="segmented" role="radiogroup" aria-label="요약 엔진">
          {ENGINES.map((o) => (
            <button key={o.id} role="radio" aria-checked={engine === o.id} className={engine === o.id ? 'on' : ''} disabled={locked && engine !== o.id}
              onClick={() => !locked && window.gto.setEngine(o.id).then(() => setEngine(o.id))}>{o.label}</button>
          ))}
        </div>
        {locked ? <button type="button" onClick={() => setEditing(true)}><Pencil />변경</button>
          : ready && <button type="button" className="ghost" onClick={() => setEditing(false)}>완료</button>}
      </div>
      {cur && <p className="desc">{cur.hint}.{cur.cmd && (window.gto.platform === 'web'
        ? <> 웹은 <b>서버 PC</b>의 CLI를 씁니다. 서버 PC 터미널에서 <code>{cur.cmd}</code>를 한 번 실행해 로그인해 두면, 접속한 모두가 그 계정으로 요약합니다.</>
        : <> 터미널에서 <code>{cur.cmd}</code>를 한 번 실행해 로그인해 두면 됩니다.</>)}</p>}
      {engine === 'api' && <ClaudeKeyForm onSaved={() => { setKeySet(true); setEditing(false) }} />}
    </div>
  )
}

function ClaudeKeyForm({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [configured, setConfigured] = useState<boolean>()
  useEffect(() => { window.gto.claudeConfigured().then(setConfigured) }, [])
  const lock = useLock(configured)
  return (
    <form className="stack" onSubmit={async (e) => {
      e.preventDefault()
      if (!key.trim()) return
      await window.gto.setClaudeKey(key.trim())
      setKey('')
      setConfigured(true)
      lock.done()
      onSaved()
    }}>
      <p className="desc">{STORED}</p>
      <input type="password" disabled={lock.locked} placeholder={lock.locked ? '저장됨' : 'sk-ant-...'} value={key} onChange={(e) => setKey(e.target.value)} />
      <LockButtons lock={lock} />
    </form>
  )
}

function JiraTokenForm({ onSaved }: { onSaved: () => void }) {
  const [email, setEmail] = useState('')
  const [t, setT] = useState('')
  const [configured, setConfigured] = useState<boolean>()
  useEffect(() => { window.gto.jiraConfigured().then(setConfigured) }, [])
  const lock = useLock(configured)
  return (
    <form className="stack" onSubmit={async (e) => {
      e.preventDefault()
      if (!email.trim() || !t.trim()) return
      await window.gto.setJira(email.trim(), t.trim())
      setT('')
      setConfigured(true)
      lock.done()
      onSaved()
    }}>
      <p className="desc">보드 카드에 Jira 키와 상태를 보여 주는 데만 씁니다. 앱은 Jira에 쓰지 않습니다. <Configured value={configured} /></p>
      <input disabled={lock.locked} placeholder={lock.locked ? '저장됨' : 'Atlassian 계정 이메일'} value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" disabled={lock.locked} placeholder={lock.locked ? '저장됨' : 'Jira API 토큰'} value={t} onChange={(e) => setT(e.target.value)} />
      <LockButtons lock={lock} />
    </form>
  )
}

const STORED = window.gto.platform === 'web'
  ? '서버에 저장하며 브라우저로는 내보내지 않습니다. 이 서버에 접속하는 모두가 함께 씁니다.'
  : 'OS 키체인으로 암호화해 이 PC에만 저장합니다.'

const Configured = ({ value }: { value?: boolean }) =>
  value === undefined ? null : <span className={value ? 'badge done' : 'badge'}>{value ? '설정됨' : '미설정'}</span>
