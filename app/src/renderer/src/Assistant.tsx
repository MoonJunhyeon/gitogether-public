// 프로젝트 도우미: 보드 정보와 (CLI 엔진이면) 레포 코드를 읽고 답만 한다. 고치거나 GitHub·Jira에 쓰지 않는다
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Copy, FolderGit2, Loader2, MessageCircleQuestion, RotateCcw, Square, SquarePen } from 'lucide-react'
import type { Epic, Issue, JiraInfo, Profile } from './github'
import type { Release } from './pipeline'

// note = "중지했습니다" 같은 안내. id·at은 기다리는 질문을 가리키고 경과 시간을 잴 때 쓴다
export type ChatMsg = { role: 'user' | 'assistant' | 'error' | 'note'; text: string; id?: string; at?: number }

const web = window.gto.platform === 'web'

// navigator.clipboard는 https나 localhost에서만 있다. http(LAN 주소)로 연 웹에서는 예전 방식으로 복사
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text)
  const t = Object.assign(document.createElement('textarea'), { value: text })
  document.body.append(t)
  t.select()
  const ok = document.execCommand('copy')
  t.remove()
  return ok ? Promise.resolve() : Promise.reject(new Error('복사할 수 없습니다'))
}

// 보드 상태를 한 줄씩. 질문마다 그때의 화면 데이터로 다시 만든다
function boardContext(p: Profile, epics: Epic[], issues: Issue[], jira: Map<string, JiraInfo>, releases?: Map<string, Release>) {
  const title = new Map(epics.map((e) => [e.key, e.title]))
  const lines = issues.map((i) => {
    const id = `${i.repo}#${i.number}`
    const j = jira.get(id), r = releases?.get(id)
    return [
      `${id} [${i.state}] ${i.title}`,
      i.epic && `에픽: ${title.get(i.epic) ?? i.epic}`,
      i.assignee && `담당: ${i.assignee}`,
      j && `Jira ${j.key} ${j.status}`,
      i.parent && `상위: ${i.parent}`,
      i.commits.length && `커밋 ${i.commits.length}개 (마지막 ${i.commits.at(-1)!.slice(0, 7)})`,
      r?.dev && `개발 배포: ${r.dev.name}`,
      r?.tag && `태그: ${r.tag.name}`,
    ].filter(Boolean).join(' · ')
  })
  return `[프로필] ${p.name} · 레포 ${p.repos.join(', ')} · Jira ${p.jira.project}
[에픽] ${epics.map((e) => `${e.title}${e.closed ? '(닫힘)' : ''}`).join(', ') || '없음'}
[이슈 ${issues.length}개]
${lines.join('\n')}`
}

// blank가 있으면 바로 보내지 않고 입력창에 채운 뒤 그 부분을 선택해 둔다 (증상만 덮어쓰면 되게)
const EXAMPLES: { text: string; blank?: string }[] = [
  { text: '최신 develop 패치 이후 특정 문제가 발생했어. 원인 파악해줘', blank: '특정 문제' },
  { text: '#243은 어디까지 배포됐어?' },
  { text: 'Jira 동기화는 어느 파일에서 해?' },
  { text: '진행 중인 에픽 중 오래 멈춘 건?' },
]
const cleanErr = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function Assistant({ profile, epics, issues, jira, releases, chat, setChat }: {
  profile: Profile; epics: Epic[]; issues: Issue[]; jira: Map<string, JiraInfo>; releases?: Map<string, Release>
  chat: ChatMsg[]; setChat: (f: (c: ChatMsg[]) => ChatMsg[]) => void
}) {
  const [q, setQ] = useState('')
  const [dirs, setDirs] = useState<Record<string, string>>({})
  const [cleared, setCleared] = useState<ChatMsg[]>() // "새 대화" 되돌리기용
  const [copied, setCopied] = useState<number>()
  const [now, setNow] = useState(Date.now())
  const log = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const last = chat.at(-1)
  const pending = last?.role === 'user' ? last : undefined

  useEffect(() => { window.gto.repoDirs().then(setDirs) }, [])
  // 답이 오면 답의 첫 줄로, 질문을 보내면 맨 아래(기다림 표시)로
  useEffect(() => {
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    if (last?.role === 'assistant') [...(log.current?.querySelectorAll('.turn') ?? [])].at(-1)?.scrollIntoView({ block: 'start', behavior })
    else end.current?.scrollIntoView({ block: 'end', behavior })
  }, [chat.length])
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pending?.id])

  // 답은 그 질문이 아직 마지막일 때만 붙인다 (중지했거나 새 대화면 버림)
  const send = (text: string, base: ChatMsg[]) => {
    const history = base.filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role === 'user' ? '사용자' : '도우미'}: ${m.text}`).join('\n\n')
    const prompt = `${boardContext(profile, epics, issues, jira, releases)}${history && `\n\n[이전 대화]\n${history}`}\n\n[질문]\n${text}`
    const id = `${Date.now()}-${Math.random()}` // crypto.randomUUID는 http(LAN 주소) 웹에서 막힌다
    setCleared(undefined)
    setNow(Date.now())
    setChat(() => [...base, { role: 'user', text, id, at: Date.now() }])
    const done = (m: ChatMsg) => setChat((c) => (c.at(-1)?.id === id ? [...c, m] : c))
    window.gto.ask(id, prompt, profile.repos).then((a) => done({ role: 'assistant', text: a }), (e) => done({ role: 'error', text: cleanErr(e) }))
    input.current?.focus()
  }
  const ask = () => {
    const text = q.trim()
    if (!text || pending) return
    setQ('')
    send(text, chat)
  }
  const stop = () => {
    if (!pending?.id) return
    window.gto.cancelAsk(pending.id)
    setChat((c) => [...c, { role: 'note', text: '중지했습니다.' }])
  }
  const retry = () => send(chat.at(-2)!.text, chat.slice(0, -2)) // 마지막 질문과 오류(또는 중지)를 빼고 다시
  const copy = (i: number, text: string) => copyText(text).then(() => {
    setCopied(i)
    setTimeout(() => setCopied((c) => (c === i ? undefined : c)), 1500)
  })
  const pick = (r: string) => window.gto.pickRepoDir(r).then((d) => d && setDirs((x) => ({ ...x, [r]: d })))
  const auto = (r: string) => window.gto.autoRepoDir(r).then(() => setDirs(({ [r]: _, ...x }) => x))
  const secs = pending?.at ? Math.max(0, Math.round((now - pending.at) / 1000)) : 0

  return (
    <div className="assistant-view">
      <div className="assistant-dirs">
        {profile.repos.map((r) => (
          <span key={r} className="repo-chip">
            <FolderGit2 size={13} />
            <b>{r.split('/')[1]}</b>
            <span className="muted" title={dirs[r] ?? `${web ? '서버' : '이 PC'}의 로컬 저장소를 질문할 때마다 최신으로 맞춰 읽습니다 (develop이 있으면 develop, 없으면 기본 브랜치)`}>
              {dirs[r] ?? `${web ? '서버 저장소' : '자동'} · develop 최신`}
            </span>
            {!web && <button className="link" onClick={() => pick(r)}>폴더 바꾸기</button>}
            {dirs[r] && <button className="link" onClick={() => auto(r)}>자동으로</button>}
          </span>
        ))}
        <span className="grow" />
        {chat.length > 0 && (
          <button className="ghost" disabled={!!pending} onClick={() => { setCleared(chat); setChat(() => []) }}><SquarePen />새 대화</button>
        )}
      </div>

      <div className="assistant-log" ref={log} role="log" aria-live="polite" aria-label="도우미 대화">
        {!chat.length && (
          <div className="assistant-empty">
            {cleared && (
              <div className="undo-bar">대화를 지웠습니다. <button className="link" onClick={() => { setChat(() => cleared); setCleared(undefined) }}>되돌리기</button></div>
            )}
            <MessageCircleQuestion className="assistant-empty-icon" />
            <h2>무엇이 궁금하세요?</h2>
            <p className="muted">레포 코드와 보드의 이슈, 에픽, 배포 정보를 보고 답합니다.</p>
            <div className="examples">
              {EXAMPLES.map((x) => (
                <button key={x.text} onClick={() => {
                  if (!x.blank) return send(x.text, [])
                  setQ(x.text)
                  const at = x.text.indexOf(x.blank)
                  requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(at, at + x.blank!.length) })
                }}>{x.text}</button>
              ))}
            </div>
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`turn ${m.role}`}>
            <div className="msg">{m.text}</div>
            {m.role === 'assistant' && (
              <button className="link turn-action" onClick={() => copy(i, m.text)} aria-label="답 복사">
                {copied === i ? <><Check />복사됨</> : <><Copy />복사</>}
              </button>
            )}
            {(m.role === 'error' || m.role === 'note') && i === chat.length - 1 && (
              <button className="link turn-action" onClick={retry}><RotateCcw />다시 시도</button>
            )}
          </div>
        ))}
        {pending && (
          <div className="turn pending" role="status">
            <div className="msg"><Loader2 className="spin" size={14} />코드를 읽는 중… {secs}초</div>
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="composer-wrap">
        <form className="composer" onSubmit={(e) => { e.preventDefault(); ask() }}>
          <textarea ref={input} autoFocus rows={1} value={q} onChange={(e) => setQ(e.target.value)} aria-label="질문"
            placeholder="코드나 보드에 대해 물어보세요"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask() } }} />
          {pending ? (
            <button type="button" className="composer-btn stop" onClick={stop} aria-label="중지" title="중지"><Square /></button>
          ) : (
            <button className="composer-btn" disabled={!q.trim()} aria-label="보내기" title="보내기 (Enter)"><ArrowUp /></button>
          )}
        </form>
        <div className="composer-hint">Enter 보내기 · Shift+Enter 줄바꿈 · 코드는 읽기만 하고 고치지 않습니다</div>
      </div>
    </div>
  )
}
