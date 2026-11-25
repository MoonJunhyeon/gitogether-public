// 가이드 화면용 캡처: 실행 중인 앱(CDP)을 단계별로 조작해 찍고, 설명 번호를 찍을 위치를 함께 저장한다.
// 화면이 바뀌면 다시 돌린다. 읽기만 한다 (창을 열었다 닫을 뿐 저장 버튼은 누르지 않는다).
//   npx electron --remote-debugging-port=9333 .   (다른 터미널에서)
//   node scripts/guide-shots.mjs 9333
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const port = process.argv[2] ?? '9333'
const OUT = join(import.meta.dirname, '../src/renderer/src/guide')
mkdirSync(OUT, { recursive: true })

const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok) => ws.addEventListener('open', ok))
let id = 0
const send = (method, params = {}) => new Promise((ok) => {
  const my = ++id
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === my) { ws.removeEventListener('message', on); ok(m.result) } }
  ws.addEventListener('message', on)
  ws.send(JSON.stringify({ id: my, method, params }))
})
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (js, ms = 60_000) => { for (const t = Date.now(); Date.now() - t < ms; await wait(500)) if (await ev(js)) return true; throw new Error(`기다림 초과: ${js}`) }

// 페이지 안에서 쓰는 도우미: 글자가 들어간 요소 찾기, 클릭, 위치(화면 대비 %)
const HELPERS = `
  window.$q = (sel, text) => [...document.querySelectorAll(sel)].find((e) => !text || e.textContent.includes(text));
  window.$click = (sel, text) => { const e = $q(sel, text); if (!e) throw new Error('없음: ' + sel + ' ' + (text ?? '')); e.click(); return true };
  window.$rect = (sel, text) => { const e = $q(sel, text); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: +(r.left / innerWidth * 100).toFixed(2), y: +(r.top / innerHeight * 100).toFixed(2), w: +(r.width / innerWidth * 100).toFixed(2), h: +(r.height / innerHeight * 100).toFixed(2) } };
`
const nav = (label) => `$click('.nav-item', ${JSON.stringify(label)})`
const tasksView = `($q('.filter-bar .segmented button', '작업')?.click(), true)`
const stateFilter = (v) => `(() => { const s = $q('.filter-bar select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '${v}');
  s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`

// marks: [선택자, 글자] — Guide.tsx의 설명 번호와 순서가 같다
const STEPS = [
  { id: 'settings', go: [nav('설정')], ready: `!!$q('.settings .panel h2', 'GitHub')`,
    marks: [['.settings .panel', '프로필'], ['.settings .panel', 'GitHub 토큰'], ['.settings .panel', 'Jira 토큰'], ['.settings .panel', '작업 요약 엔진']] },
  { id: 'board', go: [nav('에픽 보드'), tasksView], ready: `!!$q('.card')`,
    marks: [['.filter-bar'], ['.topbar form'], ['.col'], ['.card']] },
  { id: 'new-issue', go: [nav('에픽 보드'), `$click('.topbar button.primary', '이슈 만들기')`], ready: `!!$q('.modal')`,
    marks: [['.modal label', '제목'], ['.modal label', '마일스톤'], ['.modal label', '담당자'], ['.modal label', '내용']] },
  { id: 'jira', go: [nav('에픽 보드'), tasksView, `($q('.card .badge.done, .card .badge.indeterminate, .card .badge.new') ?? $q('.card')).closest('.card').querySelector('.card-foot button').click()`],
    ready: `!!$q('.drawer .drawer-body')`, wait: 4000,
    marks: [['.card .badge'], ['.drawer-head'], ['.drawer-body']] },
  // 요약된 이슈는 대개 닫혀 있어서 "완료 포함"으로 보고 그 카드를 화면에 둔 채 찍는다 (늘리지 않음), 찍은 뒤 필터를 되돌린다
  // 캡처할 때 스크롤 이벤트가 나서 메뉴가 닫히므로 이 단계에서는 스크롤 이벤트를 막는다 (단계마다 새로고침해서 다음 단계에는 영향 없음)
  { id: 'issue', go: [`(addEventListener('scroll', (e) => e.stopImmediatePropagation(), true), true)`, nav('에픽 보드'), tasksView, stateFilter('all'), `(($q('.card .badge.done', '요약됨') ?? $q('.card')).scrollIntoView({ block: 'center' }), true)`, // 스크롤하면 메뉴가 닫혀서 따로
    `(() => { const c = $q('.card .badge.done', '요약됨')?.closest('[aria-selected]') ?? $q('[aria-selected]');
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: c.getBoundingClientRect().right - 20, clientY: c.getBoundingClientRect().top + 20 })); return true })()`],
    ready: `!!$q('.menu')`, fit: false, after: stateFilter('open'),
    marks: [['.card .badge.done', '요약됨'], ['.menu'], ['.topbar button', '전체 요약']] },
  { id: 'subs', go: [nav('에픽 보드'), tasksView, `$click('.card-foot button', '하위')`], ready: `!!$q('.drawer .drawer-body')`, wait: 3000,
    marks: [['.card-foot button', '하위'], ['.drawer-head'], ['.drawer-body']] },
  { id: 'flow', go: [nav('흐름')], ready: `!!$q('.flow-table td .fcell.done') && !$q('.topbar .sub', '확인 중')`, wait: 1000,
    then: `($q('.flow-table tbody tr:not(.flow-epic)').click(), true)`,
    marks: [['.flow-table thead'], ['.flow-table tbody tr:not(.flow-epic)'], ['.drawer']] },
  { id: 'deploy', go: [nav('배포')], ready: `!!$q('.deploy-card')`, wait: 3000,
    marks: [['.deploy-card .deploy-head'], ['.deploy-card .deploy-assets'], ['.deploy-card .deploy-issues']] },
  { id: 'assistant', go: [nav('도우미'), `(() => { const t = $q('.composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '최신 develop 패치 이후 Agent가 Engine에 NATS 연결을 못 하는 문제가 발생했어. 원인 파악해줘');
      t.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => $click('.composer-btn'), 300); return true })()`],
    ready: `!!$q('.turn.assistant')`, timeout: 300_000, wait: 1500,
    then: `($q('.assistant-log').scrollTop = 0, true)`,
    marks: [['.repo-chip'], ['.turn.user'], ['.turn.assistant'], ['.composer']] },
]

const only = process.argv.slice(3)
const shots = []
for (const s of STEPS) {
  if (only.length && !only.includes(s.id)) continue
  await send('Page.reload'); await wait(1500)
  await until(`document.querySelector('.nav-item') !== null`)
  await ev(HELPERS)
  await until(`!!document.querySelector('.card, .epic-tile')`) // 보드 데이터가 들어올 때까지
  for (const js of s.go) { await ev(js); await wait(800) }
  await until(s.ready, s.timeout)
  if (s.then) { await ev(s.then); await wait(1500) }
  await wait(s.wait ?? 800)
  // 스크롤되는 영역(설정 목록, 도우미 답, 오른쪽 패널)이 잘리지 않게 그만큼 화면을 늘려서 찍는다
  const [W, H0] = await ev(`[innerWidth, innerHeight]`)
  const extra = await ev(`Math.max(0, ...[...document.querySelectorAll('.view, .assistant-log, .drawer-body')].map((e) => e.scrollHeight - e.clientHeight))`)
  const H = s.fit === false ? H0 : Math.min(H0 + extra, 2000)
  if (H !== H0) { await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }); await wait(1000) } // 창 크기를 바꾸면 열린 메뉴가 닫힌다
  if (s.then?.includes('scrollTop')) await ev(s.then) // 늘린 뒤에 다시 맨 위로
  const marks = []
  for (const [sel, text] of s.marks) {
    const r = await ev(`$rect(${JSON.stringify(sel)}, ${JSON.stringify(text)})`)
    if (!r) console.warn(`  ${s.id}: 표시 위치를 못 찾음 ${sel} ${text ?? ''}`)
    marks.push(r)
  }
  const { data } = await send('Page.captureScreenshot', { format: 'webp', quality: 82 })
  writeFileSync(join(OUT, `${s.id}.webp`), Buffer.from(data, 'base64'))
  await send('Emulation.clearDeviceMetricsOverride')
  if (s.after) await ev(s.after)
  shots.push({ id: s.id, w: W, h: H, marks })
  console.log('찍음', s.id)
}
// 일부 단계만 다시 찍으면 나머지는 기존 값을 둔다
const file = join(OUT, 'shots.json')
const old = only.length && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
const merged = STEPS.map((st) => shots.find((x) => x.id === st.id) ?? old.find((x) => x.id === st.id)).filter(Boolean)
writeFileSync(file, JSON.stringify(merged, null, 1))
await send('Page.reload')
ws.close()
