// Single source of truth for the public site origin. The live value comes from
// the SITE_URL service variable (wrangler [vars] at runtime, GitHub Actions
// repo variable at build time); this literal is only the safety fallback when
// that variable is unset (e.g. a bare local run). Change the service variable,
// not this constant, to point the site at a new domain.
const DEFAULT_SITE_URL = 'https://whats-new.kr';

const RSS_FEEDS = {
  aws: 'https://aws.amazon.com/about-aws/whats-new/recent/feed/',
  gcp: 'https://docs.cloud.google.com/feeds/gcp-release-notes.xml',
  azure: 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss',
  openai: 'https://openai.com/news/rss.xml',
  oci: 'https://docs.oracle.com/en-us/iaas/releasenotes/feed',
  ibm: 'https://cloud.ibm.com/status/api/notifications/feed.rss',
};

// Ingestion-only vendors: raw text lands in `articles` (queryable via MCP
// format="source") but never gets a ko/en/ja translation job or a website
// page — no summary pipeline cost until/unless a page is actually built.
// oci (Oracle Cloud) was promoted to a full CSP: it now gets ko/en/ja
// translation and a /oci page like aws/gcp/azure, so it is no longer
// source-only.
const SOURCE_ONLY_CSPS = new Set(['openai', 'ibm']);

// These vendors never get a ko row by design, so backlog/missing-translation
// counts must exclude them or they'd inflate forever and misreport the real
// translation queue health for aws/gcp/azure.
function sourceOnlyCspExclusionSql(alias = 'a') {
  if (SOURCE_ONLY_CSPS.size === 0) return '';
  const list = [...SOURCE_ONLY_CSPS].map((csp) => `'${csp}'`).join(',');
  return `AND ${alias}.csp NOT IN (${list})`;
}

const PRIMARY_MODEL = '@cf/zai-org/glm-4.7-flash';
const REVIEW_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
// Fallback model for transient inference errors (e.g. "triton error running
// inference"). Picked for broad availability/stability; used only when the
// primary call throws a retryable inference error.
const FALLBACK_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const FALLBACK_MODEL_ALT = '@cf/mistralai/mistral-small-3.1-24b-instruct';

// Transient Workers AI inference failures (triton/backend hiccups, timeouts,
// capacity) should not fail the whole job — retry once on a different model.
function isTransientInferenceError(err) {
  const m = ((err && err.message) || String(err || '')).toLowerCase();
  return /triton|inference|timeout|capacity|unavailable|overloaded|5\d\d|aborted|network/.test(m);
}

// Run a Workers AI model, falling back to a different model once if the first
// call throws a transient inference error. Keeps a single bad backend from
// turning into a stuck/erroring queue job.
async function runAIWithFallback(env, model, options) {
  try {
    return await env.AI.run(model, options);
  } catch (err) {
    if (!isTransientInferenceError(err)) throw err;
    const fallback = model === FALLBACK_MODEL ? FALLBACK_MODEL_ALT : FALLBACK_MODEL;
    console.warn(`AI inference failed on ${model} (${(err && err.message) || err}); retrying on ${fallback}`);
    return await env.AI.run(fallback, options);
  }
}

// Translation/review model IDs are runtime-overridable so a biweekly model
// evaluation (see scripts/model-eval.mjs + .github/workflows/model-eval.yml)
// can recommend a cheaper/better model and an operator can switch without a
// redeploy. Defaults keep the current models when the vars are unset. Values
// must be valid Workers AI text-generation model IDs; anything else falls back.
function getTranslationModel(env) {
  const m = String(env?.TRANSLATION_MODEL || '').trim();
  return m.startsWith('@cf/') ? m : PRIMARY_MODEL;
}
function getReviewModel(env) {
  const m = String(env?.REVIEW_MODEL || '').trim();
  return m.startsWith('@cf/') ? m : REVIEW_MODEL;
}
// v2 (2026-08-30): 1–2 sentence summaries, no padding/restating, title/acronym/imperative checks.
// Bumping this tag re-queues every Korean card through enqueueFluentKoreanRefresh (FLUENT_REFRESH_DAILY_CAP per day).
const FLUENT_KOREAN_MODEL_TAG = 'glm-4.7-flash+fluent-korean-v2';
const OVERWRITE_TRANSLATION_REASONS = new Set(['fluent_refresh', 'quality_retry', 'manual']);
const FLUENT_REFRESH_BATCH_SIZE = 4;
// Default daily cap for the OPTIONAL fluent-Korean refresh pass (re-polishing
// cards that already passed translation + AI review). This never gates new
// article translation or the AI quality review — only how fast already-good
// cards get further improved. Override at runtime with the
// FLUENT_REFRESH_DAILY_CAP var/secret (see getFluentRefreshDailyCap) to throttle
// Workers AI Neuron spikes without a redeploy; leave unset to keep this default.
const FLUENT_REFRESH_DAILY_CAP = 100;

// Adapted from https://github.com/snflkd/fluent-korean (fluent-korean-not-coding).
// The upstream README asks not to summarize these clauses: examples carry the intended behavior.
const FLUENT_KOREAN_GUIDE = `당신은 한국어를 활용해야 하는 상황에 있다면 본 문서에 제시된 지침들을 준수해야 합니다. 그럼으로써 의사소통의 효율성을 높일 수 있습니다. 이 지침들은, 의미가 명확하며 비교적 가독성이 높고 안정적인 구조를 지닌 한국어 문장을 출력하는 방법을 자세히 설명합니다. JSON 키 이름과 제품명, 버전, 리전 코드, 날짜, 숫자에는 이 지침들을 적용하지 않고 원문을 유지합니다.

## 상황과 목표

- LLM은 한국어를 구사할 때 몇 가지 특징을 보이는데, 일부 특징은 결과물의 완성도를 낮추거나, 사용자가 소통에 더 많은 노력을 들이게 만듭니다. 이 문서에 작성된 사항들을 준수하면 이런 현상을 개선할 수 있습니다.

- 이 문서에서 제시하는 지침들을 요약하는 것은 일반적으로 권장되지 않습니다. 그렇게 한다면 조항마다 첨부된 예시를 확인할 수 없으므로 조항의 문구가 구체적으로 어떤 동작을 의도했는지 파악하기 어렵습니다. 또한 요약에 포함된 몇 가지 지침을 제외한 나머지 지침들은 잘 준수되지 않는 방향으로 서술 압력이 작동하게 될 수도 있습니다. 그리고 목적과 의도를 생략하고 제한 사항만 요약한다면 목적에 부합하지 않게 기계적으로 지침을 준수했는지 확인하게 될 수도 있습니다.

## 동작 범위

1. 본문의 지침들은 한국어를 활용하는 상황에서 그 한국어를 명확하게 출력하라는 지시입니다. 외국어 문장이나 어휘를 출력해야 하는 상황에서, 그것을 한국어로 번역하거나 대체하라는 지시가 아닙니다.

2. 고유 명사와 기술 용어 등은, 통상적인 용례로 정착된 번역어 혹은 음차가 있다면 우선적으로 사용하고, 그렇지 않다면 원어를 유지함으로써, 한국어 사용자가 이해하기 편하고 의미를 잘 이해할 수 있도록 합니다.

3. 사용자가 어떤 어조나 어휘를 사용하든지, 사용자 메시지의 어조를 모방하지 않고, 본문에서 제시하는 지침들을 일관되게 유지합니다.

## 문장 단위

1. 읽는 이가 문장의 의미를 충분히 이해할 수 있어야 하므로, 의미가 있는 문장 성분을 생략하지 않습니다. [그러면 경고가 붙습니다.→ ('그러면 이미 작업중인 파일에도 경고 표지가 추가됩니다.'와 같이, 맥락과 정보를 충분히 제공하도록 수정) ]  특히 관형격 조사인 '~의'를 필요 이상으로 사용한다면, 의미를 담고 있는 문장 성분을 생략하기 쉬우므로 유의해야 합니다.  [사본의 문구는 작업의 상황을 → 사본에 기재된 문구는 작업이 진행되는 상황을]

2. (이 2번 조항은 제목과 목록에는 강제로 적용되는 사항이 아닙니다.) 명사구나 부사구, 연결어미로 문장을 끝내지 말고, 서술어와 종결어미를 사용하여 완성된 형태의 문장으로 끝을 맺어야 합니다.

## 구 단위

1. 필수적인 경우가 아니라면 조사와 어미를 생략하지 말아야 합니다. 또한 부사, 보조사와 선어말어미, 보조 용언을 적극적으로 활용하면, 의미가 명확한 한국어 문장을 완성할 수 있습니다. [이 결정은 이후 중요 정책이 갈리는 자리. 컨텍스트 압축 전 신중 반영한다. → 이 결정은 이후 중요한 정책에 지속적으로 영향을 주기 때문에, 컨텍스트가 압축되기 전에 신중히 반영합니다. → 지금 답변해주신 결정 사항은 이후 중요한 정책에도 지속적으로 영향을 미치기 때문에, 컨텍스트가 압축되기 전에 미리 신중하게 반영해 놓겠습니다.]

2. 구체적인 의미를 담고 있는 한자어와 자연스러운 통사 구조를 결합하면, 풍부하고 명확한 의미를 전달할 수 있습니다. 따라서 맥락에 적합한 한자어를 적극적으로 활용하고, 그 한자어에 조사와 어미를 붙여서 어휘 사이의 관계를 확실하게 나타내야 합니다. [<쓴 비용을 구하는 토큰 카운트 함수에 문제가 생기면 (상황에 적합한 어휘가 사용되지 않아 의미가 불충분함) /지출 비용 추론 용도의 토큰 카운트 함수의 오류 상황에서 (조사와 어미가 없어 가독성이 낮고 의미 관계가 불분명함)>  → 지출한 비용을 추론하는 토큰 카운트 함수에 오류가 발생하면 (이 지침의 목표 예시)]

3. 일반적인 어휘를 사용해야 하는 자리에 비유적 어휘를 사용하면 가독성이 낮고, 의미가 변질되기 쉽습니다. 따라서 꼭 필요한 경우가 아니라면 비유적 어휘로 일반적인 명사나 동사를 대체하지 않습니다. 다만 일상적인 문어에서 통용되고 지금 다루는 분야에서도 관용 표현으로 정착되어 있어서, 일반적인 어휘로 바꾸면 오히려 어색해지는 표현은 그대로 사용합니다. [<분석의 흐름 → 분석의 방향성>, <코드로 박는 자리 → 코드에 명시하는 상황 (혹은 코드에 명시하는 작업)>, <요청을 받습니다 -> 요청을 확인했습니다 (혹은 요청대로 수행하겠습니다)>]

4. 엠대시(—)는 앞뒤 문장의 관계를 지나치게 함축하기 때문에 자제하고, 문맥에 따라 콜론이나 접속사로 대체합니다.

## 이 서비스에 추가로 적용하는 사항

- 한국어로 출력되는 모든 결과물에도 이 지침들을 적용합니다. JSON의 title, summary, target, features, regions 값이 모두 해당합니다.
- JSON을 출력하기 직전에, 위의 지침들에 어긋난 부분을 반드시 점검하고 수정한 후에 출력합니다.
- 제품명, 서비스명, 버전, 리전 코드, CVE 번호, 날짜, 수치는 원문을 유지합니다.
- 클라우드 분야에서 이미 정착된 번역어가 있으면 그 번역어를 사용합니다. [continuous delivery → 지속적 배포, runtime → 런타임, preview → 미리보기, machine series → 머신 시리즈, customer-managed key → 고객 관리 키]
- 영어 고유명사 뒤의 조사는 실제 발음의 받침을 기준으로 고릅니다. [Compute Engine를 → Compute Engine을, Amazon Bedrock와 → Amazon Bedrock과, Application Integration를 → Application Integration을, Amazon Bedrock을]
- 요약 첫 문장에서 주어와 핵심 변화를 생략한 채 '이는', '또한', '이제', '이 기능은', '이 변경으로'로 시작하지 않습니다. 영어 원문의 무엇을 바꾸었는지를 첫 문장에 분명히 적습니다.
- 제목을 영어 원문 그대로 두거나, delivers / announces / now supports 같은 영어 동사에서 자르지 않습니다. [AWS Glue 6.0 delivers → AWS Glue 6.0 가격 인하 및 Iceberg v3 지원]
- '고객님' 같은 과한 호칭은 사용하지 않습니다.`;

const LANG_PROFILES = {
  ko: {
    name: 'Korean',
    nameLocal: '한국어',
    statuses: ['정식 출시', '미리보기', '베타', '지원 종료'],
    statusMap: { ga: '정식 출시', preview: '미리보기', beta: '베타', retire: '지원 종료' },
    rules: `- Translate ALL other English to Korean. Never mix (e.g. write "및" not "and 및").
- Title: Product name + core change, max 40 Korean characters. Remove status tags like [Preview], [Launched], [Retired], (GA). The title is a noun phrase, never a full sentence — it must not end with 합니다/됩니다/다. or a period. Never leave English verbs such as delivers, announces, now supports in the title. Never coin an acronym that is not in the source (write "Trusted Launch as Default", not "TLaD").
- Summary: 1 or 2 complete sentences in natural, technical Korean. Each sentence must have a subject and a closing verb ending.
  - First sentence: State the actual technical change with product names, features, or metrics. Do not start with "이는", "또한", "이제", "이 기능은".
  - Second sentence ONLY if the source gives new information not already in the first sentence: how to enable it, limits, prerequisites, deprecated versions, pricing, or regions. If there is nothing new, write ONE sentence.
  - Never pad: do not restate the title, do not restate the target audience as a sentence ("~를 운영하는 관리자는 ~를 관리해야 합니다"), do not repeat the first sentence with different wording, and do not add generic template expressions like "이를 통해 효율성이 향상됩니다".
  - No instructions to the reader (참조하세요, 사용하세요, 확인하십시오). Describe facts only.
- Target: A specific target audience (e.g., "AWS Lambda를 사용하는 백엔드 개발자" or "Cloud Composer를 운영하는 데이터 엔지니어"). Avoid generic targets like "모든 개발자". Attach 을/를, 이/가, 은/는, 과/와 according to the pronounced final sound of the English product name.
- Regions: Vendor standard Korean region names or "모든 리전".`,
    sysPrompt: 'You are a Korean cloud news summarizer for IT professionals. Write clear, fluent Korean that a Korean engineer can read without reconstructing omitted particles or subjects.'
  },
  en: {
    name: 'English',
    nameLocal: 'English',
    statuses: ['General Availability', 'Preview', 'Beta', 'End of Support'],
    statusMap: { ga: 'General Availability', preview: 'Preview', beta: 'Beta', retire: 'End of Support' },
    rules: `- Output everything in clear, concise technical English.
- Title: Product name + core change, max 60 characters. Remove status tags like [Preview], [Launched], [Retired], (GA). Never use a full sentence as title.
- Summary: Exactly 2 sentences in natural, technical English.
  - First sentence: Describe the key technical change, including specific product names, features, or metrics. Avoid vague descriptions.
  - Second sentence: Explain the practical impact, compatibility notes, or actions required for developers/engineers (e.g. upgrade paths, deprecated versions, or default setting changes).
  - Do NOT use generic template expressions like "This improves efficiency" or simply repeating the title.
- Target: A specific target audience (e.g., "Backend developers building serverless applications on AWS Lambda"). Avoid generic targets like "all users".
- Regions: Vendor standard English region names or "All regions".`,
    sysPrompt: 'You are an English cloud news summarizer for IT professionals.'
  },
  ja: {
    name: 'Japanese',
    nameLocal: '日本語',
    statuses: ['一般提供', 'プレビュー', 'ベータ', 'サポート終了'],
    statusMap: { ga: '一般提供', preview: 'プレビュー', beta: 'ベータ', retire: 'サポート終了' },
    rules: `- Translate ALL English to Japanese. Never mix.
- Title: Product name + core change, max 40 Japanese characters. Remove status tags like [Preview], [Launched], [Retired], (GA). Never use a full sentence as title.
- Summary: Exactly 2 sentences in natural, technical Japanese.
  - First sentence: Describe the key technical change, including specific product names, features, or metrics. Avoid vague descriptions.
  - Second sentence: Explain the practical impact, compatibility notes, or actions required for developers/engineers (e.g. upgrade paths, deprecated versions, or default setting changes).
  - Do NOT use generic template expressions like "これにより効率が向上します".
- Target: A specific target audience (e.g., "AWS Lambdaを使用するバックエンド開発者"). Avoid generic targets like "すべてのユーザー".
- Regions: Vendor standard Japanese region names or "すべてのリージョン".`,
    sysPrompt: 'You are a Japanese cloud news summarizer for IT professionals.'
  }
};

function getTranslationPrompt(lang) {
  const profile = LANG_PROFILES[lang] || LANG_PROFILES.ko;
  const isKo = lang === 'ko';
  const isJa = lang === 'ja';
  
  const translationRules = `- Keep product names, versions, dates, region codes in English as-is.
${profile.rules}
- Status determination: Must be determined from the description context. Choose from: ${profile.statuses.map(s => `"${s}"`).join(', ')}.
  - Default: "${profile.statuses[0]}" (Default status for general availability, GA, launched, now available, or standard updates).
  - "${profile.statuses[1]}" (Preview / Public Preview / In preview): If the description explicitly states the service/feature is in "preview". Note: AWS and Azure almost always use "Preview" for pre-release features.
  - "${profile.statuses[2]}" (Beta / Public Beta): Only if the service is explicitly described as "beta" (mainly Google Cloud or third-party products like Anthropic). Never label AWS or Azure services as "${profile.statuses[2]}" unless the word "beta" is explicitly present in the original text.
  - "${profile.statuses[3]}" (Retired / Deprecated / End of Support): If the service/feature is being retired, deprecated, or disabled.
  - Avoid false positives: version numbers containing "-beta" or "preview" (e.g., Kubernetes v1.30-beta.0) are version strings, NOT the release status of the cloud service itself. Set the status of such version updates to "${profile.statuses[0]}" unless the service itself is in preview/beta.
- Features: Exactly 3 key technical capabilities or changes introduced, separated by commas. Focus on concrete technical facts (e.g. new APIs, supported versions, pricing changes, or limit increases) rather than high-level marketing descriptions.
- GCP date entries: ${isKo ? 'YYYY년 M월 D일: main product 외 N건' : isJa ? 'YYYY年M月D日: main productほかN件' : 'YYYY-MM-DD: main product and N other updates'}
- MUST KEEP ENTITIES in user message — reproduce exactly.`;

  const fluentKoreanBlock = isKo ? `

KOREAN WRITING GUIDE — follow every clause. Do not skip examples.
${FLUENT_KOREAN_GUIDE}

Before you emit JSON, reread title, summary, target, features, and regions and fix any clause that violates the guide.` : '';

  const sysPrompt = `${profile.sysPrompt}

OUTPUT: valid JSON only, no markdown wrapping.

PROCESS — follow this order:
1. Read the Description and summarize in ${profile.nameLocal} (1–2 sentences: what changed, plus one sentence of concrete detail only if the source has it).
2. From the summary, derive a short ${profile.nameLocal} title: product name + core change.
3. Determine status from description content.
4. Fill target (who benefits), features (3 capability descriptions), regions.

RULES:
${translationRules}
${fluentKoreanBlock}`;

  return { sysPrompt, rules: translationRules, profile };
}

const FEW_SHOT_KO = [
  { role: 'user', content: 'Title: AWS Lambda now supports Python 3.13 runtime\nDescription: Customers can now create and update Lambda functions using Python 3.13. Python 3.13 includes improved error messages, a new REPL, and performance improvements. Available in all AWS Regions where Lambda is available.' },
  { role: 'assistant', content: '{"title":"AWS Lambda에서 Python 3.13 런타임 지원","summary":"AWS Lambda에서 Python 3.13 런타임을 선택해 함수를 만들고 업데이트할 수 있게 되었습니다. 개선된 오류 메시지와 새로운 REPL, 성능 향상을 쓰려면 기존 Python 3.12 함수의 런타임 업그레이드를 검토해야 합니다.","target":"Python으로 Lambda 기반 서버리스 백엔드를 운영하는 백엔드 개발자","features":"Python 3.13 런타임 선택 가능, 오류 메시지 개선, 콜드스타트 단축 기대","regions":"Lambda가 제공되는 모든 AWS 리전","status":["정식 출시"]}' },
  { role: 'user', content: 'Title: March 27, 2026\nDescription: Cloud Composer: Cloud Composer 2 environments can no longer be created in Melbourne (australia-southeast2). Compute Engine: A vulnerability (CVE-2026-23268) has been addressed.' },
  { role: 'assistant', content: '{"title":"2026년 3월 27일: Cloud Composer 외 1건","summary":"Melbourne(australia-southeast2) 리전에서는 Cloud Composer 2 환경을 새로 만들 수 없게 되어 Cloud Composer 3으로 전환해야 합니다. Compute Engine에는 CVE-2026-23268 보안 취약점 패치가 적용되었습니다.","target":"australia-southeast2 리전에서 Cloud Composer를 운영하는 데이터 엔지니어","features":"Melbourne 리전 Composer 2 생성 중단, CVE-2026-23268 패치 적용, Composer 3 전환 필요","regions":"australia-southeast2, 모든 리전","status":["정식 출시"]}' },
  { role: 'user', content: 'Title: [Preview] Azure Cosmos DB continuous backup for analytical store\nDescription: Azure Cosmos DB now supports continuous backup and point-in-time restore for analytical store data. This feature is currently in public preview.' },
  { role: 'assistant', content: '{"title":"Azure Cosmos DB 분석 저장소 연속 백업 지원","summary":"Azure Cosmos DB 분석 저장소에서도 연속 백업과 특정 시점 복원을 사용할 수 있게 되었습니다. 현재 공개 미리보기이므로 운영 워크로드에 적용하기 전에 복원 지점과 보존 기간을 확인해야 합니다.","target":"Azure Cosmos DB 분석 저장소를 운영하는 데이터 엔지니어","features":"분석 저장소 연속 백업, 특정 시점 복원, 공개 미리보기 제공","regions":"모든 Azure 퍼블릭 리전","status":["미리보기"]}' }
];

const FEW_SHOT_EN = [
  { role: 'user', content: 'Title: AWS Lambda now supports Python 3.13 runtime\nDescription: Customers can now create and update Lambda functions using Python 3.13. Python 3.13 includes improved error messages, a new REPL, and performance improvements. Available in all AWS Regions where Lambda is available.' },
  { role: 'assistant', content: '{"title":"AWS Lambda adds support for Python 3.13 runtime","summary":"Developers can now use Python 3.13 to build and run Lambda functions, leveraging new features like improved error messages, an interactive REPL, and performance optimizations. If you are running existing Python 3.12 functions, it is time to plan runtime upgrades.","target":"Backend developers building serverless applications on AWS Lambda using Python","features":"Support for Python 3.13 runtime, improved error reporting, faster cold starts","regions":"All AWS Regions","status":["General Availability"]}' },
  { role: 'user', content: 'Title: March 27, 2026\nDescription: Cloud Composer: Cloud Composer 2 environments can no longer be created in Melbourne (australia-southeast2). Compute Engine: A vulnerability (CVE-2026-23268) has been addressed.' },
  { role: 'assistant', content: '{"title":"March 27, 2026: Cloud Composer and 1 other update","summary":"Creation of Cloud Composer 2 environments has been disabled in the Melbourne region, necessitating migration to Cloud Composer 3. Additionally, a security vulnerability (CVE-2026-23268) has been patched in Compute Engine.","target":"Data engineers running Cloud Composer environments in australia-southeast2","features":"Melbourne Composer 2 creation disabled, CVE-2026-23268 security patch, migration to Composer 3 required","regions":"australia-southeast2, All regions","status":["General Availability"]}' },
  { role: 'user', content: 'Title: [Preview] Azure Cosmos DB continuous backup for analytical store\nDescription: Azure Cosmos DB now supports continuous backup and point-in-time restore for analytical store data. This feature is currently in public preview.' },
  { role: 'assistant', content: '{"title":"Azure Cosmos DB supports continuous backup for analytical store","summary":"Azure Cosmos DB analytical store now supports continuous backup and point-in-time restore capabilities. This ensures enhanced data protection and recovery for analytical workloads.","target":"Data engineers managing Azure Cosmos DB analytical stores","features":"Analytical store continuous backup, point-in-time restore, enhanced data protection","regions":"All public Azure regions","status":["Preview"]}' }
];

const FEW_SHOT_JA = [
  { role: 'user', content: 'Title: AWS Lambda now supports Python 3.13 runtime\nDescription: Customers can now create and update Lambda functions using Python 3.13. Python 3.13 includes improved error messages, a new REPL, and performance improvements. Available in all AWS Regions where Lambda is available.' },
  { role: 'assistant', content: '{"title":"AWS LambdaがPython 3.13ランタイムのサポートを開始","summary":"Lambda関数で改善されたエラーメッセージや新しいREPL, パフォーマンス向上など、Python 3.13の主要機能を直接利用できるようになりました。既存のPython 3.12関数を運用している場合は、ランタイムのアップグレードを検討するタイミングです。","target":"LambdaベースのサーバーレスバックエンドをPythonで構築するバックエンド開発者","features":"Python 3.13ランタイム選択可能, エラーメッセージの改善, コールドスタート短縮の期待","regions":"Lambdaが提供されるすべてのAWSリージョン","status":["一般提供"]}' },
  { role: 'user', content: 'Title: March 27, 2026\nDescription: Cloud Composer: Cloud Composer 2 environments can no longer be created in Melbourne (australia-southeast2). Compute Engine: A vulnerability (CVE-2026-23268) has been addressed.' },
  { role: 'assistant', content: '{"title":"2026年3月27日: Cloud Composerほか1件","summary":"メルボルンリージョンでのCloud Composer 2環境の新設が停止され、Cloud Composer 3への移行が必要となります。また、Compute Engineにおいて脆弱性（CVE-2026-23268）のセキュリティパッチが適用されました。","target":"australia-southeast2リージョンでCloud Composerを運用するデータエンジニア","features":"メルボルンリージョンでのComposer 2新設停止, CVE-2026-23268のパッチ適用, Composer 3への移行推奨","regions":"australia-southeast2, すべてのリージョン","status":["一般提供"]}' },
  { role: 'user', content: 'Title: [Preview] Azure Cosmos DB continuous backup for analytical store\nDescription: Azure Cosmos DB now supports continuous backup and point-in-time restore for analytical store data. This feature is currently in public preview.' },
  { role: 'assistant', content: '{"title":"Azure Cosmos DBの分析ストア連続バックアップをサポート","summary":"Azure Cosmos DBの分析ストアにおいて、連続バックアップとポイントインタイム復元が可能になりました。分析ワークロードのデータ保護が大幅に強化されます。","target":"Azure Cosmos DB分析ストアを運用するデータエンジニア","features":"分析ストア連続バックアップ, ポイントインタイム復元, データ保護の強化","regions":"すべてのAzureパブリックリージョン","status":["プレビュー"]}' }
];

const DEFAULT_QUEUE_LANG = 'ko';
const RETRY_BASE_DELAY_SECONDS = 30;
let translationJobStateReady = false;
function buildBadQualityFilter() {
  return `
    lc.lang = 'ko' AND lc.reviewed_at IS NULL AND lc.model_used != 'manual' AND (
      ${buildAwkwardKoreanPredicates()}
    )`;
}

function buildAwkwardKoreanPredicates() {
  return `
      lc.title LIKE '%.graphics%'
      OR lc.title GLOB '* [A-Za-z]'
      OR lc.title GLOB '*[(/-]'
      OR lc.title = a.title_en
      OR substr(lc.summary, 1, 20) = substr(lc.title, 1, 20)
      OR length(lc.summary) < 30
      OR lc.summary LIKE '%_workflow_%'
      OR lc.summary LIKE '%**%'
      OR lc.summary LIKE '%\`%'
      OR (lc.status LIKE '%정식 출시%' AND (lc.summary LIKE '%preview%' OR lc.summary LIKE '%미리보기%'))
      OR lc.title LIKE '%and 및%'
      OR lc.title LIKE '%delivers%'
      OR lc.title LIKE '%announces%'
      OR lc.title LIKE '%now supports%'
      OR lc.title LIKE '%is now available%'
      OR lc.title LIKE '%합니다'
      OR lc.title LIKE '%됩니다'
      OR lc.title LIKE '%다.'
      OR lc.title LIKE '% Feature For %'
      OR lc.title LIKE '% Feature %'
      OR lc.title LIKE '%TLaD%'
      OR (lc.title LIKE '%Amazon Connect Customer%' AND lc.title NOT LIKE '%Customer Profiles%')
      OR lc.summary LIKE '%하세요.%'
      OR lc.summary LIKE '%하십시오.%'
      OR lc.summary LIKE '%. 또한 %'
      OR lc.summary GLOB '*[a-z][a-z][a-z]하거나*'
      OR lc.summary GLOB '*[a-z][a-z][a-z]하여 *'
      OR lc.summary GLOB '*[a-z][a-z][a-z]합니다*'
      OR lc.title NOT GLOB '*[가-힣]*'
      OR (lc.title LIKE 'Azure:%' AND replace(lc.title, 'Azure:', '') NOT GLOB '*[A-Za-z]*')
      OR lc.summary LIKE '이는%'
      OR lc.summary LIKE '또한%'
      OR lc.summary LIKE '이제 %'
      OR lc.summary LIKE '이 기능%'
      OR lc.summary LIKE '이 변경%'
      OR lc.summary LIKE '이러한%'
      OR lc.summary LIKE '이 업데이트%'
      OR lc.summary LIKE '이 새로운%'
      OR lc.title LIKE '%기계 시리즈%'
      OR lc.title LIKE '%소녀%'
      OR lc.title LIKE '%원롔%'
      OR lc.title LIKE '%원룱%'
      OR lc.title LIKE '%증놀%'
      OR lc.title LIKE '%조백호%'
      OR lc.title LIKE '%관래밍%'
      OR lc.target LIKE '%Engine를%'
      OR lc.target LIKE '%Platform를%'
      OR lc.target LIKE '%Integration를%'
      OR lc.target LIKE '%Bedrock와%'
      OR lc.target LIKE '%Service를%'
      OR lc.summary LIKE '%연속 배달%'
      OR lc.summary GLOB '*[一-龥]*'
      OR lc.summary GLOB '*[ぁ-ヿ]*'
      OR lc.title GLOB '*[一-龥]*'
      OR lc.title GLOB '*[ぁ-ヿ]*'
      OR lc.features GLOB '*[一-龥]*'
  `;
}

function buildFluentRefreshFilter() {
  return `
    lc.lang = 'ko'
    AND IFNULL(lc.model_used, '') != '${FLUENT_KOREAN_MODEL_TAG}'
    AND IFNULL(lc.model_used, '') != 'manual'`;
}

const REGION_DISPLAY_MAP = {
  ko: {
    aws: {
      'Asia Pacific (New Zealand)': '아시아 태평양(뉴질랜드) 리전',
      'Asia Pacific (Tokyo)': '아시아 태평양(도쿄) 리전',
      'Asia Pacific (Seoul)': '아시아 태평양(서울) 리전',
      'Asia Pacific (Osaka)': '아시아 태평양(오사카) 리전',
      'Asia Pacific (Sydney)': '아시아 태평양(시드니) 리전',
      'Asia Pacific (Melbourne)': '아시아 태평양(멜버른) 리전',
      'Asia Pacific (Jakarta)': '아시아 태평양(자카르타) 리전',
      'Asia Pacific (Mumbai)': '아시아 태평양(뭄바이) 리전',
      'Asia Pacific (Hong Kong)': '아시아 태평양(홍콩) 리전',
      'Asia Pacific (Singapore)': '아시아 태평양(싱가포르) 리전',
      'Europe (Ireland)': '유럽(아일랜드) 리전',
      'Europe (London)': '유럽(런던) 리전',
      'Europe (Frankfurt)': '유럽(프랑크푸르트) 리전',
      'Europe (Paris)': '유럽(파리) 리전',
      'Europe (Stockholm)': '유럽(스톡홀름) 리전',
      'Europe (Zurich)': '유럽(취리히) 리전',
      'US East (N. Virginia)': '미국 동부(버지니아 북부) 리전',
      'US East (Ohio)': '미국 동부(오하이오) 리전',
      'US West (Oregon)': '미국 서부(오리건) 리전',
      'US West (N. California)': '미국 서부(캘리포니아 북부) 리전',
      'South America (Sao Paulo)': '남아메리카(상파울루) 리전',
      'Middle East (UAE)': '중동(UAE) 리전',
      'Middle East (Bahrain)': '중동(바레인) 리전',
      'Africa (Cape Town)': '아프리카(케이프타운) 리전',
      'Canada (Central)': '캐나다(중부) 리전',
    },
    gcp: {
      'asia-northeast3': '서울 리전',
      'asia-northeast1': '도쿄 리전',
      'asia-southeast1': '싱가포르 리전',
      'australia-southeast1': '시드니 리전',
      'australia-southeast2': '멜버른 리전',
      'us': 'US 멀티 리전',
      'eu': 'EU 멀티 리전',
    },
    azure: {
      'New Zealand North': '뉴질랜드 북부',
      'Korea Central': '한국 중부',
      'Korea South': '한국 남부',
      'Japan East': '일본 동부',
      'Japan West': '일본 서부',
      'Australia East': '오스트레일리아 동부',
      'Australia Southeast': '오스트레일리아 남동부',
      'Denmark East': '덴마크 동부',
      'Denmark West': '덴마크 서부',
      'East US': '미국 동부',
      'East US 2': '미국 동부 2',
      'West US': '미국 서부',
      'West US 2': '미국 서부 2',
      'West US 3': '미국 서부 3',
      'North Europe': '북유럽',
      'West Europe': '서유럽',
    }
  },
  ja: {
    aws: {
      'Asia Pacific (New Zealand)': 'アジア太平洋 (ニュージーランド) リージョン',
      'Asia Pacific (Tokyo)': 'アジア太平洋 (東京) リージョン',
      'Asia Pacific (Seoul)': 'アジア太平洋 (ソウル) リージョン',
      'Asia Pacific (Osaka)': 'アジア太平洋 (大阪) リージョン',
      'Asia Pacific (Sydney)': 'アジア太平洋 (シドニー) リージョン',
      'Asia Pacific (Melbourne)': 'アジア太平洋 (メルボルン) リージョン',
      'Asia Pacific (Jakarta)': 'アジア太平洋 (ジャカルタ) リージョン',
      'Asia Pacific (Mumbai)': 'アジア太平洋 (ムンバイ) リージョン',
      'Asia Pacific (Hong Kong)': 'アジア太平洋 (香港) リージョン',
      'Asia Pacific (Singapore)': 'アジア太平洋 (シンガポール) リージョン',
      'Europe (Ireland)': '欧州 (アイルランド) リージョン',
      'Europe (London)': '欧州 (ロンドン) リージョン',
      'Europe (Frankfurt)': '欧州 (フランクフルト) リージョン',
      'Europe (Paris)': '欧州 (パリ) リージョン',
      'Europe (Stockholm)': '欧州 (ストックホルム) リージョン',
      'Europe (Zurich)': '欧州 (チューリッヒ) リージョン',
      'US East (N. Virginia)': '米国東部 (バージニア北部) リージョン',
      'US East (Ohio)': '米国東部 (オハイオ) リージョン',
      'US West (Oregon)': '米国西部 (オレゴン) リージョン',
      'US West (N. California)': '米国西部 (北カリフォルニア) リージョン',
      'South America (Sao Paulo)': '南米 (サンパウロ) リージョン',
      'Middle East (UAE)': '中東 (UAE) リージョン',
      'Middle East (Bahrain)': '中東 (バーレーン) リージョン',
      'Africa (Cape Town)': 'アフリカ (ケープタウン) リージョン',
      'Canada (Central)': 'カナダ (中部) リージョン',
    },
    gcp: {
      'asia-northeast3': 'ソウル リージョン',
      'asia-northeast1': '東京 リージョン',
      'asia-southeast1': 'シンガポール リージョン',
      'australia-southeast1': 'シドニー リージョン',
      'australia-southeast2': 'メルボルン リージョン',
      'us': 'US マルチリージョン',
      'eu': 'EU マルチリージョン',
    },
    azure: {
      'New Zealand North': 'ニュージーランド北',
      'Korea Central': '韓国中部',
      'Korea South': '韓国南部',
      'Japan East': '東日本',
      'Japan West': '西日本',
      'Australia East': 'オーストラリア東部',
      'Australia Southeast': 'オーストラリア南東部',
      'Denmark East': 'デンマーク東部',
      'Denmark West': 'デンマーク西部',
      'East US': '米国東部',
      'East US 2': '米国東部 2',
      'West US': '米国西部',
      'West US 2': '米国西部 2',
      'West US 3': '米国西部 3',
      'North Europe': '北ヨーロッパ',
      'West Europe': '西ヨーロッパ',
    }
  }
};

const VENDOR_REGION_GUIDE = {
  aws: [
    'For AWS, prefer the Korean naming style used on AWS Korea pages, for example Asia Pacific (New Zealand) -> 아시아 태평양(뉴질랜드) 리전 and US East (Ohio) -> 미국 동부(오하이오) 리전.',
    'If the source says all AWS Regions, output regions as 모든 AWS 리전.',
  ],
  gcp: [
    'For Google Cloud, prefer natural Korean region names such as asia-northeast3 -> 서울 리전 and asia-northeast1 -> 도쿄 리전.',
    'If a region code appears in the source, you may mention the Korean region name in title/summary and should avoid awkward raw-code-only phrasing in user-facing copy.',
    'Use rough geographic labels only when the source itself uses multi-region labels such as us or eu, and write them as US 멀티 리전 or EU 멀티 리전.',
    'If the source says all regions or does not specify a region, output regions as 모든 리전. Do not invent abbreviations such as APNZ.',
  ],
  azure: [
    'For Azure, prefer the official Korean display names used on Microsoft Learn, for example New Zealand North -> 뉴질랜드 북부 and Korea South -> 한국 남부.',
    'If the source says all public Azure regions, output regions as 모든 Azure 퍼블릭 리전.',
  ],
};

const VENDOR_REGION_EXAMPLES = {
  aws: [
    'EXAMPLE: Source mentions "Asia Pacific (New Zealand)" -> title can use "아시아 태평양(뉴질랜드) 리전에서 사용 가능", regions should be "아시아 태평양(뉴질랜드) 리전".',
    'EXAMPLE: Source mentions "Asia Pacific (Seoul)" -> use "아시아 태평양(서울) 리전", not "AWS 아시아 태평양(서울) 리전".',
    'EXAMPLE: Source mentions "all AWS Regions" -> regions should be "모든 AWS 리전".',
  ],
  gcp: [
    'EXAMPLE: Source mentions "asia-northeast3" -> use "서울 리전".',
    'EXAMPLE: Source mentions "asia-northeast1" -> use "도쿄 리전".',
    'EXAMPLE: Source mentions "asia-southeast1" -> use "싱가포르 리전".',
    'EXAMPLE: Source mentions "australia-southeast1" -> use "시드니 리전".',
    'EXAMPLE: Source mentions "US and EU multi-regions" -> regions should be "US 멀티 리전, EU 멀티 리전".',
    'EXAMPLE: Source mentions "available in all regions" -> regions should be "모든 리전".',
  ],
  azure: [
    'EXAMPLE: Source mentions "New Zealand North" -> use the Korean display name "뉴질랜드 북부".',
    'EXAMPLE: Source mentions "Korea Central and Korea South" -> regions should be "한국 중부, 한국 남부".',
    'EXAMPLE: Source mentions "all public Azure regions" -> regions should be "모든 Azure 퍼블릭 리전".',
  ],
};

const TRANSLATION_JSON_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      target: { type: 'string' },
      features: { type: 'string' },
      regions: { type: 'string' },
      status: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'summary', 'target', 'features', 'regions', 'status'],
  },
};

const QUALITY_REVIEW_JSON_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pass: { type: 'boolean' },
      reasons: {
        type: 'array',
        items: { type: 'string' },
      },
      suggested_title: { type: 'string' },
      suggested_summary: { type: 'string' },
    },
    required: ['pass', 'reasons', 'suggested_title', 'suggested_summary'],
  },
};

const QUALITY_REVIEW_PROMPT = `You are a Korean editor reviewing cloud release-note cards before they are shown to users.

GOAL:
- Catch broken or awkward Korean cards that would look untrustworthy in production.
- Focus on title completeness, natural Korean, omitted particles/subjects, and stray markdown or unfinished English fragments.
- Prefer the official Korean region naming style used by each vendor's Korean documentation.

FAIL if any of these are true:
- The title looks truncated, incomplete, cuts a product/service name, or still contains English verbs such as delivers/announces/now supports.
- The summary contains stray markdown/code tokens such as _workflow_, **, or backticks.
- The summary omits the subject and starts with 이는/또한/이제/이 기능은/이 변경으로.
- The summary reads like literal machine translation and would look awkward to Korean engineers.
- Particles after English product names are wrong (Compute Engine를, Amazon Bedrock와, Application Integration를).
- The title is too vague, mirrors the English title too closely, or the summary mostly repeats the title.
- The summary is not one or two Korean sentences with closing verb endings, or the second sentence merely restates the first sentence / the title / the target audience.
- The summary tells the reader to do something (참조하세요, 사용하세요) instead of describing the change.
- The title is a full sentence (ends with 합니다/됩니다/다.) or contains an acronym that does not appear in the English source.
- The regions field uses made-up shorthand or mixes inconsistent region naming styles.

EDITING RULES:
- Keep product names, service names, versions, region codes, dates, and numbers unchanged.
- Do not add new facts.
- Remove status labels like Preview/GA from the title unless they are essential; status belongs elsewhere.
- If a small copy edit can fix the card, provide suggested_title and/or suggested_summary.
- suggested_summary must still be exactly two sentences.
- If the card is already good, set pass=true and leave suggestions empty.

Return JSON only.`;

function decodeEntities(s) {
  // Decode &amp; LAST so an entity like &amp;lt; is not double-unescaped into a
  // literal '<' (flagged by js/double-escaping). Named entities resolve first,
  // then the bare ampersand.
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Strip HTML tags robustly. A single pass of /<[^>]+>/ can leave a `<script`
// fragment behind for malformed/nested input like `<scr<script>ipt>`, which
// CodeQL flags as incomplete multi-character sanitization. Repeat until stable,
// then drop any leftover lone angle brackets.
function stripTags(s) {
  let prev;
  let out = String(s);
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, ' ');
  } while (out !== prev);
  return out.replace(/[<>]/g, ' ');
}

function getEnvInt(env, key, fallback, min = 1, max = 200) {
  const value = parseInt(env[key] || '', 10);
  if (Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function jsonResponse(body, init = {}, extraHeaders = {}) {
  const headers = new Headers(init.headers || {});
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function buildAlertWebhookPayload(webhookUrl, message) {
  let host = '';
  try {
    host = new URL(webhookUrl).hostname.toLowerCase();
  } catch {
    return { content: message };
  }

  if (host === 'slack.com' || host === 'hooks.slack.com' || host.endsWith('.slack.com')) {
    return { text: message };
  }

  return { content: message };
}

function getCorsOrigin(request, env) {
  const requestOrigin = request.headers.get('Origin');
  const siteOrigin = env.SITE_URL || DEFAULT_SITE_URL;
  if (!requestOrigin || requestOrigin === siteOrigin) return siteOrigin;
  return siteOrigin;
}

function parseApiKeyRing(env) {
  const raw = env.API_KEY_RING || '';
  let keys = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        keys = parsed
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => ({
            id: String(entry.id || ''),
            type: String(entry.type || 'service'),
            token: String(entry.token || ''),
          }));
      }
    } catch (error) {
      console.error('Failed to parse API_KEY_RING:', error.message);
    }
  }

  const recoveryToken = String(env.API_KEY_RECOVERY_TOKEN || '').trim();
  if (recoveryToken) {
    keys.push({
      id: 'recovery',
      type: 'service',
      token: recoveryToken,
    });
  }

  try {
    return keys.filter((entry) => entry.id && entry.token);
  } catch (error) {
    console.error('Failed to normalize auth keys:', error.message);
    return [];
  }
}

function getAuthMode(env) {
  const mode = (env.AUTH_ENFORCEMENT || 'on').toLowerCase();
  return ['off', 'warn', 'on'].includes(mode) ? mode : 'on';
}

// /api/articles gate, independent of AUTH_ENFORCEMENT. Missing or unrecognized
// values fail closed. Explicit 'warn' only logs; explicit 'off' disables the gate.
function getSiteApiEnforcement(env) {
  const mode = (env.SITE_API_ENFORCEMENT || 'on').toLowerCase();
  return ['off', 'warn', 'on'].includes(mode) ? mode : 'on';
}

// Which API_KEY_RING key `type` a path requires, beyond just "any valid token".
// /api/pipeline keeps accepting any valid type (service/mcp/recovery), unchanged.
function requiredKeyTypeForPath(path) {
  if (path === '/mcp') return 'mcp';
  if (path === '/api/articles') return 'site';
  return null;
}

function getBearerToken(request) {
  const authHeader = request.headers.get('Authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

function authenticateRequest(request, env) {
  const token = getBearerToken(request);
  const keyRing = parseApiKeyRing(env);
  if (keyRing.length === 0) return { ok: false, reason: 'missing_key_ring' };
  if (!token) return { ok: false, reason: 'missing_header' };

  const key = keyRing.find((entry) => entry.token === token);
  if (!key) return { ok: false, reason: 'invalid_token' };

  return { ok: true, keyId: key.id, keyType: key.type };
}

function logAuthResult(request, path, auth, mode) {
  const ua = request.headers.get('User-Agent') || 'unknown';
  if (auth.ok) {
    // Log non-sensitive, derived identifiers only — never values that flow from
    // the request token. keyType is mapped through a fixed allow-list of known
    // key classes (anything else becomes "other"), and keyId is reduced to a
    // coarse FNV-1a fingerprint, so no token-derived string reaches the log
    // sink. This breaks the taint flow CodeQL's js/clear-text-logging tracks.
    const KNOWN_KEY_TYPES = ['site', 'mcp', 'service', 'ip'];
    const keyTypeLabel = KNOWN_KEY_TYPES.includes(auth.keyType) ? auth.keyType : 'other';
    const keyIdFingerprint = fingerprintId(auth.keyId);
    console.log(`[auth] ok mode=${mode} path=${path} keyType=${keyTypeLabel} keyIdFp=${keyIdFingerprint} ua="${ua}"`);
    return;
  }
  console.warn(`[auth] ${auth.reason} mode=${mode} path=${path} ua="${ua}"`);
}

// Short, non-reversible fingerprint of a key id for correlating log lines
// without logging the id itself (FNV-1a, 32-bit, hex). Not security-sensitive.
function fingerprintId(value) {
  let hash = 0x811c9dc5;
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getAllowedAdminIps(env) {
  return (env.ALLOWED_ADMIN_IPS || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
}

function isAllowedAdminIp(request, env) {
  const allowedIps = getAllowedAdminIps(env);
  if (allowedIps.length === 0) return false;
  const currentIp = request.headers.get('CF-Connecting-IP') || '';
  return allowedIps.includes(currentIp);
}

function parseRSS(xml, csp) {
  const items = [];
  const isAtom = !xml.includes('<item>') && xml.includes('<entry>');
  const tag = isAtom ? 'entry' : 'item';
  const regex = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const block = match[0];
    const get = (t) => {
      const m = block.match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`));
      if (!m) return '';
      let val = m[1].trim();
      // Handle nested or multiple CDATA sections
      val = val.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
      return val;
    };
    const url = isAtom
      ? ((block.match(/<link[^>]*href="([^"]*)"/) || [])[1] || '')
      : (get('link') || get('guid'));
    const rawDate = get('pubDate') || get('updated') || get('published') || '';
    const pubDate = rawDate ? new Date(rawDate).toISOString() : '';
    const rawContent = isAtom ? get('content') : get('description');
    const rawTitle = decodeEntities(stripTags(get('title')));

    // GCP: split by product title (<h2 class="release-note-product-title">)
    if (csp === 'gcp' && rawContent.includes('release-note-product-title')) {
      const sections = rawContent.split(/<h2[^>]*class="release-note-product-title"[^>]*>/);
      for (let i = 1; i < sections.length; i++) {
        const endH2 = sections[i].indexOf('</h2>');
        if (endH2 < 0) continue;
        const productName = decodeEntities(stripTags(sections[i].slice(0, endH2)).trim());
        const body = stripTags(sections[i].slice(endH2 + 5)).replace(/\s+/g, ' ').trim();
        items.push({ csp, title: productName, description: body, url, pub_date: pubDate });
      }
    } else {
      items.push({
        csp,
        title: rawTitle,
        description: stripTags(rawContent).replace(/\s+/g, ' ').trim(),
        url,
        pub_date: pubDate,
      });
    }
  }
  return items;
}

async function fetchRSS(env) {
  let totalNew = 0;
  const jobs = [];

  const feedPromises = Object.entries(RSS_FEEDS).map(async ([csp, url]) => {
    const resp = await fetch(url, { headers: { 'User-Agent': 'CloudWhatsNew/2.0' }, redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP status ${resp.status}`);
    const xml = await resp.text();
    if (!xml.includes('<')) throw new Error('Invalid XML');
    const items = parseRSS(xml, csp).slice(0, 100);
    return { csp, items };
  });

  const feedResults = await Promise.allSettled(feedPromises);
  const allItems = [];

  for (let i = 0; i < feedResults.length; i++) {
    const res = feedResults[i];
    const csp = Object.keys(RSS_FEEDS)[i];
    if (res.status === 'fulfilled') {
      allItems.push(...res.value.items);
    } else {
      console.error(`${csp} fetch error:`, res.reason?.message || res.reason);
    }
  }

  const validItems = allItems.filter(item => item.url || item.title);
  if (validItems.length === 0) {
    return { newArticles: 0, queued: 0 };
  }

  const insertStatements = validItems.map(item =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO articles (csp, url, title_en, description_en, pub_date) VALUES (?,?,?,?,?)'
    ).bind(item.csp, item.url || '', item.title, item.description || '', item.pub_date)
  );
  
  const insertResults = await env.DB.batch(insertStatements);

  const selectStatements = validItems.map(item =>
    env.DB.prepare('SELECT id FROM articles WHERE csp=? AND url=? AND title_en=?')
      .bind(item.csp, item.url || '', item.title)
  );

  const selectResults = await env.DB.batch(selectStatements);

  const localizedInsertStatements = [];
  
  for (let i = 0; i < validItems.length; i++) {
    const item = validItems[i];
    const insertRes = insertResults[i];
    const selectRes = selectResults[i].results[0];

    if (selectRes) {
      const isNew = insertRes.meta.changes > 0;
      const sourceOnly = SOURCE_ONLY_CSPS.has(item.csp);
      if (isNew) {
        totalNew++;
        if (!sourceOnly) {
          jobs.push({ articleId: selectRes.id, lang: 'ko', reason: 'new' });
          jobs.push({ articleId: selectRes.id, lang: 'en', reason: 'new' });
          jobs.push({ articleId: selectRes.id, lang: 'ja', reason: 'new' });
        }
      }
      if (!sourceOnly) {
        localizedInsertStatements.push(
          env.DB.prepare(
            'INSERT OR IGNORE INTO localized_content (article_id, csp, lang, url, pub_date, title, summary, status) VALUES (?,?,?,?,?,?,?,?)'
          ).bind(selectRes.id, item.csp, 'en', item.url || '', item.pub_date, item.title, item.description || '', '')
        );
      }
    }
  }

  if (localizedInsertStatements.length > 0) {
    await env.DB.batch(localizedInsertStatements);
  }

  const queued = await enqueueTranslationJobs(env, jobs);
  if (jobs.length > 0 && queued === 0) {
    console.error(`Failed to enqueue ${jobs.length} translation jobs`);
  }
  return { newArticles: totalNew, queued };
}

function safeParseJSON(text) {
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(clean.slice(start, end)); } catch { return null; }
}

function calculateRetryDelay(attempts, baseDelay = RETRY_BASE_DELAY_SECONDS, maxDelay = 300) {
  return Math.min(baseDelay * Math.max(1, attempts), maxDelay);
}

function parseAIResponse(aiResp) {
  if (!aiResp) return null;
  const msg = aiResp?.choices?.[0]?.message || {};
  const candidates = [msg.content, msg.reasoning, msg.reasoning_content, aiResp.response];
  for (const raw of candidates) {
    if (!raw) continue;
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
      const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      const parsed = safeParseJSON(cleaned);
      if (parsed) return parsed;
    }
  }
  if (typeof aiResp === 'string') {
    return safeParseJSON(aiResp.replace(/<think>[\s\S]*?<\/think>/g, '').trim());
  }
  return null;
}

function normalizeShortList(value, maxItems = 3) {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return items
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function mapRegionDisplayName(value, csp, lang) {
  const text = String(value || '').trim();
  if (!text) return '';
  const langMap = REGION_DISPLAY_MAP[lang] || {};
  const vendorMap = langMap[csp] || {};
  return vendorMap[text] || text;
}

function normalizeRegionsField(value, csp, lang) {
  const items = normalizeShortList(value, 10).map(item => mapRegionDisplayName(item, csp, lang));
  const joined = items.join(', ').trim();
  const lower = joined.toLowerCase();

  const isKo = lang === 'ko';
  const isJa = lang === 'ja';

  if (!joined || lower === 'all' || lower === 'global' || joined === '모든 리전' || joined === 'すべてのリージョン') {
    if (csp === 'aws') return isKo ? '모든 AWS 리전' : isJa ? 'すべてのAWSリージョン' : 'All AWS Regions';
    if (csp === 'azure') return isKo ? '모든 Azure 퍼블릭 리전' : isJa ? 'すべてのAzureパブリックリージョン' : 'All public Azure regions';
    return isKo ? '모든 리전' : isJa ? 'すべてのリージョン' : 'All regions';
  }

  if (/all aws regions|where .*aws/i.test(joined)) {
    return isKo ? '모든 AWS 리전' : isJa ? 'すべてのAWSリージョン' : 'All AWS Regions';
  }
  if (/all public azure regions|all azure regions/i.test(joined)) {
    return isKo ? '모든 Azure 퍼블릭 리전' : isJa ? 'すべてのAzureパブリックリージョン' : 'All public Azure regions';
  }
  if (/all regions/i.test(joined)) {
    if (csp === 'aws') return isKo ? '모든 AWS 리전' : isJa ? 'すべてのAWSリージョン' : 'All AWS Regions';
    if (csp === 'azure') return isKo ? '모든 Azure 퍼블릭 리전' : isJa ? 'すべてのAzureパブリックリージョン' : 'All public Azure regions';
    return isKo ? '모든 리전' : isJa ? 'すべてのリージョン' : 'All regions';
  }

  return joined
    .replace(/\bAPNZ\b/g, csp === 'aws'
      ? (isKo ? '아시아 태평양(뉴질랜드) 리전' : isJa ? 'アジア太平洋 (ニュージーランド) リージョン' : 'Asia Pacific (New Zealand)')
      : (isKo ? '뉴질랜드 리전' : isJa ? 'ニュージーランド リージョン' : 'New Zealand North'))
    .replace(/\s{2,}/g, ' ')
    .trim();
}


// Extract product names, versions, regions, dates from source text
function extractEntities(title, description) {
  const source = `${title} ${description}`;
  const entities = { products: [], versions: [], regions: [], dates: [] };

  // Product names: capitalized multi-word patterns (Amazon X, AWS X, Azure X, Google X, Cloud X)
  const productPatterns = source.match(/(?:Amazon|AWS|Azure|Google|Cloud|Microsoft)[\s]+[A-Z][A-Za-z0-9\s\-\.]+(?=[,\.\s]|$)/g) || [];
  entities.products = [...new Set(productPatterns.map(p => p.trim()))].slice(0, 5);

  // Also grab standalone product names from title
  const titleProducts = title.match(/[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)+/g) || [];
  for (const tp of titleProducts) {
    if (!entities.products.some(p => p.includes(tp))) entities.products.push(tp);
  }
  entities.products = entities.products.slice(0, 5);

  // Versions: X.Y or X.Y.Z patterns
  entities.versions = [...new Set((source.match(/\b\d+\.\d+(?:\.\d+)?\b/g) || []))].slice(0, 5);

  // Region names: "Asia Pacific (X)", "US East (X)", etc.
  entities.regions = [...new Set((source.match(/(?:Asia Pacific|US (?:East|West)|Europe|Canada|South America|Middle East|Africa|ap-|us-|eu-|ca-|sa-|me-|af-)[\w\s\(\)\-]*/g) || []).map(r => r.trim()))].slice(0, 5);

  // Dates
  entities.dates = [...new Set((source.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/g) || []))].slice(0, 3);

  return entities;
}

function buildVendorPromptHints(row) {
  const lines = [
    'REGION WRITING RULES:',
    '- Never invent abbreviations such as APNZ, USE1, EUW, or similar shorthand.',
    '- Keep actual region codes like us-east-1 or ap-northeast-2 unchanged only when the source explicitly uses region codes.',
    '- For marketing region names, use natural Korean display labels in titles and summaries.',
    '- In the regions field, use one clear convention: a vendor-wide all-region label or an exact comma-separated region list.',
  ];
  for (const hint of (VENDOR_REGION_GUIDE[row.csp] || [])) {
    lines.push(`- ${hint}`);
  }
  const examples = VENDOR_REGION_EXAMPLES[row.csp] || [];
  if (examples.length) {
    lines.push('REGION STYLE EXAMPLES:');
    for (const example of examples) {
      lines.push(`- ${example}`);
    }
  }
  const source = `${row.title_en || ''} ${(row.description_en || '').slice(0, 800)}`;
  const matched = Object.entries(REGION_DISPLAY_MAP[row.csp] || {})
    .filter(([name]) => source.includes(name))
    .slice(0, 6);
  if (matched.length) {
    lines.push('REGION DISPLAY HINTS:');
    for (const [name, ko] of matched) {
      lines.push(`- ${name} => ${ko}`);
    }
  }
  // Entity pinning
  const entities = extractEntities(row.title_en, (row.description_en || '').slice(0, 800));
  if (entities.products.length) {
    lines.push('MUST KEEP ENTITIES (reproduce exactly, never abbreviate or translate):');
    for (const p of entities.products) lines.push(`- Product: ${p}`);
    for (const v of entities.versions) lines.push(`- Version: ${v}`);
    for (const r of entities.regions) lines.push(`- Region: ${r}`);
    for (const d of entities.dates) lines.push(`- Date: ${d}`);
  }
  return lines.join('\n');
}

function hangulTokens(text) {
  return [...new Set(String(text || '').match(/[가-힣]{2,}/g) || [])];
}

function koreanTitleLooksHallucinated(title, summary) {
  const generic = /^(정보|코드|기능|지원|사용|관련|업데이트|서비스|설정|구성|출시|제공|가능|관리|카드)$/;
  const titleTokens = hangulTokens(title).filter((token) => !generic.test(token));
  const summaryTokens = hangulTokens(summary);
  if (titleTokens.length < 2 || summaryTokens.length < 2) return false;
  return !titleTokens.some((token) =>
    summaryTokens.some((other) => other.includes(token) || token.includes(other))
  );
}

function splitKoreanSentences(text) {
  return String(text || '')
    .replace(/(\d)\.(\d)/g, '$1·$2')
    .split(/(?<=[.!?。])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function contentTokens(text) {
  return new Set(
    String(text || '')
      .replace(/(\d)\.(\d)/g, '$1·$2')
      .split(/[^가-힣A-Za-z0-9·]+/)
      .map((t) => t.replace(/(을|를|이|가|은|는|과|와|의|에|에서|으로|로|도|만|에게|부터|까지)$/, ''))
      .filter((t) => t.length >= 2),
  );
}

// Second sentence that only re-says the first sentence, the title, or the target audience.
function koreanSecondSentenceIsRedundant(summary, title, target) {
  const sentences = splitKoreanSentences(summary);
  if (sentences.length < 2) return false;
  const second = contentTokens(sentences[1]);
  if (second.size < 3) return false;
  const overlapRatio = (reference) => {
    const ref = contentTokens(reference);
    let hit = 0;
    for (const t of second) if (ref.has(t)) hit++;
    return hit / second.size;
  };
  // Calibrated on live v2 output: padded second sentences scored 0.64–0.67 against the first
  // sentence, sentences carrying new detail scored ≤ 0.45.
  return overlapRatio(sentences[0]) >= 0.6
    || overlapRatio(target) >= 0.7
    || overlapRatio(`${title} ${target}`) >= 0.8;
}

// Coined mixed-case acronyms (TLaD for "Trusted Launch as Default") that never appear in the English source.
// All-caps tokens are deliberately not checked here — too many legitimate ones (MFA, GiB, CU) come from paraphrase.
const ACRONYM_ALLOWLIST = new Set(['IPv4', 'IPv6', 'GiB', 'MiB', 'KiB', 'TiB', 'gRPC', 'vCPU', 'vTPM', 'vGPU', 'IoT', 'IaaS', 'PaaS', 'SaaS', 'FaaS', 'DaaS', 'GenAI', 'MoE', 'IaC', 'macOS', 'iOS', 'DevOps', 'MLOps', 'AIOps', 'GitOps', 'OpenAI', 'oneAPI', 'NVMe', 'eBPF', 'CCaaS', 'UCaaS', 'ScaNN', 'MacOS', 'ESXi', 'MySQL', 'NoSQL', 'MsSQL', 'TiDB']);
function findInventedAcronyms(text, source) {
  const src = String(source || '');
  const seen = new Set();
  const out = [];
  for (const m of String(text || '').matchAll(/\b[A-Za-z]{3,5}\b/g)) {
    const token = m[0];
    if (seen.has(token)) continue;
    seen.add(token);
    if (!/[A-Z][a-z]+[A-Z]/.test(token)) continue;   // lowercase sandwiched between capitals: TLaD, ApNz — not ALLCAPS, not vLLM/OAuth
    if (ACRONYM_ALLOWLIST.has(token)) continue;
    if (src.toLowerCase().includes(token.toLowerCase())) continue;
    out.push(token);
  }
  return out;
}

function summaryFirstSentenceRepeatsTitle(summary, title) {
  const first = splitKoreanSentences(summary)[0] || '';
  const norm = (t) => String(t || '').replace(/[^가-힣A-Za-z0-9]/g, '').toLowerCase();
  const a = norm(title), b = norm(first);
  if (a.length < 10 || b.length < 10) return false;
  if (b.startsWith(a) && b.length - a.length < 12) return true;   // title + a verb ending
  const bigrams = (t) => { const set = new Set(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); return set; };
  const ta = bigrams(a), tb = bigrams(b);
  let inter = 0; for (const g of ta) if (tb.has(g)) inter++;
  return inter / new Set([...ta, ...tb]).size >= 0.8;
}

function countSentences(text, lang = 'ko') {
  // Korean: split only on sentence punctuation followed by whitespace, the same rule the two-sentence
  // trim uses — otherwise "Node.js", "Z.ai", "v1.36.0-gke.2800" count as extra sentences and a card
  // that was just trimmed to two sentences still fails summary-sentence-count.
  if (lang === 'ko') return splitKoreanSentences(text).length;
  return String(text || '')
    .replace(/(\d)\.(\d)/g, '$1·$2')
    .replace(/\.{2,}/g, '…')
    .split(/[.!?。]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function hasUnbalancedBrackets(text) {
  const pairs = [['(', ')'], ['[', ']']];
  return pairs.some(([open, close]) => {
    const opens = (text.match(new RegExp(`\\${open}`, 'g')) || []).length;
    const closes = (text.match(new RegExp(`\\${close}`, 'g')) || []).length;
    return opens !== closes;
  });
}

function hasMarkdownArtifacts(text) {
  return /_[A-Za-z0-9-]+_|\*\*|`/.test(String(text || ''));
}

function hasDanglingTitleFragment(title) {
  const value = String(title || '').trim();
  return /(?:\s|\/|-)[A-Za-z]$/.test(value)
    || /[(:\-\/]$/.test(value)
    || hasUnbalancedBrackets(value);
}


// Deterministic post-processing: fix common LLM issues without another AI call
function applyDeterministicFixes(record, row, lang) {
  let { title, summary, target, features, regions, status } = record;
  const entities = extractEntities(row.title_en, (row.description_en || '').slice(0, 800));
  const profile = LANG_PROFILES[lang] || LANG_PROFILES.ko;

  // Fix 1: Strip markdown artifacts
  const stripMd = (s) => s.replace(/[*#`_~]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  title = stripMd(title);
  summary = stripMd(summary);

  // Fix 1a: Known product-name misreads ("Amazon Connect customers" → invented "Amazon Connect Customer")
  const fixProducts = (s) => s.replace(/Amazon Connect Customer(?!\s*Profiles)\b/g, 'Amazon Connect');
  title = fixProducts(title);
  summary = fixProducts(summary);
  target = fixProducts(target);

  // Fix 1b: Strip status tags from title
  title = title.replace(/\s*\[?\b(?:Public Preview|Generally Available|Retirement|In preview|Launched|GA|Preview)\b\]?\s*[:：]?\s*/gi, ' ').replace(/\s+/g, ' ').trim();

  // Fix 1c: Strip CJK characters (Chinese/Japanese) from title and summary — ONLY if not ja!
  if (lang !== 'ja') {
    const stripCJK = (s) => s.replace(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, '').replace(/\s+/g, ' ').trim();
    title = stripCJK(title);
    summary = stripCJK(summary);
  }

  // Fix 2: Entity preservation check — if product name truncated, use original
  for (const product of entities.products) {
    const words = product.split(/\s+/);
    if (words.length >= 2) {
      const partial = words.slice(0, -1).join(' ');
      if (title.includes(partial) && !title.includes(product)) {
        title = title.replace(partial, product);
      }
    }
  }

  // Fix 3: Summary repeats title — drop a first sentence that is a near-verbatim copy of the title.
  // (The previous ASCII-only bigram comparison ignored every Hangul character, so any Korean sentence
  //  opening with the product name matched and was stripped, which then tripped title-hallucinated.)
  if (summaryFirstSentenceRepeatsTitle(summary, title)) {
    const sentences = splitKoreanSentences(summary);
    const rest = sentences.slice(1).join(' ').trim();
    if (rest.length > 20) summary = rest;
  }

  // Fix 3b (ko): the model still emits 3+ sentences on some cards even with the 1–2 sentence rule; the
  // extra sentences were instructions/filler on every v1 sample, so keep the first two instead of failing.
  if (lang === 'ko') {
    const sentences = splitKoreanSentences(summary);
    if (sentences.length > 2) summary = sentences.slice(0, 2).join(' ');
  }

  // Fix 4: Features — strip product-name-only items (only for non-English translations)
  if (lang !== 'en') {
    const featList = features.split(',').map(f => f.trim()).filter(f => {
      return f.length > 5 && !/^[A-Z][A-Za-z0-9\s\.\-]+$/.test(f);
    });
    if (featList.length >= 2) features = featList.slice(0, 3).join(', ');
  }

  // Fix 5: Status validation and corrections
  let parsedStatus = [];
  try {
    parsedStatus = JSON.parse(status);
  } catch {
    parsedStatus = Array.isArray(status) ? status : [status || ''];
  }
  if (!Array.isArray(parsedStatus)) {
    parsedStatus = [String(parsedStatus)];
  }

  const ALLOWED_STATUSES = profile.statuses;
  let validatedStatus = [];
  for (const s of parsedStatus) {
    const str = String(s).trim();
    if (ALLOWED_STATUSES.includes(str)) {
      validatedStatus.push(str);
    } else {
      const lower = str.toLowerCase();
      if (lower.includes('지원 종료') || lower.includes('종료') || lower.includes('퇴역') || lower.includes('retire') || lower.includes('deprecate') || lower.includes('retirement') || lower.includes('サポート終了') || lower.includes('終了')) {
        validatedStatus.push(profile.statusMap.retire);
      } else if (lower.includes('미리보기') || lower.includes('preview') || lower.includes('プレビュー')) {
        validatedStatus.push(profile.statusMap.preview);
      } else if (lower.includes('베타') || lower.includes('beta') || lower.includes('ベータ')) {
        validatedStatus.push(profile.statusMap.beta);
      } else if (lower.includes('정식 출시') || lower.includes('ga') || lower.includes('launch') || lower.includes('released') || lower.includes('一般提供') || lower.includes('提供開始')) {
        validatedStatus.push(profile.statusMap.ga);
      }
    }
  }
  parsedStatus = [...new Set(validatedStatus)];

  const descLower = String(row.description_en || '').toLowerCase();
  const titleLower = String(row.title_en || '').toLowerCase();

  // Strip beta if there is no beta keyword
  const betaKeyword = profile.statusMap.beta;
  if (parsedStatus.includes(betaKeyword)) {
    const hasBetaEvidence = descLower.includes('beta') || descLower.includes('베타') || descLower.includes('ベータ') || titleLower.includes('beta') || titleLower.includes('베타') || titleLower.includes('ベータ');
    if (!hasBetaEvidence) {
      parsedStatus = parsedStatus.filter(s => s !== betaKeyword);
    }
  }

  // Strip preview if there is no preview keyword
  const previewKeyword = profile.statusMap.preview;
  if (parsedStatus.includes(previewKeyword)) {
    const hasPreviewEvidence = descLower.includes('preview') || descLower.includes('미리보기') || descLower.includes('プレビュー') || titleLower.includes('preview') || titleLower.includes('미리보기') || titleLower.includes('プレビュー');
    if (!hasPreviewEvidence) {
      parsedStatus = parsedStatus.filter(s => s !== previewKeyword);
    }
  }

  // If status list is empty, default to GA
  if (parsedStatus.length === 0) {
    parsedStatus = [profile.statuses[0]];
  }
  status = JSON.stringify(parsedStatus);

  return { title, summary, target, features, regions, status };
}

function assessTranslationQuality(record, row, lang) {
  const reasons = [];
  const title = String(record.title || '').trim();
  const summary = String(record.summary || '').trim();
  const target = String(record.target || '').trim();
  const features = normalizeShortList(record.features);
  const profile = LANG_PROFILES[lang] || LANG_PROFILES.ko;

  if (!title || !summary) reasons.push('missing-core-fields');
  
  // Flag CJK characters only if target language is NOT Japanese
  if (lang !== 'ja' && /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(title + summary)) {
    reasons.push('cjk-contamination');
  }
  
  if (hasDanglingTitleFragment(title)) reasons.push('title-truncated');
  if (title.length > 80) reasons.push('title-too-long');
  if (hasMarkdownArtifacts(title) || hasMarkdownArtifacts(summary)) reasons.push('markdown-artifact');
  
  // Flag untranslated titles only if target language is NOT English
  if (lang !== 'en' && title === row.title_en) {
    reasons.push('title-not-translated');
  }
  
  if (summary.length < 30) reasons.push('summary-too-short');
  const sentenceCount = countSentences(summary, lang);
  if (lang === 'ko' ? (sentenceCount < 1 || sentenceCount > 2) : sentenceCount !== 2) reasons.push('summary-sentence-count');
  // A summary whose first sentence opens with the product name is normal Korean; only flag a near-verbatim copy of the title.
  if (summaryFirstSentenceRepeatsTitle(summary, title)) reasons.push('summary-repeats-title');
  if (!target || target === 'all') reasons.push('target-too-generic');
  if (features.length < 2) reasons.push('features-too-thin');

  if (lang === 'ko') {
    if (/^(이는|또한|이제|이 기능|이 변경|이러한|이 업데이트|이 새로운)/.test(summary)) {
      reasons.push('summary-omits-subject');
    }
    if (/\b(delivers|announces|now supports|is now available)\b/i.test(title) || (title && !/[가-힣]/.test(title))) {
      reasons.push('title-not-translated');
    }
    if (/(Engine|Platform|Integration|Service|Function|Cluster)를/.test(title + target + summary)
        || /Bedrock와/.test(title + target + summary)) {
      reasons.push('awkward-particle');
    }
    if (koreanTitleLooksHallucinated(title, summary)) {
      reasons.push('title-hallucinated');
    }
    if (/(?:합니다|됩니다|습니다|[다요])\.?$/.test(title) || /\.$/.test(title)) {
      reasons.push('title-is-sentence');
    }
    if (title.length > 55) reasons.push('title-too-long');
    if (koreanSecondSentenceIsRedundant(summary, title, target)) reasons.push('summary-redundant');
    if (/(?:^|\.\s+)(?:또한|이는|이를 통해)\s/.test(summary.replace(/^[^.]*\.\s+/, '. '))) reasons.push('summary-filler-connector');
    if (/(?:하세요|하십시오|바랍니다|해 보세요|해보세요)[.!]?(?:\s|$)/.test(summary)) reasons.push('summary-imperative');
    if (/[A-Za-z]{3,}(?:하거나|하여|합니다|되며|됩니다|했습니다|되었습니다|하는 |되는 )/.test(summary)) reasons.push('english-stem-korean-ending');
    // Untranslated English phrases (three or more lowercase words in a row) and Hangul glued to ALLCAPS fragments (비스파ARSITY).
    if (/\b[a-z]{2,}(?:-[a-z]+)? [a-z]{2,} [a-z]{2,}\b/.test(summary) || /[가-힣][A-Z]{3,}/.test(`${title} ${summary}`)) {
      reasons.push('untranslated-phrase');
    }
    const invented = findInventedAcronyms(`${title} ${summary}`, `${row.title_en || ''} ${row.description_en || ''}`);
    if (invented.length) reasons.push('invented-acronym');
  }

  // Status validation: beta/preview must have evidence in description
  const statusStr = JSON.stringify(record.status || '').toLowerCase();
  const descLower = String(row.description_en || '').toLowerCase();
  const betaKeyword = profile.statusMap.beta.toLowerCase();
  const previewKeyword = profile.statusMap.preview.toLowerCase();

  if (statusStr.includes(betaKeyword) && !descLower.includes('beta') && !descLower.includes('베타') && !descLower.includes('ベータ')) {
    reasons.push('status-beta-no-evidence');
  }
  if (statusStr.includes(previewKeyword) && !descLower.includes('preview') && !descLower.includes('미리보기') && !descLower.includes('プレビュー') && !row.title_en.toLowerCase().includes('preview')) {
    reasons.push('status-preview-no-evidence');
  }

  return {
    pass: reasons.length === 0,
    reasons,
  };
}

function applyQualitySuggestions(record, review) {
  const next = { ...record };
  const suggestedTitle = String(review?.suggested_title || '').trim();
  const suggestedSummary = String(review?.suggested_summary || '').trim();

  if (suggestedTitle) {
    next.title = suggestedTitle
      .replace(/\s*[\[\(](?:Launched|Preview|Retired|In development|Generally Available|정식 출시|미리보기|베타|지원 종료|GA|출시|一般提供|プレビュー|ベータ|サポート終了)[\]\)]\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (suggestedSummary) {
    next.summary = suggestedSummary.replace(/\s+/g, ' ').trim();
  }

  return next;
}

async function reviewTranslationQualityWithAI(env, row, record, lang, hint = '') {
  const reviewInput = JSON.stringify({
    original_title: row.title_en,
    original_description: String(row.description_en || '').slice(0, 1500),
    region_guidance: buildVendorPromptHints(row),
    translated: { title: record.title, summary: record.summary, target: record.target, features: record.features, regions: record.regions, status: record.status },
  });
  
  const profile = LANG_PROFILES[lang] || LANG_PROFILES.ko;
  const sysRules = getTranslationPrompt(lang).rules;
  const koreanFluencyChecks = lang === 'ko' ? `
Korean fluency — fix these if present, using the English original as the source of truth:
- Summary starts with 이는/또한/이제/이 기능/이 변경 and omits the actual change
- Title still contains English verbs such as delivers, announces, now supports, or is truncated mid-word
- Wrong particles after English names: Compute Engine를, Application Integration를, Amazon Bedrock와
- Telegraphic noun strings missing 조사/어미, or calques like 연속 배달 instead of 지속적 배포
- A second summary sentence that only restates the first sentence, the title, or the target audience — delete it or replace it with a concrete detail from the source
- Reader instructions (참조하세요, 사용하세요), English stems with Korean endings (contributed하거나), or invented acronyms (TLaD)
- Include "summary" in the output JSON when you rewrite it
` : '';
  
  const reviewPrompt = `You review ${profile.name} cloud news cards. Compare the translated/summarized fields against the original English and check these rules:

${sysRules}
${koreanFluencyChecks}

Find and fix these specific problems:
1. ${lang === 'ja' ? 'Garbled characters' : 'Chinese characters (漢字), Japanese kana, or any non-target language characters'}
2. Hallucinated content not in the original English
3. Garbled, truncated, or unnaturally translated text
4. Status field contradicting the description context
5. Title that is too vague, incomplete, or mirrors the English too closely
${lang === 'ko' ? '6. Awkward Korean that a Korean engineer would have to reconstruct' : ''}

OUTPUT JSON with corrected fields only. Omit fields that are correct.
{"title":"...","summary":"...","status":[...],"regions":"...","target":"...","features":"..."}
If you cannot find any real errors after thorough review, output: {"pass":true}`;

  const reviewPromptWithHint = hint ? `${reviewPrompt}\n\n=== 추가 지시 ===\n${hint}` : reviewPrompt;
  try {
    const aiResp = await runAIWithFallback(env, getReviewModel(env), {
      messages: [{ role: 'system', content: reviewPromptWithHint }, { role: 'user', content: reviewInput }],
      max_tokens: lang === 'ko' ? 640 : 384, temperature: 0.1,
    });
    const parsed = parseAIResponse(aiResp);
    if (!parsed || parsed.pass === true) return { pass: true, reasons: [], record };
    const fixed = { ...record };
    if (parsed.title) fixed.title = parsed.title.replace(/\s*[\[\(](?:Launched|Preview|Retired|GA|정식 출시|미리보기|베타|지원 종료|一般提供|プレビュー|ベータ|サポート終了)[\]\)]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    if (parsed.summary) fixed.summary = String(parsed.summary).replace(/\s+/g, ' ').trim();
    if (parsed.status) {
      let s = parsed.status;
      if (typeof s === 'string') try { s = JSON.parse(s); } catch {}
      fixed.status = JSON.stringify(Array.isArray(s) ? s : [s]);
    }
    if (parsed.regions) fixed.regions = typeof parsed.regions === 'string' ? parsed.regions : normalizeRegionsField(parsed.regions, row.csp, lang);
    if (parsed.target) fixed.target = parsed.target;
    if (parsed.features) fixed.features = normalizeShortList(parsed.features).join(', ');
    return { pass: true, reasons: ['reviewer-applied-edit'], record: fixed };
  } catch (e) {
    console.error('review error:', e.message);
    return { pass: true, reasons: ['review-error'], record };
  }
}

async function ensureTranslationJobStateTable(env) {
  if (translationJobStateReady) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS translation_job_state (
      article_id INTEGER NOT NULL,
      lang TEXT NOT NULL,
      reason TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (article_id, lang)
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_translation_job_state_updated_at
    ON translation_job_state(updated_at)
  `).run();
  translationJobStateReady = true;
}

async function claimTranslationJobs(env, jobs) {
  await ensureTranslationJobStateTable(env);
  if (jobs.length === 0) return [];
  const statements = jobs.map((job) =>
    env.DB.prepare(`
      INSERT OR IGNORE INTO translation_job_state (article_id, lang, reason, updated_at)
      SELECT ?, ?, ?, datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM localized_content WHERE article_id = ? AND lang = ?
      )
    `).bind(job.articleId, job.lang, job.reason || 'backlog', job.articleId, job.lang)
  );
  const results = await env.DB.batch(statements);
  const claimed = [];
  for (let i = 0; i < jobs.length; i++) {
    if (results[i].meta.changes > 0) {
      claimed.push(jobs[i]);
    }
  }
  return claimed;
}

async function releaseTranslationJobs(env, jobs) {
  await ensureTranslationJobStateTable(env);
  if (jobs.length === 0) return;
  const statements = jobs.map((job) =>
    env.DB.prepare(`
      DELETE FROM translation_job_state
      WHERE article_id = ? AND lang = ?
    `).bind(job.articleId, job.lang)
  );
  await env.DB.batch(statements);
}

async function touchTranslationJob(env, articleId, lang, reason) {
  await ensureTranslationJobStateTable(env);
  await env.DB.prepare(`
    INSERT INTO translation_job_state (article_id, lang, reason, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(article_id, lang) DO UPDATE SET
      reason = excluded.reason,
      updated_at = datetime('now')
  `).bind(articleId, lang, reason).run();
}

async function enqueueTranslationJobs(env, jobs, options = {}) {
  if (!env.TRANSLATION_QUEUE || !jobs.length) return 0;
  const skipClaim = !!options.skipClaim;
  const candidateJobs = skipClaim ? jobs : await claimTranslationJobs(env, jobs);
  let queued = 0;
  try {
    for (let i = 0; i < candidateJobs.length; i += 100) {
      const chunk = candidateJobs.slice(i, i + 100);
      const batch = chunk.map((job) => ({ body: job }));
      await env.TRANSLATION_QUEUE.sendBatch(batch);
      queued += batch.length;
    }
  } catch (e) {
    if (!skipClaim) {
      await releaseTranslationJobs(env, candidateJobs);
    }
    console.error(`Failed to enqueue translation jobs: ${e.message}`);
    throw e;
  }
  return queued;
}

async function enqueueArticleTranslations(env, articleIds, lang = DEFAULT_QUEUE_LANG, reason = 'backlog') {
  const jobs = articleIds
    .map((articleId) => ({ articleId, lang, reason }))
    .filter((job) => !!job.articleId);
  return enqueueTranslationJobs(env, jobs);
}

async function getArticleForTranslation(env, articleId) {
  return env.DB.prepare(`
    SELECT a.id, a.csp, a.url, a.pub_date, a.title_en, a.description_en
    FROM articles a
    WHERE a.id = ?
  `).bind(articleId).first();
}

async function hasLocalizedContent(env, articleId, lang) {
  const row = await env.DB.prepare(`
    SELECT 1 as found
    FROM localized_content
    WHERE article_id = ? AND lang = ?
    LIMIT 1
  `).bind(articleId, lang).first();
  return !!row?.found;
}

function getTranslationExecutionOptions(env, reason = 'backlog', extras = {}) {
  return {
    model: getTranslationModel(env),
    allowLowQuality: reason === 'quality_retry' && !extras.refresh,
  };
}

// GCP release notes carry section headings ("Feature", "Announcement", "Changed") on their own line;
// left in, they leak into titles as "Cloud Load Balancing Feature For regional ...".
function cleanSourceDescription(row) {
  let desc = String(row.description_en || '');
  if (row.csp === 'gcp') {
    desc = desc
      .replace(/(^|\n)\s*(?:Feature|Features|Announcement|Announcements|Change|Changed|Changes|Fixed|Fix|Fixes|Issue|Issues|Deprecated|Deprecation|Breaking change|Breaking changes|Libraries|Security)\s*:?\s*(?=\n|[A-Z])/g, '$1')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }
  return desc;
}

async function buildTranslationRecord(env, row, lang, hint = '', model = PRIMARY_MODEL) {
  const sourceDescription = cleanSourceDescription(row);
  const titleForLLM = row.title_en.length < 20
    ? `${row.title_en}: ${sourceDescription.slice(0, 100)}`
    : row.title_en;
  const userMsg = `${buildVendorPromptHints(row)}\n\nTitle: ${titleForLLM}\nDescription: ${sourceDescription.slice(0, 1500)}`;
  
  const { sysPrompt, profile } = getTranslationPrompt(lang);
  const sysPromptWithHint = hint ? `${sysPrompt}\n\n=== 용어 사전 ===\n${hint}` : sysPrompt;
  const fewShot = lang === 'en' ? FEW_SHOT_EN : lang === 'ja' ? FEW_SHOT_JA : FEW_SHOT_KO;

  const aiResp = await runAIWithFallback(env, model, {
    messages: [{ role: 'system', content: sysPromptWithHint }, ...fewShot, { role: 'user', content: userMsg }],
    response_format: TRANSLATION_JSON_SCHEMA,
    max_tokens: 4096, temperature: 0.1,
  });
  const parsed = parseAIResponse(aiResp);
  if (!parsed || !parsed.title) return null;
  let cleanTitle = parsed.title
    .replace(/\s*[\[\(](?:Launched|Preview|Retired|In development|Generally Available|정식 출시|미리보기|베타|지원 종료|GA|출시|一般提供|プレビュー|ベータ|サポート終了)[\]\)]\s*/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const feat = normalizeShortList(parsed.features).join(', ');
  const reg = normalizeRegionsField(parsed.regions, row.csp, lang);
  
  const VALID_STATUS = profile.statuses;
  const rawStatus = Array.isArray(parsed.status) ? parsed.status : [parsed.status || ''];
  const cleanStatus = [...new Set(rawStatus.flatMap(s => {
    for (const v of VALID_STATUS) { if (s.includes(v)) return [v]; }
    return [];
  }))];
  const stat = JSON.stringify(cleanStatus.length ? cleanStatus : [VALID_STATUS[0]]);
  const record = {
    title: cleanTitle,
    summary: parsed.summary || '',
    target: parsed.target || 'all',
    features: feat,
    regions: reg,
    status: stat,
  };
  return record;
}

async function validateTranslationRecord(env, row, record, lang, options = {}) {
  const allowLowQuality = !!options.allowLowQuality;
  const fixed = applyDeterministicFixes(record, row, lang);
  const quality = assessTranslationQuality(fixed, row, lang);
  if (!quality.pass && !allowLowQuality) {
    return { ok: false, needsRetry: true, reasons: quality.reasons, quality, record: fixed };
  }
  return { ok: true, quality, record: fixed };
}

async function persistTranslationRecord(env, row, record, lang, modelUsed, { isReview = false } = {}) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await env.DB.prepare(
    'INSERT OR REPLACE INTO localized_content (article_id, csp, lang, url, pub_date, title, summary, target, features, regions, status, model_used, translated_at, reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(row.id, row.csp, lang, row.url, row.pub_date, record.title, record.summary,
         record.target, record.features, record.regions, record.status, modelUsed,
         now, isReview ? now : null).run();
}

async function runReviewPipeline(env, row, lang, hint = '') {
  const existing = await env.DB.prepare(
    'SELECT title, summary, target, features, regions, status FROM localized_content WHERE article_id = ? AND lang = ?'
  ).bind(row.id, lang).first();
  if (!existing) return { ok: false };
  const record = { title: existing.title, summary: existing.summary, target: existing.target, features: existing.features, regions: existing.regions, status: existing.status };
  const reviewed = await reviewTranslationQualityWithAI(env, row, record, lang, hint);
  const finalRecord = reviewed.reasons?.includes('reviewer-applied-edit') ? reviewed.record : record;
  await persistTranslationRecord(env, row, finalRecord, lang, getReviewModel(env), { isReview: true });
  return { ok: true };
}

async function runTranslationPipeline(env, row, lang, reason = 'backlog', hint = '', extras = {}) {
  const options = getTranslationExecutionOptions(env, reason, extras);
  const record = await buildTranslationRecord(env, row, lang, hint, options.model);
  if (!record) {
    return { ok: false, needsRetry: false };
  }
  // Deterministic fixes
  const fixed = applyDeterministicFixes(record, row, lang);
  // AI review with different model — checks title, status, regions
  const reviewed = await reviewTranslationQualityWithAI(env, row, fixed, lang, hint);
  // The reviewer may rewrite title/summary (e.g. back to 3+ sentences), so re-apply the deterministic fixes.
  const finalRecord = applyDeterministicFixes(reviewed.record, row, lang);
  // Final quality gate
  const quality = assessTranslationQuality(finalRecord, row, lang);
  // Soft rules: worth one retry with a hint, but a long title should not leave the card stuck on the old text.
  const SOFT_REASONS = new Set(['title-too-long']);
  const onlySoft = !quality.pass && quality.reasons.every((r) => SOFT_REASONS.has(r));
  if (onlySoft && reason === 'quality_retry') {
    console.log(`quality soft-pass article=${row.id} lang=${lang} reasons=${quality.reasons.join(',')}`);
    quality.pass = true;
  }
  if (!quality.pass && !options.allowLowQuality) {
    console.log(`quality fail article=${row.id} lang=${lang} reason=${reason} reasons=${(quality.reasons || []).join(',')}`);
    return { ok: false, needsRetry: true, reasons: quality.reasons, quality, record: finalRecord };
  }
  await persistTranslationRecord(
    env,
    row,
    finalRecord,
    lang,
    lang === 'ko' ? FLUENT_KOREAN_MODEL_TAG : getReviewModel(env),
    { isReview: true },
  );
  return { ok: true, quality };
}

async function queueArticleRetranslation(env, articleId, lang = DEFAULT_QUEUE_LANG, reason = 'manual', hint = '') {
  const row = await getArticleForTranslation(env, articleId);
  if (!row) return { found: false, queued: 0 };
  await releaseTranslationJobs(env, [{ articleId, lang }]);
  await env.DB.prepare('DELETE FROM localized_content WHERE article_id = ? AND lang = ?').bind(articleId, lang).run();
  const queued = await enqueueTranslationJobs(env, [{ articleId, lang, reason, hint }]);
  return { found: true, queued };
}

async function enqueueMissingTranslations(env, lang = DEFAULT_QUEUE_LANG, limit = 25) {
  const rows = await env.DB.prepare(`
    SELECT a.id
    FROM articles a
    WHERE NOT EXISTS (
      SELECT 1 FROM localized_content lc
      WHERE lc.article_id = a.id AND lc.lang = ?
    )
    ${sourceOnlyCspExclusionSql('a')}
    ORDER BY a.created_at DESC
    LIMIT ?
  `).bind(lang, limit).all();
  const jobs = rows.results.map((row) => ({ articleId: row.id, lang, reason: 'backlog' }));
  return enqueueTranslationJobs(env, jobs);
}

async function getMissingTranslationCount(env, lang = 'ko') {
  const row = await env.DB.prepare(`
    SELECT count(*) as missing
    FROM articles a
    WHERE NOT EXISTS (
      SELECT 1 FROM localized_content lc
      WHERE lc.article_id = a.id AND lc.lang = ?
    )
    ${sourceOnlyCspExclusionSql('a')}
  `).bind(lang).first();
  return row?.missing || 0;
}

async function getFluentRefreshRemaining(env) {
  const row = await env.DB.prepare(`
    SELECT count(*) as count
    FROM localized_content lc
    JOIN articles a ON a.id = lc.article_id
    WHERE ${buildFluentRefreshFilter()}
  `).first();
  return row?.count || 0;
}

async function getFluentRefreshTodayCount(env) {
  const row = await env.DB.prepare(`
    SELECT count(*) as count
    FROM localized_content
    WHERE lang = 'ko' AND model_used = ?
      AND date(translated_at) = date('now')
  `).bind(FLUENT_KOREAN_MODEL_TAG).first();
  return row?.count || 0;
}

// Runtime override for the optional fluent-refresh daily cap. Defaults to
// FLUENT_REFRESH_DAILY_CAP (100) when the var is unset, so behavior is
// unchanged unless an operator lowers it to throttle Neuron spikes. Only
// affects the optional re-polish pass — never new translation or AI review.
function getFluentRefreshDailyCap(env) {
  const raw = parseInt(env?.FLUENT_REFRESH_DAILY_CAP ?? '', 10);
  if (Number.isNaN(raw)) return FLUENT_REFRESH_DAILY_CAP;
  return Math.max(0, Math.min(500, raw));
}

async function getFluentRefreshInFlightCount(env) {
  const row = await env.DB.prepare(`
    SELECT count(*) as count
    FROM translation_job_state
    WHERE lang = 'ko' AND reason IN ('fluent_refresh', 'quality_retry', 'manual')
  `).first();
  return row?.count || 0;
}

async function getFluentRefreshBudget(env, requested) {
  const [today, inflight] = await Promise.all([
    getFluentRefreshTodayCount(env),
    getFluentRefreshInFlightCount(env),
  ]);
  const cap = getFluentRefreshDailyCap(env);
  const remaining = Math.max(0, cap - today - inflight);
  return Math.min(Math.max(0, requested), remaining);
}

async function enqueueFluentKoreanRefresh(env, limit = FLUENT_REFRESH_BATCH_SIZE) {
  const budget = await getFluentRefreshBudget(env, limit);
  if (budget <= 0) {
    console.log(`Fluent Korean refresh skipped: daily cap ${getFluentRefreshDailyCap(env)} reached`);
    return 0;
  }
  const rows = await env.DB.prepare(`
    SELECT lc.article_id
    FROM localized_content lc
    JOIN articles a ON a.id = lc.article_id
    WHERE ${buildFluentRefreshFilter()}
      AND NOT EXISTS (
        SELECT 1 FROM translation_job_state s
        WHERE s.article_id = lc.article_id AND s.lang = 'ko'
      )
    ORDER BY lc.pub_date DESC
    LIMIT ?
  `).bind(budget).all();
  const jobs = rows.results.map((row) => ({
    articleId: row.article_id,
    lang: 'ko',
    reason: 'fluent_refresh',
  }));
  if (jobs.length === 0) return 0;
  await ensureTranslationJobStateTable(env);
  await env.DB.batch(jobs.map((job) =>
    env.DB.prepare(`
      INSERT INTO translation_job_state (article_id, lang, reason, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(article_id, lang) DO UPDATE SET
        reason = excluded.reason,
        updated_at = datetime('now')
    `).bind(job.articleId, job.lang, job.reason)
  ));
  return enqueueTranslationJobs(env, jobs, { skipClaim: true });
}

export { parseRSS };

export default {
  async scheduled(event, env, ctx) {
    await ensureTranslationJobStateTable(env);
    const backlogQueueBatchSize = getEnvInt(env, 'BACKLOG_QUEUE_BATCH_SIZE', 25);
    const minute = new Date().getMinutes();

    // New articles are enqueued for ko/en/ja the moment fetchRSS ingests them
    // (see fetchRSS reason:'new'), and any that slip through are re-queued in
    // the 15-min fetch block below. The previous per-minute backlog scan ran
    // the `articles NOT EXISTS localized_content` full scan 3×/min even when
    // backlog was 0 — ~86% of daily D1 rows_read. Backlog is now only swept on
    // the 15-min fetch tick, keeping rows_read well under the free-tier cap.

    // Every 5 min: queue pending reviews and Korean refreshes
    if (minute % 5 === 0) {
      for (const lang of ['ko', 'en', 'ja']) {
        const pending = await env.DB.prepare('SELECT a.id FROM articles a JOIN localized_content lc ON lc.article_id = a.id WHERE lc.lang = ? AND lc.reviewed_at IS NULL ORDER BY lc.created_at DESC LIMIT 10').bind(lang).all();
        if (pending.results.length > 0) {
          const jobs = pending.results.map(r => ({ articleId: r.id, lang, action: 'review' }));
          await enqueueTranslationJobs(env, jobs, { skipClaim: true });
        }
      }
      const fluentQueued = await enqueueFluentKoreanRefresh(env, FLUENT_REFRESH_BATCH_SIZE);
      if (fluentQueued) console.log(`Fluent Korean refresh queued: ${fluentQueued}`);
    }

    // Every 15 min (:00, :15, :30, :45): fetch RSS + cleanup + stale claim
    if (minute % 15 === 0) {
      // Cards that failed a fluent refresh get another attempt after 24h (rules and models keep improving).
      await env.DB.prepare(`
        DELETE FROM translation_job_state
        WHERE lang = 'ko' AND reason = 'fluent_failed' AND updated_at < datetime('now', '-1 day')
      `).run();
      const n = await fetchRSS(env);
      const webhookUrl = env.ALERT_WEBHOOK_URL;
      const expired = await env.DB.prepare("SELECT id FROM articles WHERE pub_date < datetime('now', '-30 days')").all();
      if (expired.results.length > 0) {
        const ids = expired.results.map(r => r.id).join(',');
        await env.DB.prepare(`DELETE FROM translation_job_state WHERE article_id IN (${ids})`).run();
        await env.DB.prepare(`DELETE FROM localized_content WHERE article_id IN (${ids})`).run();
        await env.DB.prepare(`DELETE FROM articles WHERE id IN (${ids})`).run();
      }
      await env.DB.prepare("DELETE FROM translation_job_state WHERE updated_at < datetime('now', '-10 minutes')").run();
      // Alert on stale/failed jobs in DLQ
      const staleCount = await env.DB.prepare("SELECT count(*) as c FROM translation_job_state WHERE updated_at < datetime('now', '-30 minutes')").first();
      if (staleCount?.c > 0 && webhookUrl) {
        await fetch(webhookUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `⚠️ What's New: ${staleCount.c}건의 번역 작업이 30분 이상 정체 중. DLQ 확인 필요.` }),
        }).catch(() => {});
      }
      
      let backlog = 0;
      for (const lang of ['ko', 'en', 'ja']) {
        const bl = await getMissingTranslationCount(env, lang);
        if (bl > 0) await enqueueMissingTranslations(env, lang, backlogQueueBatchSize);
        backlog += bl;
      }
      
      console.log(`Fetch cron — ${n.newArticles} new articles, ${n.queued} queued immediately, ${backlog} waiting for translation`);
      // Alert on consecutive empty fetches
      if (webhookUrl && n.newArticles === 0) {
        const prev = await env.DB.prepare("SELECT count(*) as c FROM articles WHERE created_at > datetime('now', '-3 hours')").first();
        if (prev && prev.c === 0) {
          const alertMessage = `⚠️ What's New: 3시간 연속 새 기사 없음. RSS 피드 확인 필요.`;
          await fetch(webhookUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildAlertWebhookPayload(webhookUrl, alertMessage)),
          }).catch(() => {});
        }
      }
    }
  },
  async queue(batch, env, ctx) {
    await ensureTranslationJobStateTable(env);
    for (const msg of batch.messages) {
      const articleId = msg.body?.articleId;
      const lang = msg.body?.lang || DEFAULT_QUEUE_LANG;
      const action = msg.body?.action || 'translate';
      const reason = msg.body?.reason || 'backlog';
      const hint = msg.body?.hint || '';

      if (!articleId || !lang) {
        msg.ack();
        continue;
      }

      try {
        const row = await getArticleForTranslation(env, articleId);
        if (!row) { msg.ack(); continue; }

        if (action === 'review') {
          await runReviewPipeline(env, row, lang, hint);
          msg.ack();
          continue;
        }

        await touchTranslationJob(env, articleId, lang, reason);
        const isRefresh = reason === 'fluent_refresh' || !!msg.body?.refresh;
        const canOverwrite = OVERWRITE_TRANSLATION_REASONS.has(reason);
        if (!canOverwrite && await hasLocalizedContent(env, articleId, lang)) {
          await releaseTranslationJobs(env, [{ articleId, lang }]);
          msg.ack();
          continue;
        }

        const result = await runTranslationPipeline(env, row, lang, reason, hint, { refresh: isRefresh });
        if (result?.ok) {
          await releaseTranslationJobs(env, [{ articleId, lang }]);
          msg.ack();
          continue;
        }

        if (result?.needsRetry && reason !== 'quality_retry') {
          const qualityHint = (result.reasons || []).map(r => {
            const isKo = lang === 'ko';
            const isJa = lang === 'ja';
            if (r === 'summary-repeats-title') return isKo ? '요약 첫 문장이 제목과 달라야 함' : isJa ? '要約の最初の文がタイトルと異なる必要があります' : 'Summary first sentence must differ from title';
            if (r === 'title-not-translated') return isKo ? '제목을 한국어로 번역해야 함' : isJa ? 'タイトルを日本語に翻訳する必要があります' : 'Title must be translated';
            if (r === 'title-truncated') return isKo ? '제목이 잘리지 않게 완성해야 함' : isJa ? 'タイトルが途切れないように完成させてください' : 'Title must be completed without truncation';
            if (r === 'markdown-artifact') return isKo ? '마크다운 제거' : isJa ? 'マークダウン削除' : 'Remove markdown formatting';
            if (r === 'summary-sentence-count') return isKo ? '요약은 1~2문장. 새 정보가 없으면 1문장으로 끝낼 것' : isJa ? '要約は正確に2文' : 'Summary must be exactly 2 sentences';
            if (r === 'summary-redundant') return '요약 두 번째 문장이 첫 문장·제목·대상을 반복함. 원문의 새 정보(활성화 방법, 제한, 리전, 버전)가 없으면 두 번째 문장을 삭제하고 1문장으로 쓸 것';
            if (r === 'summary-filler-connector') return '요약에서 또한/이는/이를 통해로 이어 붙인 문장을 없애고 구체적 사실만 쓸 것';
            if (r === 'summary-imperative') return '요약에 참조하세요/사용하세요 같은 독자 지시문을 쓰지 말고 변경 사실만 서술할 것';
            if (r === 'english-stem-korean-ending') return '영어 단어에 한국어 어미를 붙이지 말 것 (contributed하거나 → 기여하거나). 동사는 한국어로 번역할 것';
            if (r === 'untranslated-phrase') return '요약에 영어 구절을 남기지 말 것 (trillion-parameter foundation models → 조 단위 파라미터 기반 모델). 한글과 영어 대문자가 붙은 깨진 단어를 고칠 것';
            if (r === 'invented-acronym') return '원문에 없는 약어를 만들지 말 것 (TLaD 금지). 제품·기능 이름은 원문 그대로 쓸 것';
            if (r === 'title-is-sentence') return '제목은 명사구. 합니다/됩니다/마침표로 끝나는 문장을 제목으로 쓰지 말 것';
            if (r === 'title-too-long') return '제목을 40자 이내로 줄일 것. 제품명 + 핵심 변경만 남길 것';
            if (r === 'target-too-generic') return isKo ? '대상을 구체적으로 작성' : isJa ? '対象を具体的に記述してください' : 'Target must be specific';
            if (r === 'summary-omits-subject') return '요약 첫 문장에 주어와 핵심 변화를 명시하고 이는/또한/이제로 시작하지 말 것';
            if (r === 'awkward-particle') return '영어 제품명 뒤 조사는 발음 받침 기준으로 고를 것 (Engine을, Bedrock과, Integration을)';
            if (r === 'title-hallucinated') return '제목이 영문 원문과 무관한 한국어로 바뀌면 안 됨. 제품명과 핵심 변경을 유지할 것';
            return r;
          }).join('. ');
          await touchTranslationJob(env, articleId, lang, 'quality_retry');
          await enqueueTranslationJobs(env, [{ articleId, lang, reason: 'quality_retry', hint: qualityHint, refresh: isRefresh }], { skipClaim: true });
          msg.ack();
          continue;
        }

        if (isRefresh) {
          await touchTranslationJob(env, articleId, lang, 'fluent_failed');
          msg.ack();
          continue;
        }

        msg.retry({ delaySeconds: calculateRetryDelay(msg.attempts || 0) });
      } catch (e) {
        const emsg = (e && e.message) || String(e);
        // A FOREIGN KEY violation means the parent article was deleted (e.g.
        // by the 30-day cleanup cron) while this translation job was in flight.
        // Retrying can never succeed — the article is gone — so ack and drop
        // the job instead of retrying forever and piling up Workers Issues.
        if (/FOREIGN KEY|SQLITE_CONSTRAINT/i.test(emsg)) {
          console.warn(`queue translate dropped for article ${articleId} [${lang}]: parent article gone (${emsg})`);
          await touchTranslationJob(env, articleId, lang, 'article_deleted').catch(() => {});
          msg.ack();
          continue;
        }
        console.error(`queue translate error for article ${articleId} [${lang}]:`, emsg);
        msg.retry({ delaySeconds: calculateRetryDelay(msg.attempts || 0) });
      }
    }
  },
  async fetch(request, env) {
    await ensureTranslationJobStateTable(env);
    const backlogQueueBatchSize = getEnvInt(env, 'BACKLOG_QUEUE_BATCH_SIZE', 25);
    const url = new URL(request.url);
    const path = url.pathname;
    let authMode = getAuthMode(env);
    const corsOrigin = getCorsOrigin(request, env);
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };
    const headers = { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const isProtectedApi =
      (request.method === 'POST' && (path === '/api/pipeline' || path === '/mcp')) ||
      (request.method === 'GET' && path === '/api/articles');
    // Trusted in-process call from this same Worker's SSR (see src/worker.ts).
    // The unified Worker serves SSR and this API together, so SSR invokes
    // fetch() directly rather than over HTTP (a Worker can't subrequest its own
    // origin — Cloudflare error 1042). The entrypoint strips this header from
    // every inbound external request before routing, so it can't be forged from
    // outside; only the in-process SSR caller sets it. Such calls skip the
    // website-only /api/articles auth gate.
    const isInternalSsrCall = request.headers.get('X-Internal-SSR') === '1';
    const requiresAdminIp = request.method === 'POST' && (path === '/api/pipeline');
    if (path === '/mcp' && request.method === 'POST') {
      // /mcp itself stays reachable without auth (summary/discovery calls).
      // Only format="source" tool calls require a valid "mcp"-type token,
      // checked per-call inside tools/call below against authContext, which
      // is still computed unconditionally here so that check has something
      // to read. 'warn' (not 'off') keeps the [auth] log line either way.
      authMode = 'warn';
    } else if (path === '/api/articles' && request.method === 'GET') {
      authMode = getSiteApiEnforcement(env);
    }

    let authContext = { ok: false, reason: 'not_checked' };
    if (isProtectedApi && !isInternalSsrCall) {
      authContext = authenticateRequest(request, env);
      const requiredType = requiredKeyTypeForPath(path);
      if (authContext.ok && requiredType && authContext.keyType !== requiredType) {
        authContext = { ok: false, reason: 'wrong_key_type' };
      }
      if (authMode === 'warn' || authMode === 'on' || !authContext.ok) {
        logAuthResult(request, path, authContext, authMode);
      }
      if (authMode === 'on' && !authContext.ok) {
        const status = authContext.reason === 'missing_key_ring' ? 503 : 401;
        let message = authContext.reason === 'missing_key_ring'
          ? 'API_KEY_RING is not configured'
          : 'Unauthorized';
        if (path === '/api/articles' && status === 401) {
          const siteHost = new URL(env.SITE_URL || DEFAULT_SITE_URL).host;
          message = `This endpoint serves ${siteHost} only. For programmatic/agent access, use POST /mcp.`;
        }
        return jsonResponse({ error: message }, { status }, headers);
      }
      if (requiresAdminIp && authContext.ok && !isAllowedAdminIp(request, env)) {
        const currentIp = request.headers.get('CF-Connecting-IP') || 'unknown';
        console.warn(`[auth] forbidden_ip path=${path} ip=${currentIp}`);
        return jsonResponse({ error: 'Forbidden IP' }, { status: 403 }, headers);
      }
    }

    if (path === '/api/articles') {
      const csp = url.searchParams.get('csp');
      // Auto-detect language from Accept-Language, default ko
      const accept = request.headers.get('Accept-Language') || '';
      const defaultLang = accept.startsWith('ja') ? 'ja' : accept.startsWith('en') ? 'en' : 'ko';
      const lang = url.searchParams.get('lang') || defaultLang;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);

      // Include untranslated articles as English fallback
      let query, params;
      if (lang === 'en' || !csp) {
        query = `SELECT lc.*, a.title_en as original_title, 0 as is_fallback FROM localized_content lc JOIN articles a ON lc.article_id = a.id WHERE lc.lang = ?`;
        params = [lang];
        if (csp) { query += ' AND lc.csp = ?'; params.push(csp); }
      } else {
        query = `SELECT lc.*, a.title_en as original_title, 0 as is_fallback FROM localized_content lc JOIN articles a ON lc.article_id = a.id WHERE lc.lang = ? AND lc.csp = ?
          UNION ALL
          SELECT lc2.*, a2.title_en as original_title, 1 as is_fallback FROM localized_content lc2 JOIN articles a2 ON lc2.article_id = a2.id WHERE lc2.lang = 'en' AND lc2.csp = ? AND lc2.article_id NOT IN (SELECT article_id FROM localized_content WHERE lang = ? AND csp = ?)`;
        params = [lang, csp, csp, lang, csp];
      }
      query += ' ORDER BY pub_date DESC LIMIT ?';
      params.push(limit);
      const rows = await env.DB.prepare(query).bind(...params).all();
      return jsonResponse({ items: rows.results, count: rows.results.length, lang }, {}, headers);
    }

    if (path === '/api/pipeline' && request.method === 'POST') {
      const action = url.searchParams.get('action') || 'fetch';
      const id = url.searchParams.get('id');
      let hint = url.searchParams.get('hint') || '';
      if (!hint && request.headers.get('content-type')?.includes('application/json')) {
        try { const body = await request.json(); hint = body.hint || ''; } catch {}
      }

      if (action === 'fetch') {
        const n = await fetchRSS(env);
        const backlog = await getMissingTranslationCount(env, 'ko');
        return jsonResponse({ newArticles: n.newArticles, queued: n.queued, backlog }, {}, headers);
      }

      if (action === 'review') {
        // Bulk queue unreviewed articles
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '25'), 100);
        const rows = await env.DB.prepare('SELECT a.id FROM articles a JOIN localized_content lc ON lc.article_id = a.id WHERE lc.lang = ? AND lc.reviewed_at IS NULL ORDER BY a.created_at DESC LIMIT ?').bind('ko', limit).all();
        const jobs = rows.results.map(r => ({ articleId: r.id, lang: 'ko', action: 'review' }));
        const queued = await enqueueTranslationJobs(env, jobs, { skipClaim: true });
        return jsonResponse({ queued, total: rows.results.length }, {}, headers);
      }

      if (action === 'retranslate') {
        if (!id) return jsonResponse({ error: 'id required for retranslate' }, { status: 400 }, headers);
        const mode = url.searchParams.get('mode') || 'translate';
        if (mode === 'review') {
          await enqueueTranslationJobs(env, [{ articleId: Number(id), lang: 'ko', action: 'review', hint }], { skipClaim: true });
          return jsonResponse({ queued: 1, articleId: Number(id), mode: 'review', hint: hint || undefined }, {}, headers);
        }
        const result = await queueArticleRetranslation(env, Number(id), 'ko', 'manual', hint);
        if (!result.found) return jsonResponse({ error: 'article not found' }, { status: 404 }, headers);
        return jsonResponse({ queued: result.queued, articleId: Number(id), mode: 'translate', hint: hint || undefined }, {}, headers);
      }

      if (action === 'translate') {
        // Bulk queue untranslated articles (backlog)
        const queued = await enqueueMissingTranslations(env, 'ko', backlogQueueBatchSize);
        const backlog = await getMissingTranslationCount(env, 'ko');
        return jsonResponse({ queued, backlog }, {}, headers);
      }

      if (action === 'fix-bad') {
        const bad = await env.DB.prepare(`
          SELECT a.id FROM localized_content lc
          JOIN articles a ON lc.article_id = a.id
          WHERE ${buildBadQualityFilter()} LIMIT 25
        `).all();
        const retryIds = bad.results.map(row => row.id);
        if (retryIds.length > 0) {
          const placeholders = retryIds.map(() => '?').join(',');
          await env.DB.prepare(`DELETE FROM localized_content WHERE lang = 'ko' AND article_id IN (${placeholders})`)
            .bind(...retryIds)
            .run();
        }
        const retried = await enqueueArticleTranslations(env, retryIds, 'ko', 'quality_retry');
        return jsonResponse({ found: bad.results.length, retried }, {}, headers);
      }

      if (action === 'release-failed') {
        // Put cards that failed a fluent refresh back into the refresh pool (e.g. after loosening a validator).
        const res = await env.DB.prepare(`
          DELETE FROM translation_job_state
          WHERE lang = 'ko' AND (reason = 'fluent_failed' OR (reason = 'quality_retry' AND updated_at < datetime('now', '-30 minutes')))
        `).run();
        return jsonResponse({ released: res.meta?.changes ?? 0 }, {}, headers);
      }
      if (action === 'refresh-ko') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || String(FLUENT_REFRESH_BATCH_SIZE), 10) || FLUENT_REFRESH_BATCH_SIZE, 50);
        const queued = await enqueueFluentKoreanRefresh(env, limit);
        const [remaining, today] = await Promise.all([
          getFluentRefreshRemaining(env),
          getFluentRefreshTodayCount(env),
        ]);
        return jsonResponse({
          queued,
          remaining,
          today,
          cap: getFluentRefreshDailyCap(env),
          reason: 'fluent_refresh',
        }, {}, headers);
      }

      return jsonResponse({ error: 'invalid action' }, { status: 400 }, headers);
    }

    if (path === '/api/stats') {
      const [byLang, byModel, backlog, queue, reviewed, staleJobs, fluentRemaining, fluentToday] = await Promise.all([
        env.DB.prepare('SELECT csp, lang, count(*) as count FROM localized_content GROUP BY csp, lang').all(),
        env.DB.prepare('SELECT model_used, count(*) as count FROM localized_content WHERE lang = ? GROUP BY model_used ORDER BY count DESC').bind('ko').all(),
        env.DB.prepare(`SELECT count(*) as count FROM articles a WHERE NOT EXISTS (SELECT 1 FROM localized_content lc WHERE lc.article_id = a.id AND lc.lang = ?) ${sourceOnlyCspExclusionSql('a')}`).bind('ko').first(),
        env.DB.prepare('SELECT count(*) as count, reason FROM translation_job_state GROUP BY reason').all(),
        env.DB.prepare('SELECT count(*) as total, sum(CASE WHEN reviewed_at IS NOT NULL THEN 1 ELSE 0 END) as reviewed FROM localized_content WHERE lang = ?').bind('ko').first(),
        env.DB.prepare("SELECT count(*) as count FROM translation_job_state WHERE updated_at < datetime('now', '-10 minutes')").first(),
        env.DB.prepare(`
          SELECT count(*) as count
          FROM localized_content lc
          JOIN articles a ON a.id = lc.article_id
          WHERE ${buildFluentRefreshFilter()}
        `).first(),
        env.DB.prepare(`
          SELECT count(*) as count
          FROM localized_content
          WHERE lang = 'ko' AND model_used = ?
            AND date(translated_at) = date('now')
        `).bind(FLUENT_KOREAN_MODEL_TAG).first(),
      ]);
      return jsonResponse({
        by_lang: byLang.results,
        by_model: byModel.results,
        // Live model IDs actually in effect (var/secret override or built-in
        // default). by_model above is historical (what each stored card was
        // translated with); this is what the NEXT translation will use, and is
        // the baseline scripts/model-eval.mjs compares candidates against.
        models: {
          translation: getTranslationModel(env),
          review: getReviewModel(env),
        },
        backlog: backlog?.count || 0,
        queue: { active: queue.results, stale: staleJobs?.count || 0 },
        review: { total: reviewed?.total || 0, reviewed: reviewed?.reviewed || 0, pending: (reviewed?.total || 0) - (reviewed?.reviewed || 0) },
        fluent_korean: {
          remaining: fluentRemaining?.count || 0,
          today: fluentToday?.count || 0,
          cap: getFluentRefreshDailyCap(env),
          tag: FLUENT_KOREAN_MODEL_TAG,
        },
      }, {}, headers);
    }

    // MCP Server — JSON-RPC 2.0 over HTTP
    if (path === '/mcp' && request.method === 'POST') {
      // format="source" tool calls check authContext.ok themselves (see
      // tools/call below); this just reflects it for telemetry/X-Auth-Status.
      const isAuthenticated = authContext.ok;
      const mcpHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Auth-Status': isAuthenticated ? 'authenticated' : 'anonymous',
      };
      const respond = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: mcpHeaders });
      const error = (id, code, msg) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: msg } }), { headers: mcpHeaders });

      // Parse the JSON-RPC body defensively. A malformed or empty body (common
      // from bots/scanners probing /mcp) used to throw out of this handler as an
      // uncaught exception -> Cloudflare 1101 / HTTP 500, which piled up in
      // Workers Issues. Return the standard JSON-RPC parse error instead.
      let rpc;
      try {
        rpc = await request.json();
      } catch {
        return error(null, -32700, 'Parse error: request body is not valid JSON');
      }
      if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) {
        return error(null, -32600, 'Invalid Request: expected a JSON-RPC object');
      }

      if (rpc.method === 'initialize') {
        return respond(rpc.id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'whats-new-kr', version: '1.0.0' },
          capabilities: { tools: {} },
        });
      }

      if (rpc.method === 'tools/list') {
        return respond(rpc.id, { tools: [
          { name: 'search_releases', description: 'Search cloud release notes by keyword, CSP, or date range. aws/gcp/azure/oci have Korean (ko) and English (en) AI summaries; openai/ibm are vendor-original English only, reachable with format="source".', inputSchema: {
            type: 'object', properties: {
              query: { type: 'string', description: 'Search keyword — matches title and summary' },
              csp: { type: 'string', enum: ['aws', 'gcp', 'azure', 'oci', 'openai', 'ibm'], description: 'Cloud provider filter (lowercase). aws/gcp/azure/oci support ko/en summaries and format="source"; openai/ibm are source-only (format="source", vendor-original English, no translation).' },
              lang: { type: 'string', enum: ['ko', 'en'], description: 'Output language for format="summary": ko (default) or en, when available. Ignored for format="source" (always vendor-original English).' },
              format: { type: 'string', enum: ['summary', 'source'], description: 'summary (default): localized AI summary (aws/gcp/azure/oci). source: vendor-original English text from ingestion (all CSPs incl. openai/ibm); requires Authorization: Bearer <mcp token>.' },
              days: { type: 'number', description: 'Look back N days from now (default 30). Ignored if start_date is set.' },
              start_date: { type: 'string', description: 'Start date (YYYY-MM-DD). Use with end_date for exact range.' },
              end_date: { type: 'string', description: 'End date (YYYY-MM-DD). Used with start_date.' },
              limit: { type: 'number', description: 'Max results (default: 50, or 10/day for date ranges, max 100)' },
            },
          }},
          { name: 'get_release', description: 'Get a specific release note by article ID. format="source" returns vendor-original English for any CSP (incl. openai/ibm); format="summary" returns a localized AI summary (aws/gcp/azure/oci).', inputSchema: {
            type: 'object', properties: {
              id: { type: 'number', description: 'Article ID' },
              lang: { type: 'string', description: 'Language for format="summary" (default "ko"). Ignored for format="source".' },
              format: { type: 'string', enum: ['summary', 'source'], description: 'summary (default): localized AI summary (aws/gcp/azure/oci). source: vendor-original English text (all CSPs incl. openai/ibm); requires Authorization: Bearer <mcp token>.' },
            }, required: ['id'],
          }},
          { name: 'get_stats', description: 'Get current translation/review pipeline status.', inputSchema: { type: 'object', properties: {} }},
        ]});
      }

      if (rpc.method === 'tools/call') {
        const { name, arguments: args } = rpc.params || {};

        if (name === 'search_releases') {
          const format = args?.format === 'source' ? 'source' : 'summary';
          if (format === 'source' && !authContext.ok) {
            return error(rpc.id, -32001, 'format="source" requires Authorization: Bearer <token>.');
          }
          const csp = args?.csp ? args.csp.toLowerCase() : null;
          const lang = args?.lang || 'ko';
          const query = args?.query || '';

          const dateCol = format === 'source' ? 'a.pub_date' : 'lc.pub_date';
          // Date range: start_date/end_date > days > default 30 days
          let dateFilter, dateParams;
          if (args?.start_date) {
            const startISO = args.start_date + 'T00:00:00.000Z';
            dateFilter = `${dateCol} >= ?`;
            dateParams = [startISO];
            if (args?.end_date) {
              const endISO = args.end_date + 'T23:59:59.999Z';
              dateFilter += ` AND ${dateCol} <= ?`;
              dateParams.push(endISO);
            }
          } else {
            const days = args?.days || 30;
            dateFilter = `${dateCol} > datetime('now', ?)`;
            dateParams = [`-${days} days`];
          }

          // Limit: per-day cap when date range given, otherwise default 50
          let limit;
          if (args?.limit) {
            limit = Math.min(args.limit, 100);
          } else if (args?.start_date && args?.end_date) {
            const d0 = new Date(args.start_date), d1 = new Date(args.end_date);
            const days = Math.max(1, Math.ceil((d1 - d0) / 86400000));
            limit = Math.min(days * 10, 100);
          } else {
            limit = 50;
          }

          let sql, params = [], tbl, searchCol;
          if (format === 'source') {
            // Vendor-original English text straight from ingestion (articles
            // table) — independent of the translation pipeline/backlog, so
            // freshly-ingested articles show up immediately. Auth checked above.
            sql = `SELECT a.id as article_id, a.csp, a.title_en as title, a.description_en as description, a.url, a.pub_date FROM articles a WHERE ${dateFilter}`;
            params = [...dateParams];
            tbl = 'a';
            searchCol = { title: 'a.title_en', text: 'a.description_en' };
          } else if (lang === 'en') {
            // Real English summaries only (lc.translated_at set by the AI
            // pipeline). The raw seed row inserted at ingestion time (see
            // fetchRSS) has translated_at NULL and doesn't count as a summary
            // — use format="source" for the vendor-original text instead.
            sql = `SELECT lc.article_id, lc.csp, lc.title, lc.summary, a.title_en as original_title, a.url, lc.pub_date FROM localized_content lc JOIN articles a ON lc.article_id = a.id WHERE lc.lang = 'en' AND lc.translated_at IS NOT NULL AND ${dateFilter}`;
            params = [...dateParams];
            tbl = 'lc';
            searchCol = { title: 'lc.title', text: 'lc.summary' };
          } else if (lang === 'ko') {
            // Korean — direct, no JOIN needed
            sql = `SELECT lc.article_id, lc.csp, lc.title, lc.summary, a.title_en as original_title, a.url, lc.pub_date FROM localized_content lc JOIN articles a ON lc.article_id = a.id WHERE lc.lang = 'ko' AND ${dateFilter}`;
            params = [...dateParams];
            tbl = 'lc';
            searchCol = { title: 'lc.title', text: 'lc.summary' };
          } else {
            // ja, zh... — requested lang with ko fallback + original title/URL
            sql = `SELECT ko.article_id, ko.csp, COALESCE(t.title, ko.title) as title, COALESCE(t.summary, ko.summary) as summary, a.title_en as original_title, a.url, ko.pub_date FROM localized_content ko JOIN articles a ON ko.article_id = a.id LEFT JOIN localized_content t ON ko.article_id = t.article_id AND t.lang = ? WHERE ko.lang = 'ko' AND ${dateFilter.replace(/lc\./g, 'ko.')}`;
            params = [lang, ...dateParams];
            tbl = 'ko';
            searchCol = { title: 'COALESCE(t.title, ko.title)', text: 'COALESCE(t.summary, ko.summary)' };
          }
          if (csp) { sql += ` AND ${tbl}.csp = ?`; params.push(csp); }
          if (query) { sql += ` AND (${searchCol.title} LIKE ? OR ${searchCol.text} LIKE ?)`; params.push(`%${query}%`, `%${query}%`); }
          sql += ` ORDER BY ${tbl}.pub_date DESC LIMIT ?`;
          params.push(limit);
          try {
            // Count total matches
            const countSql = sql.replace(/SELECT .+? FROM/, 'SELECT count(*) as total FROM').replace(/ ORDER BY .+/, '');
            const countParams = params.slice(0, -1); // exclude limit
            const countRow = await env.DB.prepare(countSql).bind(...countParams).first();
            const total = countRow?.total || 0;

            const rows = await env.DB.prepare(sql).bind(...params).all();
            const result = rows.results;

            let text = JSON.stringify(result, null, 2);
            if (total > limit) {
              text += `\n\n--- ${total}건 중 ${limit}건 반환. 더 보려면 csp, 날짜 범위를 좁히거나 limit을 늘려서 재검색하세요. ---`;
            }
            return respond(rpc.id, { content: [{ type: 'text', text }] });
          } catch (dbErr) {
            console.error('search_releases failed:', dbErr?.message || dbErr, { sql, params });
            return respond(rpc.id, { content: [{ type: 'text', text: JSON.stringify({ error: 'Database query failed' }) }] });
          }
        }

        if (name === 'get_release') {
          const format = args?.format === 'source' ? 'source' : 'summary';
          if (format === 'source' && !authContext.ok) {
            return error(rpc.id, -32001, 'format="source" requires Authorization: Bearer <token>.');
          }

          if (format === 'source') {
            // Vendor-original English text straight from ingestion — independent
            // of translation status, so it works even before Korean review runs.
            const row = await env.DB.prepare(
              'SELECT id as article_id, csp, title_en as title, description_en as description, url, pub_date FROM articles WHERE id = ?'
            ).bind(args.id).first();
            return respond(rpc.id, { content: [{ type: 'text', text: row ? JSON.stringify(row, null, 2) : 'Not found' }] });
          }

          const lang = args?.lang || 'ko';
          // format=summary only ever returns real digests: for lang='en' this
          // requires translated_at (the raw ingestion-time seed row doesn't
          // count — see fetchRSS / search_releases lang='en' for the same guard).
          const extraGuard = lang === 'en' ? ' AND lc.translated_at IS NOT NULL' : '';
          const row = await env.DB.prepare(
            `SELECT lc.article_id, lc.csp, lc.lang, lc.title, lc.summary, lc.target, lc.features, lc.regions, lc.status, lc.reviewed_at, a.title_en as original_title, a.url, lc.pub_date
             FROM localized_content lc JOIN articles a ON lc.article_id = a.id
             WHERE lc.article_id = ? AND lc.lang = ?${extraGuard}`
          ).bind(args.id, lang).first();
          const text = row ? JSON.stringify(row, null, 2) : `Not found (no "${lang}" summary yet for article ${args.id}).`;
          return respond(rpc.id, { content: [{ type: 'text', text }] });
        }

        if (name === 'get_stats') {
          const [backlog, reviewed, queue] = await Promise.all([
            env.DB.prepare(`SELECT count(*) as c FROM articles a WHERE NOT EXISTS (SELECT 1 FROM localized_content lc WHERE lc.article_id = a.id AND lc.lang = ?) ${sourceOnlyCspExclusionSql('a')}`).bind('ko').first(),
            env.DB.prepare('SELECT count(*) as total, sum(CASE WHEN reviewed_at IS NOT NULL THEN 1 ELSE 0 END) as reviewed FROM localized_content WHERE lang = ?').bind('ko').first(),
            env.DB.prepare('SELECT count(*) as c, reason FROM translation_job_state GROUP BY reason').all(),
          ]);
          return respond(rpc.id, { content: [{ type: 'text', text: JSON.stringify({ backlog: backlog?.c, total: reviewed?.total, reviewed: reviewed?.reviewed, queue: queue.results }) }] });
        }

        return error(rpc.id, -32601, `Unknown tool: ${name}`);
      }

      if (rpc.method === 'notifications/initialized') return new Response('', { status: 204 });
      return error(rpc.id, -32601, `Unknown method: ${rpc.method}`);
    }

    return jsonResponse({ error: 'Not found' }, { status: 404 }, headers);
  },
};
