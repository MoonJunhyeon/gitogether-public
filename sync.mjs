// F1: GitHub 이슈/마일스톤 이벤트 하나를 Jira에 반영한다. 의존성 없음 (Node 20+).
import { readFileSync } from 'node:fs'
import { MARKER_RE, env, formAssignee, gh, jira, jiraKeyOf, norm, p, parentOf, repo } from './lib.mjs'

const stripMarker = (s) => (s ?? '').replace(MARKER_RE, '').trim()

// GitHub 마크다운 → Jira 표기 (제목, 링크만). 숨김 주석(<!-- -->)은 Jira에서 글자 그대로 보이므로 뺀다.
export const toJira = (md) => (md ?? '')
  .replace(/\r/g, '')
  .replace(/<!--[\s\S]*?-->\n?/g, '')
  .replace(/^(#{1,6}) +/gm, (_, h) => `h${h.length}. `)
  .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '[$1|$2]')
  .trim()

// 마일스톤 → 에픽 키. 마커가 없으면 같은 이름(정규화) 에픽을 찾고, 없으면 만든 뒤 마커를 남긴다.
async function epicKey(ms) {
  const marked = ms.description?.match(MARKER_RE)?.[1]
  if (marked) return marked
  // ponytail: 에픽 100개까지만 비교, 넘으면 nextPageToken으로 페이지네이션
  const { issues } = await jira('POST', '3/search/jql', {
    jql: `project = ${p.jira.project} AND issuetype = ${p.jira.types.epic}`,
    fields: ['summary'],
    maxResults: 100,
  })
  // ponytail: 여러 레포에서 같은 이름 마일스톤이 동시에 생기면 에픽이 중복될 수 있음, 실제로 생기면 프로필 단위 락 추가
  const key = issues.find((i) => norm(i.fields.summary) === norm(ms.title))?.key ??
    (await jira('POST', '2/issue', {
      fields: {
        project: { key: p.jira.project },
        issuetype: { id: p.jira.types.epic },
        summary: ms.title,
        description: stripMarker(ms.description),
      },
    })).key
  await gh('PATCH', `milestones/${ms.number}`, { description: `${ms.description ?? ''}\n<!-- jira:${key} -->`.trim() })
  return key
}

// 상태 카테고리(new | indeterminate | done)로 가는 전환을 찾아 실행
async function transition(key, cat) {
  const { fields } = await jira('GET', `2/issue/${key}?fields=status`)
  if (fields.status.statusCategory.key === cat) return
  const { transitions } = await jira('GET', `2/issue/${key}/transitions`)
  const t = transitions.find((t) => t.to.statusCategory.key === cat)
  if (t) await jira('POST', `2/issue/${key}/transitions`, { transition: { id: t.id } })
  else console.log(`::warning::${key}: ${cat} 상태로 가는 전환 없음`)
}

// worklog.mjs도 이슈 본문에 작업 내용을 덧붙인 뒤 이걸 바로 호출한다
// 반환값: Jira 키 (동기화 대상이 아니면 null)
export async function syncIssue(issue, action) {
  if (!issue.labels.some((l) => l.name === p.label)) return null
  let key = await jiraKeyOf(issue.number)

  // 하위 이슈 → Jira 하위 작업(상위 이슈의 Jira 작업 아래). 상위가 아직 Jira에 없으면 먼저 동기화한다.
  // 하위 작업은 만들 때만 상위를 정한다 (이미 일반 작업으로 만든 것은 Jira에서 '이동'해야 바뀌므로 그대로 둠).
  // ponytail: 하위의 하위는 Jira가 막아서 만들 때 실패함, 앱에서 막고 있음
  const up = p.jira.types.subtask ? await parentOf(issue.number) : null
  const parentKey = up && ((await jiraKeyOf(up.number)) ?? (await syncIssue(up, 'edited')))
  if (up && !parentKey) console.log(`::warning::#${issue.number}: 상위 #${up.number}가 Jira 동기화 대상이 아니라 일반 작업으로 둠`)

  const name = formAssignee(issue.body)
  const accountId = name && p.assignees[name]
  if (name && !accountId) console.log(`::warning::매핑 없는 담당자: ${name} (담당자 변경 안 함)`)

  // 동기화가 소유하는 필드만. 우선순위, 기한 등 Jira 전용 필드는 건드리지 않는다.
  const fields = {
    summary: `[${repo.split('/')[1]}#${issue.number}] ${issue.title}`,
    description: `${toJira(issue.body)}\n\nGitHub: ${issue.html_url}`,
    // 마일스톤이 있으면 그 에픽으로. 없을 때는 "마일스톤을 뺀" 이벤트에서만 에픽을 비운다:
    // 그 외에 비우면 Jira에서 직접 에픽에 넣어 둔 작업이 GitHub 이슈를 고칠 때마다 에픽에서 빠진다.
    // ponytail: parent: null로 에픽 해제가 되는지 첫 테스트에서 확인
    parent: parentKey ? undefined : issue.milestone ? { key: await epicKey(issue.milestone) } : action === 'demilestoned' ? null : undefined,
    ...(accountId && { assignee: { accountId } }),
  }

  if (key) {
    await jira('PUT', `2/issue/${key}`, { fields })
  } else {
    key = (await jira('POST', '2/issue', {
      fields: {
        ...fields,
        project: { key: p.jira.project },
        issuetype: { id: parentKey ? p.jira.types.subtask : p.jira.types.issue },
        parent: parentKey ? { key: parentKey } : fields.parent ?? undefined,
      },
    })).key
    await gh('POST', `issues/${issue.number}/comments`, { body: `Jira: [${key}](${p.jira.baseUrl}/browse/${key})` })
  }

  if (action === 'closed') await transition(key, 'done')
  if (action === 'reopened') await transition(key, 'new')
  return key
}

async function syncMilestone(ms, action) {
  if (action === 'deleted') return
  const key = await epicKey(ms)
  if (action === 'edited') {
    await jira('PUT', `2/issue/${key}`, { fields: { summary: ms.title, description: stripMarker(ms.description) } })
  }
  if (action === 'closed') await transition(key, 'done')
  if (action === 'opened') await transition(key, 'new')
}

if (env.GITHUB_EVENT_NAME === 'issues' || env.GITHUB_EVENT_NAME === 'milestone') {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  if (!p) console.log(`::notice::${repo}가 속한 프로필 없음, 건너뜀`)
  // 다른 라벨을 붙인 것은 무시 (동기화 라벨을 나중에 붙인 경우만 동기화)
  else if (event.action === 'labeled' && event.label?.name !== p.label) console.log(`::notice::${event.label?.name} 라벨, 건너뜀`)
  else if (event.issue) await syncIssue(event.issue, event.action)
  else if (event.milestone) await syncMilestone(event.milestone, event.action)
}
