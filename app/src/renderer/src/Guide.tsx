// 가이드: 실제 앱 화면(scripts/guide-shots.mjs로 찍은 것) 위에 번호를 찍어 메뉴별 사용법을 순서대로 보여 준다.
// 설명(points)의 순서는 shots.json의 marks 순서와 같다. 화면이 바뀌면 스크립트를 다시 돌린다.
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import shots from './guide/shots.json'

const IMAGES = import.meta.glob('./guide/*.webp', { eager: true, import: 'default' }) as Record<string, string>
type Rect = { x: number; y: number; w: number; h: number } | null
// 찍을 때 스크롤 영역만큼 세로를 늘려서 단계마다 비율(w/h)이 다르다
const SHOTS = new Map((shots as { id: string; w: number; h: number; marks: Rect[] }[]).map((s) => [s.id, s]))

const STEPS: { id: string; menu: string; title: string; lead: string; points: string[] }[] = [
  {
    id: 'settings', menu: '설정', title: '처음 한 번: 프로필과 토큰',
    lead: '어떤 레포와 Jira 프로젝트를 묶을지 정하고 토큰을 넣습니다. 토큰은 이 PC에만 암호화해 저장되고, 저장된 값은 잠겨서 "변경"을 눌러야 바뀝니다.',
    points: [
      '프로필: 레포 목록, Jira 프로젝트, 담당자 이름과 Jira 계정 연결. 편집해서 저장하면 각 레포의 Actions 변수(GTO_PROFILE)로 올라가 동기화 워크플로도 같은 설정을 씁니다.',
      'GitHub 토큰: 이슈 읽기·쓰기 권한이 필요합니다. Actions 화면에서 워크플로를 고치려면 workflow 권한도 필요합니다.',
      'Jira 토큰: 카드에 Jira 키와 상태를 보여 주는 데만 씁니다. 앱은 Jira에 쓰지 않습니다.',
      '작업 요약 엔진: Claude·Codex·Antigravity CLI(각자 구독) 또는 API 키. 작업 요약과 도우미가 이 엔진을 씁니다.',
    ],
  },
  {
    id: 'board', menu: '에픽 보드', title: '에픽 보드 둘러보기',
    lead: '구역 하나가 마일스톤(= Jira 에픽) 하나이고, 카드 하나가 GitHub 이슈 하나입니다. 에픽은 위아래로 쌓여 아래로만 내려 봅니다.',
    points: [
      '필터: "작업까지"는 카드까지, "에픽만"은 에픽 요약만 봅니다. 검색, 진행 중만, 담당자, Jira 상태, 에픽으로 좁힙니다.',
      '새 마일스톤: 이름을 쓰고 "마일스톤 만들기"를 누르면 프로필의 모든 레포에 생기고 Jira 에픽과 이어집니다. 옆 버튼은 Jira에 이미 있는 에픽을 가져옵니다.',
      '에픽 구역: 머리의 ▸로 접고 펼칩니다(접은 상태는 기억). 카드를 다른 구역으로 끌어 놓으면 에픽이 바뀌고, +는 그 에픽에 바로 이슈를 만듭니다.',
      '카드: 클릭하면 선택(Ctrl·Shift로 여러 개), 더블클릭하면 GitHub에서 열고, 우클릭하면 메뉴가 나옵니다.',
    ],
  },
  {
    id: 'new-issue', menu: '에픽 보드', title: '일감 만들기',
    lead: '오른쪽 위 "이슈 만들기"를 누릅니다. GitHub 이슈가 만들어지고, 동기화 Action이 Jira 이슈를 만들어 서로 이어 줍니다.',
    points: [
      '제목: GitHub 이슈와 Jira 이슈의 제목이 됩니다.',
      '마일스톤(에픽): 어느 Jira 에픽 아래로 들어갈지 정합니다.',
      '담당자: 프로필의 담당자 연결에 따라 Jira 담당자로 들어갑니다.',
      '내용: 무엇을 왜 하는지 적습니다. Jira 설명으로 동기화됩니다.',
    ],
  },
  {
    id: 'jira', menu: '에픽 보드', title: 'Jira 연동 확인',
    lead: '이슈를 만들면 보통 1분 안에 GitHub Actions가 Jira 이슈를 만들고, 카드에 Jira 키가 붙습니다. 상태는 Jira에서 바꾸고 앱은 읽기만 합니다.',
    points: [
      'Jira 키와 상태 배지: Backlog, 진행 중, 완료가 Jira 그대로 보입니다.',
      '"Jira에서 보기"를 누르면 오른쪽에 Jira 내용이 열립니다. "Jira에서 열기"로 브라우저에서 엽니다.',
      '설명: GitHub 이슈 본문이 Jira 설명으로 옮겨진 모습과 GitHub 링크를 확인합니다.',
    ],
  },
  {
    id: 'issue', menu: '에픽 보드', title: '실제 일감 진행과 작업 요약',
    lead: '커밋 메시지에 #이슈번호를 쓰면 그 커밋이 이슈의 작업 기록에 쌓입니다. 요약 엔진이 쌓인 기록을 정리해 이슈 본문과 Jira에 남깁니다.',
    points: [
      '요약 배지: "요약됨"은 정리 끝, "요약 필요"는 요약 뒤에 새 커밋이 쌓였다는 뜻입니다.',
      '우클릭 메뉴: GitHub·Jira 열기, 하위 작업, 에픽 이동, 닫기(완료), 링크 복사, 커밋용 번호 복사(#357)를 합니다.',
      '전체 요약: 요약이 필요한 이슈를 한 번에 정리합니다.',
    ],
  },
  {
    id: 'subs', menu: '에픽 보드', title: '하위 일감',
    lead: '큰 일감은 하위 작업으로 나눕니다. 우클릭 "하위 작업 만들기"로 만들면 GitHub에서 하위 이슈로 묶입니다.',
    points: [
      '"하위 0/2": 완료한 하위 작업 / 전체. 누르면 오른쪽에 목록이 열립니다.',
      '패널 머리: 상위 이슈 번호와 GitHub 열기, 닫기.',
      '목록: 하위 작업의 상태를 보고 바로 새 하위 작업을 만듭니다.',
    ],
  },
  {
    id: 'flow', menu: '흐름', title: '이슈가 어디까지 왔는지',
    lead: '이슈마다 이슈 → Jira → 커밋 → 개발 배포 → 태그 → 배포 6단계를 한 줄로 봅니다.',
    points: [
      '단계: 개발 배포·태그는 이슈의 마지막 커밋이 그 빌드에 들어갔는지로 판단합니다.',
      '행: 에픽별로 묶여 있고, 행을 누르면 자세히 볼 수 있습니다.',
      '패널: 단계별 링크와 기록된 커밋. squash 머지로 커밋이 바뀌면 잡히지 않습니다.',
    ],
  },
  {
    id: 'deploy', menu: '배포', title: '배포 현황',
    lead: '레포별 개발 배포(develop-latest)와 정식 태그를 최신순으로 봅니다. 읽기 전용입니다.',
    points: [
      '이름과 종류(개발 배포·정식), 날짜, 빌드 상태. 빌드를 누르면 Actions 실행으로 갑니다.',
      '받을 파일: 설치 파일과 크기. 누르면 받습니다.',
      '들어간 이슈: 이 버전에 처음 들어간 이슈, 개발 배포면 정식 배포를 기다리는 이슈.',
    ],
  },
  {
    id: 'assistant', menu: '도우미', title: '도우미로 유지보수하기',
    lead: '고객 문의 같은 유지보수 질문을 하면 develop 최신 코드, 최근 커밋, 보드 정보를 읽고 파일:줄 근거로 답합니다. 코드는 고치지 않습니다.',
    points: [
      '저장소: 질문할 때마다 develop 최신으로 맞춥니다. 직접 받아 둔 폴더로 바꿀 수도 있습니다.',
      '질문: 빈 화면의 "최신 develop 패치 이후 특정 문제가…"를 누르고 증상만 바꿔 씁니다.',
      '답: 원인, 근거 파일과 줄, 고객에게 받아야 할 것까지. 아래 "복사"로 그대로 옮깁니다.',
      '입력창: Enter로 보내고, 기다리는 동안 ■로 중지합니다.',
    ],
  },
]

export default function Guide({ onOpen }: { onOpen: (menu: string) => void }) {
  const [step, setStep] = useState(0)
  const [hover, setHover] = useState<number>()
  const [zoom, setZoom] = useState(false) // 캡처 크게 보기
  const s = STEPS[step]
  const meta = SHOTS.get(s.id)
  const marks = meta?.marks ?? []
  const go = (i: number) => { setStep(Math.max(0, Math.min(STEPS.length - 1, i))); setHover(undefined) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.('input, textarea, select')) return
      if (e.key === 'ArrowRight') go(step + 1)
      if (e.key === 'ArrowLeft') go(step - 1)
      if (e.key === 'Escape') setZoom(false)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [step])

  const src = IMAGES[`./guide/${s.id}.webp`] // 공개본에는 캡처(실제 이슈 화면)가 없다
  const shot = !src ? (
    <div className="guide-noshot muted">화면 캡처가 없습니다. 앱을 띄우고 scripts/guide-shots.mjs를 돌리면 여기에 실제 화면이 나옵니다.</div>
  ) : (
    <figure className="guide-window" style={{ '--ar': meta ? meta.w / meta.h : 1400 / 900 } as React.CSSProperties}
      onClick={() => setZoom((z) => !z)} title={zoom ? '눌러서 닫기 (Esc)' : '눌러서 크게 보기'}>
      <div className="guide-shot">
        <img src={src} alt={`${s.menu} 화면`} draggable={false} />
        {marks.map((r, i) => r && (
          <div key={i} className={`guide-mark${hover === i ? ' on' : ''}${hover !== undefined && hover !== i ? ' dim' : ''}`}
            style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(undefined)}>
            <span className="guide-num">{i + 1}</span>
          </div>
        ))}
      </div>
    </figure>
  )

  return (
    <div className="guide">
      <nav className="guide-steps" aria-label="가이드 단계">
        {STEPS.map((x, i) => (
          <button key={x.id} className={i === step ? 'on' : ''} aria-current={i === step ? 'step' : undefined} onClick={() => go(i)}>
            <span className="guide-num">{i + 1}</span>
            <span className="guide-step-text"><b>{x.title}</b><span className="muted">{x.menu}</span></span>
          </button>
        ))}
      </nav>

      <div className="guide-main">
        <div className="guide-head">
          <span className="muted">{step + 1} / {STEPS.length} · {s.menu}</span>
          <h2>{s.title}</h2>
          <p>{s.lead}</p>
        </div>

        {/* 캡처는 남은 높이 안에 비율을 지키며 통째로 들어가고, 설명은 오른쪽에 둔다 */}
        <div className="guide-body">
        <div className="guide-stage">
        {shot}
        </div>

        <ol className="guide-points">
          {s.points.map((p, i) => (
            <li key={i} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(undefined)}>
              <span className="guide-num">{i + 1}</span>
              <span>{p}</span>
            </li>
          ))}
        </ol>
        </div>

        {zoom && <div className="guide-zoom" onClick={() => setZoom(false)}>{shot}</div>}

        <div className="guide-foot">
          <button disabled={step === 0} onClick={() => go(step - 1)}><ChevronLeft />이전</button>
          <span className="grow" />
          <button className="ghost" onClick={() => onOpen(s.menu)}>{s.menu} 열기</button>
          {step < STEPS.length - 1
            ? <button className="primary" onClick={() => go(step + 1)}>다음: {STEPS[step + 1].title}<ChevronRight /></button>
            : <button className="primary" onClick={() => go(0)}>처음부터</button>}
        </div>
      </div>
    </div>
  )
}
