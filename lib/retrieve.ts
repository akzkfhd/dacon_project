/**
 * retrieve.ts — 문서 청크 검색 (BM25, 인메모리)
 *
 * ■ LLM 미개입. 순수 함수. 외부 서비스 호출 0.
 *
 * ■ 왜 벡터DB가 아닌 BM25인가
 *   청크가 374개다. 이 규모에서 임베딩·벡터DB는 검색 품질 이득보다
 *   인프라 추가 비용이 크다. 배포스택 문서의 판단을 따른다:
 *   "MVP에서 인프라가 하나 늘 때마다 완주 확률이 떨어진다."
 *   임베딩은 런타임 외부 API 호출을 뜻하기도 해서 "외부 런타임 의존 0"과도 충돌한다.
 *
 * ■ 왜 형태소 분석기를 쓰지 않는가
 *   한국어는 교착어다. "수익률", "수익률은", "수익률이"가 공백 토큰만으로는
 *   서로 매칭되지 않는다. 정석은 형태소 분석기(mecab·konlpy)지만 JVM이나
 *   C 빌드 체인을 요구해 Vercel 배포를 복잡하게 만든다.
 *   → 한글 구간에 대해 '어절 전체 + 문자 bigram'을 함께 색인한다.
 *     "수익률은" → [수익률은, 수익, 익률, 률은]
 *     "수익률"   → [수익률,   수익, 익률]
 *     bigram이 겹치므로 조사 변형을 흡수한다. 형태소 분석기보다 거칠지만
 *     이 규모에서는 충분하고, 의존성이 0이다.
 *
 * ■ 근거 게이트 (M4의 "근거 없으면 답변 거부"를 코드로 구현)
 *   BM25 점수는 정규화되어 있지 않아 절대 임계값을 걸 수 없다.
 *   질의별 이론적 최대 점수로 나눠 0~1 상대값으로 만든 뒤 임계값을 건다.
 *   이 판정은 LLM이 아니라 코드가 한다 — 프롬프트에 맡기면 모델이 어길 수 있다.
 */
import { chunks, type Chunk } from "./data.ts";

const K1 = 1.5;
const B = 0.75;

/**
 * 이 값 미만이면 "근거를 찾지 못했다"로 간주하고 답변을 거부한다.
 *
 * 실측으로 정한 값이다. 현재 청크(377개) 기준:
 *   디폴트옵션 관련 질문 14종  → 0.069 ~ 0.775
 *   무관한 질문 8종(날씨·요리·영화 등) → 0.000 ~ 0.109
 *
 * 두 무리가 경계에서 겹친다. 겹치는 두 건은 이유가 분명하다:
 *   - "은퇴할 때 얼마나 모이나요"(0.069)는 답이 문서가 아니라 계산 엔진에
 *     있다. 상품설명서에 은퇴 시점 예상액이 있을 리 없으니 낮은 게 정상이다.
 *   - "환율이 얼마인가요"(0.109)는 문서에 '환율변동위험'이 실제로 있어
 *     아주 틀린 매칭도 아니다.
 *
 * 그래서 임계값은 '명백한 무관'만 쳐내는 위치(0.06)에 두고, 경계 구간은
 * 거부 대신 LOW_CONFIDENCE_RELEVANCE로 걸러 답변에 한계를 밝히게 했다.
 * 애매한 질문을 묵살하는 것보다, 답하되 근거가 약하다고 말하는 편이 낫다.
 *
 * 청크를 대폭 늘리면 이 분포가 달라지므로 재측정할 것
 * (tests/retrieve.test.ts가 양쪽을 모두 검사한다).
 */
export const RELEVANCE_THRESHOLD = 0.06;

/**
 * 이 값 미만이면 "문서 근거가 약하다"로 본다. 거부하지는 않되,
 * 답변에 "질문하신 내용이 문서에 직접 나와 있지 않을 수 있습니다"를 붙인다.
 */
export const LOW_CONFIDENCE_RELEVANCE = 0.15;

/** 질문에서 의미를 거의 싣지 않는 어절. bigram 색인에는 영향이 적지만 잡음을 줄인다. */
const STOPWORDS = new Set([
  "그리고", "그러나", "하지만", "제가", "저는", "제", "저", "내", "나",
  "이거", "그거", "저거", "이것", "그것", "무엇", "뭔가요", "인가요",
  "있나요", "없나요", "하나요", "될까요", "때문에", "대해", "대한",
  "관련", "그럼", "그러면", "정도", "얼마나", "어떻게", "어떤", "무슨",
]);

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

export interface RetrievalResult {
  hits: ScoredChunk[];
  /** 0~1. 최고 점수를 질의별 이론적 최대치로 나눈 값. */
  relevance: number;
  /** relevance가 임계값 미만 — 호출부는 답변을 거부해야 한다. */
  belowThreshold: boolean;
}

/**
 * 한국어에 맞춘 토크나이저.
 * 한글 어절은 전체 + 문자 bigram, 영숫자는 그대로 색인한다.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // 한글 / 영숫자(소수점 포함) 구간을 각각 뽑는다
  const runs = text.toLowerCase().match(/[가-힣]+|[a-z0-9]+(?:\.[0-9]+)?/g) ?? [];

  for (const run of runs) {
    if (/^[가-힣]/.test(run)) {
      // 불용어는 어절도 bigram도 색인하지 않는다.
      // bigram만 남기면 "구성상품이 뭔가요"의 '뭔가·가요'가 문서의
      // "옵트인(OPT-IN)은 뭔가요?" 같은 문장과 매칭돼 엉뚱한 근거가 올라온다.
      if (STOPWORDS.has(run)) continue;

      // 한 글자짜리 한글 어절은 색인하지 않는다.
      // 대부분 조사·어미 조각('수', '날', '것')이거나 PDF 줄바꿈으로 단어가
      // 쪼개진 파편이다. 의미는 없는데 문서에 드물게 나타나므로 IDF만
      // 최대로 받아 순위를 뒤집는다.
      //   실측: '날'은 377개 청크 중 1곳("다음날 기준가격")에만 있어,
      //   "원금 손실 날 수 있나요"의 1위를 재투자·과세 문단으로 만들었다.
      //   같은 질문에서 '날'만 빠지면 relevance 0.294 → 0.776으로 오르고
      //   1위도 "원금손실 가능성 있음"으로 바뀐다.
      // 한 글자는 bigram도 만들 수 없으므로 이 어절은 아무것도 남기지 않는다.
      if (run.length < 2) continue;

      tokens.push(run);
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2));
      }
    } else {
      tokens.push(run);
    }
  }
  return tokens;
}

interface Index {
  docs: Array<{ chunk: Chunk; tf: Map<string, number>; length: number }>;
  df: Map<string, number>;
  avgLength: number;
  total: number;
}

function buildIndex(source: Chunk[]): Index {
  const docs = source.map((chunk) => {
    // heading을 함께 색인한다 — 사업자명·포트폴리오명으로 찾을 수 있어야 한다
    const tokens = tokenize(`${chunk.heading}\n${chunk.text}`);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { chunk, tf, length: tokens.length };
  });

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const totalLength = docs.reduce((s, d) => s + d.length, 0);
  return {
    docs,
    df,
    avgLength: docs.length ? totalLength / docs.length : 0,
    total: docs.length,
  };
}

// 모듈 로드 시 1회 구축. 374개 청크 기준 수십 ms.
let cached: Index | null = null;
function getIndex(): Index {
  if (!cached) cached = buildIndex(chunks);
  return cached;
}

function idf(df: number, total: number): number {
  // BM25 표준 IDF. 음수가 나오지 않도록 +1 형태를 쓴다.
  return Math.log(1 + (total - df + 0.5) / (df + 0.5));
}

export interface SearchOptions {
  k?: number;
  /** 이 사업자의 청크에 가산점. 사용자가 가입한 곳의 문서를 우선 보여준다. */
  preferProvider?: string;
}

export function search(query: string, options: SearchOptions = {}): RetrievalResult {
  const { k = 5, preferProvider } = options;
  const index = getIndex();
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0 || index.total === 0) {
    return { hits: [], relevance: 0, belowThreshold: true };
  }

  // 질의 내 중복 제거 — 같은 토큰을 두 번 세면 점수가 부풀려진다
  const uniqueTerms = [...new Set(queryTokens)];

  const scored = index.docs.map((doc) => {
    let score = 0;
    for (const term of uniqueTerms) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      const termIdf = idf(index.df.get(term) ?? 0, index.total);
      const norm = 1 - B + B * (doc.length / (index.avgLength || 1));
      score += termIdf * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }

    // 사업자 일치 가산점.
    // 10%로는 부족했다 — "왜 내 라벨이 저위험인가요"를 물었는데 다른 사업자의
    // 구성내역 청크가 상위를 채우는 일이 실제로 발생했다. 그 청크들이
    // "라벨은 저위험(4등급)입니다" 같은 문장을 그대로 갖고 있어 BM25 점수가
    // 높기 때문이다. 사용자가 가입한 곳의 문서를 확실히 끌어올린다.
    if (preferProvider && doc.chunk.provider === preferProvider) {
      score *= 1.35;
    }
    return { chunk: doc.chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, k).filter((h) => h.score > 0);

  // 이론적 최대: 모든 질의 토큰이 포화 빈도로 평균 길이 문서에 등장한 경우.
  // 이것으로 나누면 질의 길이와 무관한 0~1 상대 점수가 된다.
  //
  // 색인에 아예 없는 토큰(df=0)도 최대 IDF로 분모에 넣는 것이 핵심이다.
  // 넣지 않으면 "오늘 서울 날씨 어때요" 같은 질문에서 '서울' 하나만
  // 주소 문구에 우연히 걸려도 분모가 그 한 항뿐이라 relevance가 치솟는다.
  // 없는 토큰을 분모에 포함시키면 "질의의 대부분이 이 문서군에 존재하지
  // 않는다"는 사실이 점수에 반영된다.
  const maxPossible = uniqueTerms.reduce((s, term) => {
    const df = index.df.get(term) ?? 0;
    return s + idf(df, index.total) * (K1 + 1);
  }, 0);

  const relevance = maxPossible > 0 && hits.length > 0
    ? Math.min(1, hits[0].score / maxPossible)
    : 0;

  return {
    hits,
    relevance: Math.round(relevance * 1000) / 1000,
    belowThreshold: relevance < RELEVANCE_THRESHOLD,
  };
}

/** 인용 표기용 문자열. "문서명 3p" 또는 페이지가 없으면 문서명만. */
export function citationLabel(chunk: Chunk): string {
  return chunk.page ? `${chunk.doc} ${chunk.page}p` : chunk.doc;
}

/**
 * 사용자 본인의 포트폴리오 구성내역 청크를 찾는다.
 *
 * "왜 내 라벨이 저위험인가요" 같은 질문에서 가장 정확한 근거는 검색 순위와
 * 무관하게 사용자 본인의 구성내역이다. BM25에만 맡기면 다른 사업자의 비슷한
 * 문장이 먼저 올라올 수 있어, 이 청크는 별도로 찾아 상단에 고정한다.
 */
export function findOwnPortfolioChunk(
  provider: string,
  portfolioName: string,
): Chunk | null {
  return (
    chunks.find(
      (c) =>
        c.sourceType === "normalized" &&
        c.provider === provider &&
        c.heading.includes(portfolioName),
    ) ?? null
  );
}
