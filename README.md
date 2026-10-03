# ☁️ What's New 한국어 요약

Amazon Web Services · Google Cloud · Microsoft Azure 클라우드 최신 업데이트를 한국어로 요약합니다.

**Live**: https://whats-new.kr

## 아키텍처

```
Cloudflare Workers (Cron, 매분)
  → 15분마다: RSS 수집 + 30일 지난 기사 삭제 + stale job 정리
  → 5분마다: 미검수 건 + 어색한 한국어 재다듬기 큐잉
  → 신규 기사는 수집 즉시 번역 큐잉, 누락분은 15분 블록에서 재큐잉
  → Queue consumer: 번역 → 품질 검수 → 저장
  → 장시간 무수집 시 Alert webhook (Discord/Slack)

Cloudflare Pages (Astro SSR)
  → /           통합 대시보드 (3단 컬럼)
  → /aws        AWS Cloudscape 테마
  → /gcp        Google Cloud Material 테마
  → /azure      Microsoft Azure Fluent 테마
```

번역/검수 모델은 런타임에 교체 가능하므로(아래 "번역 모델 자동 평가" 참고) 현재 가동 중인
모델 ID는 README에 고정하지 않습니다. 실제 값은 `GET /api/stats`의 `models` 필드에서 확인하세요.

## 번역 파이프라인

1. **번역**: 본문 요약 → 제목 도출 → 상태/대상/기능/리전 추출
2. **검수**: 제목/상태/리전 등 필드별 교차 검증, 오류 시 수정
3. **품질 게이트**: CJK 오염, 마크다운 잔재, 제목 잘림 등 자동 감지 → 재시도
4. **AI 품질 리뷰**: 제목 완성도, 자연스러운 한국어, 리전 표기 일관성 등 최종 검수

## 비용: $0

| 서비스 | 무료 한도 | 예상 사용량 |
|--------|----------|------------|
| Workers | 100K req/일 | ~500/일 |
| Workers AI | 10K neurons/일 | ~5K/일 |
| D1 | 5GB / 5M reads/일 | ~10MB / ~5K reads |
| Queues | 1M msg/월 | ~5K/월 |
| Pages | 무제한 대역폭 | - |

## RSS 소스

| CSP | 피드 | 형식 |
|-----|------|------|
| AWS | https://aws.amazon.com/about-aws/whats-new/recent/feed/ | RSS 2.0 |
| GCP | https://docs.cloud.google.com/feeds/gcp-release-notes.xml | Atom |
| Azure | https://www.microsoft.com/releasecommunications/api/v2/azure/rss | RSS 2.0 |

## API

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /mcp` | MCP JSON-RPC 2.0 엔드포인트 (기본 요약 조회는 공개, 영문 원문 조회는 에이전트 인증 필요) |
| `GET /api/articles` | 기사 조회 — whats-new.kr SSR 전용 (`csp`, `lang`, `limit` 파라미터, Accept-Language 자동 감지) |
| `GET /api/stats` | 번역/검수/큐 상태 모니터링 (`models` 필드에 현재 가동 중인 번역/검수 모델 ID 포함) |
| `POST /api/pipeline?action=fetch` | RSS 수집 및 신규 기사 큐잉 (관리자 전용) |
| `POST /api/pipeline?action=translate` | 미번역 기사 일괄 큐잉 (백로그 처리, 관리자 전용) |
| `POST /api/pipeline?action=review` | 미검수 기사 일괄 검수 큐잉 (관리자 전용) |
| `POST /api/pipeline?action=retranslate&id=N` | 특정 기사 재번역 (`&mode=review`로 검수만, `&hint=...` 지원, 관리자 전용) |
| `POST /api/pipeline?action=fix-bad` | 품질 미달 기사 일괄 재번역 (관리자 전용) |
| `POST /api/pipeline?action=refresh-ko` | 어색한 한국어를 영문 원본 기준으로 재번역 (`limit` 최대 25, 관리자 전용) |

### MCP 도구

`POST /mcp` 엔드포인트를 통해 JSON-RPC 2.0 프로토콜로 호출할 수 있는 도구 목록입니다. (`initialize`, `tools/list` 포함)

| 도구 | 설명 | 주요 인자 |
|------|------|----------|
| `search_releases` | 키워드·CSP·기간으로 릴리스 노트 검색 (ko/en 요약 및 영문 원문 지원) | `query`, `csp`, `lang` (`ko`\|`en`), `days`, `start_date`, `end_date`, `limit`, `format` (`summary`\|`source`) |
| `get_release` | article ID로 개별 릴리스 노트 조회 (ko/en 요약 및 영문 원문 지원) | `id` (필수), `lang` (`ko`\|`en`), `format` (`summary`\|`source`) |
| `get_stats` | 번역/검수 파이프라인 현황 및 큐 상태 조회 | - |

- **요약 조회 (`format="summary"`, 기본값)**: 한국어(`ko`) 또는 영어(`en`) AI 요약 데이터를 반환하며, 별도 인증 없이 누구나 자유롭게 호출할 수 있습니다.
- **영문 원문 조회 (`format="source"`)**: 벤더 영문 원문(수집된 `articles` 원본)을 반환합니다. `search_releases`와 `get_release` 둘 다 지원하며, 번역 파이프라인과 독립적이라 RSS 수집 직후 즉시 조회가 가능합니다. 단, 에이전트 전용 기능으로 `Authorization: Bearer <mcp 타입 토큰>` 인증이 필수이며, 미인증 시 JSON-RPC 에러 `-32001`로 거부됩니다.
- **데이터베이스 오류**: `search_releases`가 쿼리에 실패하면 클라이언트에는 일반 오류만 반환합니다. SQL 문과 파라미터는 응답에 넣지 않습니다.

### API 접근 계층 및 인증

API 접근은 보안 및 용도에 따라 4개 계층으로 구분됩니다.

1. **공개 (인증 불필요)**: `GET /api/stats`, `POST /mcp`의 기본 요약 조회 (`search_releases`, `get_release`, `get_stats` 및 `initialize`, `tools/list`)
   - 한국어·영어 AI 요약, `GET /api/stats`, MCP `get_stats`를 인증 없이 조회할 수 있습니다.
2. **에이전트 전용 (인증 필요)**: `POST /mcp`의 `format="source"` (영문 원문 조회)
   - 벤더 영문 원문 데이터를 반환합니다.
   - 요청 헤더에 `Authorization: Bearer <token>` (`mcp` 타입 토큰)이 필요하며, 토큰이 없거나 유효하지 않으면 JSON-RPC 에러 `-32001`을 반환합니다.
   - 번역/검수 파이프라인과 독립적이므로 RSS 수집 직후 바로 확인할 수 있습니다.
3. **사이트 SSR 전용**: `GET /api/articles`
   - whats-new.kr 웹 프론트엔드의 서버사이드 렌더링(Astro SSR) 전용 엔드포인트입니다 (`site` 타입 토큰 필요).
   - 일반 프로그램이나 AI 에이전트는 본 엔드포인트 대신 `POST /mcp`를 사용해야 합니다.
   - `SITE_API_ENFORCEMENT`가 `on`이면 유효한 `site` 토큰이 없는 요청은 401로 거부합니다. 값이 없거나 `off`/`warn`/`on`이 아니면 기본값은 `on`입니다. 명시적인 `warn`은 로그만 남기고 통과시키고, `off`는 이 관문을 끕니다.
4. **관리자 전용**: `POST /api/pipeline?action=...`
   - RSS 수집 트리거, 백로그 큐잉, 기사 재번역 등 파이프라인 관리 API입니다.
   - `AUTH_ENFORCEMENT`가 `on`이면 `Authorization: Bearer <token>` 인증이 성공해야 합니다. 값이 없거나 알 수 없으면 기본값은 `on`입니다. 허용된 관리자 IP만으로는 이 인증을 건너뛰지 않습니다.
   - 인증에 성공한 뒤에도 `ALLOWED_ADMIN_IPS`에 있는 IP에서만 호출할 수 있습니다. 목록이 비어 있거나 IP가 일치하지 않으면 403 Forbidden입니다. 이 값은 `wrangler.toml`에 두지 않고, Deploy All이 GitHub Actions 시크릿 `ALLOWED_ADMIN_IPS`를 Worker 변수로 넣습니다.

## 디자인 시스템

| 페이지 | 테마 | 영문 폰트 | 한글 폰트 |
|--------|------|----------|----------|
| Home | 중립 인디고 | Pretendard Variable | Pretendard Variable |
| /aws | Cloudscape | Amazon Ember | Noto Sans KR |
| /gcp | Material 3 | Google Sans | Noto Sans KR |
| /azure | Fluent UI 2 | Segoe UI | Noto Sans KR |

- 다크모드 지원 (시스템 설정 연동 + 수동 토글)
- CSP별 페이지: 상태 필터 (정식 출시/미리보기/베타/지원 종료), 텍스트 검색, 카드 하이라이트
- 카드 우클릭/롱프레스: 퍼머링크·ID 복사
- OG image (PNG 1200×630), JSON-LD 구조화 데이터
- 동적 sitemap (`lastmod` API 연동)

## 개발

```bash
# D1 스키마 초기화
npm run db:init

# Worker 로컬 실행
npm run worker:dev

# Pages 로컬 실행
npm run dev

# 배포 (git push 시 자동)
git push origin main
```

## CI/CD

GitHub Actions (`deploy.yml`, `push → main`):
- `worker/`, `wrangler.toml`, `schema.sql` 변경 → Workers 배포
- `src/`, `public/`, `package*`, `astro.config*` 변경 → Pages 빌드+배포+오래된 배포 정리

필요 시크릿: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ALLOWED_ADMIN_IPS`

운영 시 추가 시크릿:
- `ALLOWED_ADMIN_IPS`: `POST /api/pipeline`을 호출할 수 있는 공인 IP. 쉼표로 여러 주소를 적을 수 있습니다. Worker 배포 때 변수로 바인딩하며, Pages 빌드에는 넘기지 않습니다.
- `API_KEY_RING`: 서비스/MCP/사이트용 Bearer 토큰 목록 JSON
- Pages 프로젝트(`cloud-whats-new`)에 `SITE_API_TOKEN` (`wrangler pages secret put SITE_API_TOKEN`) — `API_KEY_RING`의 `type: "site"` 토큰과 같은 값. Astro SSR(`index.astro`, `[csp].astro`, `sitemap.xml.ts`)이 `/api/articles` 호출 시 이 값을 `Authorization: Bearer`로 보냄

운영 변수: `AUTH_ENFORCEMENT`, `SITE_API_ENFORCEMENT`, `TRUSTED_IP_BYPASS`, `BACKLOG_QUEUE_BATCH_SIZE`, `ALERT_WEBHOOK_URL`, `TRANSLATION_MODEL`, `REVIEW_MODEL`, `FLUENT_REFRESH_DAILY_CAP`

`AUTH_ENFORCEMENT`와 `SITE_API_ENFORCEMENT`의 기본값은 `on`입니다. `TRUSTED_IP_BYPASS`는 `off`이며, 값이 `on`이어도 Bearer 인증을 대신하지 않습니다. `ALLOWED_ADMIN_IPS`가 비어 있으면 관리자 API는 거부됩니다.

`API_KEY_RING` 예시:
```json
[
  { "id": "service-current", "type": "service", "token": "wnk_srv_..." },
  { "id": "service-next", "type": "service", "token": "wnk_srv_..." },
  { "id": "mcp-primary", "type": "mcp", "token": "wnk_mcp_..." },
  { "id": "site-internal", "type": "site", "token": "wnk_site_..." }
]
```

### 번역 모델 자동 평가 (`model-eval.yml`)

매월 **1일·15일 00:00 UTC**(09:00 KST)에 후보 모델들을 같은 번역 작업에 돌려
fluent-korean 지침 위반 수와 Neuron 비용을 비교한 리포트를 발행합니다.
`workflow_dispatch`로 즉시 실행할 수도 있습니다 (모델 목록·샘플 수 입력 가능).

- **라이브 모델은 자동으로 바뀌지 않습니다.** 리포트는 권고일 뿐이고, 교체는 사람이
  `TRANSLATION_MODEL`을 바꿔야 적용됩니다 (`wrangler.toml` [vars] 수정 후 push, 또는
  `npx wrangler secret put TRANSLATION_MODEL` — 재배포 불필요). 변수를 지우면 롤백됩니다.
- **승격 조건**: 후보가 현재 모델보다 위반 건수·JSON 파싱 실패율 모두 나쁘지 않아야 하고,
  그중 Neuron이 가장 싼 모델이 추천됩니다. 비용 때문에 품질이 내려가지 않는 구조입니다.
- **기준선**은 `GET /api/stats`의 `models.translation`(실제 가동 값)에서 읽습니다.
  API가 닿지 않으면 `wrangler.toml` 값으로 폴백합니다.
- **issue 정책**: 평소의 "keep current" 결과는 `Translation model evaluation — rolling log`
  issue에 코멘트로 누적되고, **교체를 권고할 때만 별도 issue**가 열립니다.
  rolling log issue는 닫지 마세요 (닫으면 다음 실행이 새로 만듭니다).
- **선택 시크릿 `MCP_TOKEN`** (`API_KEY_RING`의 `mcp` 타입 토큰): 설정하면 실제 벤더 원문으로
  평가합니다. **없으면 내장 fixture 3건으로만 돌아가며**, 이 경우 리포트 상단에 경고가 붙고
  모델 교체를 권고하지 않습니다 (smoke test로만 취급).
