/**
 * claude.ts — M4 답변 생성 (LLM + 폴백)
 *
 * ■ 역순 개발: 폴백 템플릿이 먼저다
 *   기획서 §5의 "LLM 응답 불안정 → 폴백 템플릿을 먼저 완성한 뒤 AI를 붙인다".
 *   ANTHROPIC_API_KEY가 없어도 이 모듈은 완전히 동작한다. 검색 결과와
 *   계산 엔진 값만으로 답변을 조립하기 때문이다. 키가 있으면 같은 재료로
 *   Claude가 더 자연스럽게 서술한다. 반환 구조는 두 경로가 동일해서
 *   UI가 분기하지 않는다.
 *
 * ■ 숫자는 절대 LLM이 만들지 않는다
 *   기획서 §3.4: "챗봇은 금액을 생성하지 않는다. 계산 엔진이 확정한 숫자를
 *   받아 설명만 한다."
 *   1차 방어: 프롬프트에 계산 엔진 값만 쓰라고 명시
 *   2차 방어: 응답에서 숫자를 추출해 계산 엔진·문서에 없는 값이면 경고
 *   폴백 경로는 LLM을 거치지 않으므로 구조적으로 안전하다.
 */
import Anthropic from "@anthropic-ai/sdk";
// SDK의 zodOutputFormat은 zod v4 타입을 요구한다. zod 3.25+가 제공하는
// /v4 서브패스를 쓴다 — 루트 "zod"에서 가져오면 v3 타입이라 빌드가 깨진다.
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  citationLabel,
  tokenize,
  LOW_CONFIDENCE_RELEVANCE,
  type ScoredChunk,
} from "./retrieve.ts";
import { calcStripLines, type CalcFacts } from "./calcFacts.ts";
import type { Chunk, ChunkEvidence } from "./data.ts";

/**
 * 모델 선택: claude-opus-5 (Anthropic 최신 기본값).
 * effort는 "low" — 이 작업은 이미 확정된 사실을 자연스럽게 서술하는 것이고,
 * 기능명세서 §4가 AI 모듈 응답을 10초 이내로 못박고 있다.
 * max_tokens도 2000으로 제한한다. 모바일 화면의 챗봇 답변은 의도적으로 짧다.
 */
const MODEL = "claude-opus-5";
const MAX_TOKENS = 2000;

/**
 * 폴백 경로에서 '이 원문이 질문에 답한다'고 인정할 최소 커버리지.
 *
 * 조사·어미 정규화 후 다시 실측했다(질문 13종, 사업자 6곳 교차):
 *   ② 문서 밖 6종  → 0.250 ~ 0.500
 *   ③ 문서 안 8종  → 0.333 ~ 1.000
 * 두 무리가 0.500 한 점에서만 겹쳐 그 바로 위인 0.6을 잡았다.
 *
 * 0.3이던 이전 값은 정규화 전 토큰 수(질문당 10개 안팎)에 맞춘 것이다.
 * 조사를 떼면서 질문이 내용어 두세 개로 줄어 같은 비율이 훨씬 헐거워졌고,
 * "세금은 얼마나 내나요"에 보수·수수료 문단이, "연금 수령은 언제부터
 * 가능한가요"에 중도해지 과세 문단이 '공식 문서 근거'로 붙었다.
 *
 * 0.6에서 놓치는 것: "환매는 며칠 걸리나요"(0.333 — 답하는 문장에 '며칠'도
 * '걸리'도 글자로는 없다)와 하나은행의 위험 질문(0.500, 다른 5개 사업자는
 * 1.000). 근거가 아닌 것을 근거라고 보여주는 쪽이 더 큰 손해이므로
 * 이 방향의 실패를 택한다.
 *
 * LLM 경로는 모델이 인용한 청크로 등급을 정하므로 이 값을 쓰지 않는다.
 */
const DOCUMENTED_COVERAGE = 0.6;

const AnswerSchema = z.object({
  answer: z
    .string()
    .describe("사용자에게 보여줄 답변. 2~4문장. 마크다운 없이 평문."),
  citedChunkIds: z
    .array(z.string())
    .describe(
      "답변의 근거로 실제 사용한 청크의 id 목록. " +
        "문서에서 질문의 답을 찾지 못했다면 빈 배열로 두세요.",
    ),
});

export interface Citation {
  chunkId: string;
  label: string;
  provider: string;
  sourceType: "pdf_text" | "normalized";
  excerpt: string;
  /** 원문 페이지 이미지 + 하이라이트 좌표. 없으면 화면이 텍스트 인용만 보여준다. */
  evidence?: ChunkEvidence;
}

/**
 * 답변의 근거 등급. 화면 표시와 인용 노출을 이걸로 가른다.
 *
 *   unrelated    이 서비스와 무관한 질문. 답하지 않는다.
 *                → relevance 임계값으로 코드가 판정 (LLM 호출 전)
 *   no_document  관련은 있으나 공식 문서에서 답을 찾지 못했다.
 *                계산 엔진 결과로만 답하고 그 사실을 밝힌다. 문서 인용 없음.
 *   documented   공식 문서 원문에 근거가 있다. 인용 + 원문 마킹을 제공한다.
 *
 * no_document와 documented는 relevance로 나누지 않는다. 실측 결과 두 무리의
 * relevance가 겹치기 때문이다(문서 밖 질문 최대 0.228 > 문서 안 질문 최소 0.118).
 * relevance는 '어휘가 겹치는가'를 재지 '문서가 답을 담고 있는가'를 재지 않는다.
 * 예: '물가'는 문서에 나오지만("수익률이 물가상승률보다 낮을 수 있으며")
 *     "물가 오르면 어떻게 되나요"에 답하지는 않는다.
 * → 대신 '답변이 실제로 원문을 인용했는가'라는 결과로 판정한다. 정의상 정확하다.
 */
export type AnswerTier = "unrelated" | "no_document" | "documented";

export interface AskResult {
  answer: string;
  citations: Citation[];
  calcStrip: string[];
  /** 근거 등급. UI가 인용·마킹 노출 여부를 이걸로 정한다. */
  tier: AnswerTier;
  /** 근거를 찾지 못해 답변을 거부했다. tier === "unrelated"와 같다. */
  refused: boolean;
  /** LLM 없이 템플릿으로 생성했다. UI가 배지로 알린다. */
  degraded: boolean;
  /** 숫자 검증 경고 등. 비어 있어야 정상. */
  warnings: string[];
  relevance: number;
}

/**
 * 근거 문장이 보이는 자리에서 발췌를 시작한다.
 *
 * 앞머리 180자를 그대로 쓰면 정작 근거가 화면 밖으로 밀린다. KB국민은행
 * 청크는 앞부분이 "준법감시인 심의필 제2026-…호" 도장 문구라, 위험 질문의
 * 근거로 뽑혔는데도 발췌에 '위험'이 한 번도 나오지 않았다.
 * 왜 이것이 근거인지 사용자가 발췌만 보고 납득할 수 있어야 한다.
 */
function excerptFrom(chunk: Chunk, sentence?: string): string {
  if (!sentence) return chunk.text;
  const at = chunk.text.indexOf(sentence);
  if (at < 0) return chunk.text; // 공백 정규화된 창(window) 인용이면 못 찾는다
  const from = Math.max(0, at - 20);
  return (from > 0 ? "…" : "") + chunk.text.slice(from);
}

function toCitation(chunk: Chunk, excerptSource?: string): Citation {
  const text = excerptSource ?? chunk.text;
  return {
    chunkId: chunk.id,
    label: citationLabel(chunk),
    provider: chunk.provider,
    sourceType: chunk.sourceType,
    excerpt: text.length > 180 ? `${text.slice(0, 180)}…` : text,
    evidence: chunk.evidence,
  };
}

/**
 * 청크에서 질문에 가장 잘 맞는 문장을 고른다. 폴백 답변의 인용문이 된다.
 *
 * 비교는 tokenize()로 한다. 원시 문자열 포함 검사를 쓰면 조사 하나에 어긋난다 —
 * 질문의 "예금자보호가"가 문서의 "예금자보호법"과 겹치지 않는다고 판정됐다.
 * 색인·검색과 같은 정규화를 써야 판정이 일관된다.
 */
function bestSentence(chunk: Chunk, question: string): string {
  const qTokens = new Set(tokenize(question));

  const sentences = chunk.text
    .split(/\n|(?<=[.。!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15)
    // 정보가 없는 문장은 인용 후보에서 뺀다.
    // - 물음표로 끝나는 문장: 문서의 FAQ 질문이라 답이 아니다
    // - "…의 구성 내역입니다": 정규화 청크의 제목 줄
    .filter((s) => !s.endsWith("?") && !/구성 내역입니다\.?$/.test(s));

  let best = "";
  let bestHits = 0;
  for (const s of sentences) {
    const sTokens = new Set(tokenize(s));
    let hits = 0;
    for (const t of qTokens) if (sTokens.has(t)) hits++;
    if (hits > bestHits) {
      best = s;
      bestHits = hits;
    }
  }
  if (best) return best;

  // 질문 토큰을 담은 문장이 하나도 없다 — 표 형태 청크에서 자주 생긴다.
  // "예금자보호 대상" 같은 행은 8자라 문장 필터에 걸러지는데, 정작 그 행이
  // 답이다. 문장 경계를 포기하고 질문 토큰이 처음 나오는 자리를 중심으로
  // 원문을 잘라 온다. 근거로 제시할 이상 주제와 붙어 있어야 한다.
  const flat = chunk.text.replace(/\s+/g, " ").trim();
  for (const t of [...qTokens].sort((a, b) => b.length - a.length)) {
    const at = flat.indexOf(t);
    if (at < 0) continue;
    const from = Math.max(0, at - 40);
    return flat.slice(from, from + 160).trim();
  }

  return sentences[0] ?? flat.slice(0, 160);
}

/**
 * 조사 은/는 선택. 앞 글자에 받침이 있으면 '은', 없으면 '는'.
 * 한글 음절은 0xAC00부터 28개 종성 단위로 배열되므로 나머지가 0이면 받침이 없다.
 * 하드코딩하면 "포트폴리오 1호은"처럼 어색해진다.
 */
export function withTopicParticle(word: string): string {
  const last = word.trimEnd().slice(-1);
  const code = last.charCodeAt(0);
  const isHangul = code >= 0xac00 && code <= 0xd7a3;
  if (!isHangul) return `${word}은(는)`;
  return `${word}${(code - 0xac00) % 28 === 0 ? "는" : "은"}`;
}

/** 질문 의도를 거칠게 분류한다. 폴백 답변에서 어떤 계산 값을 앞세울지 정하는 용도. */
type Intent =
  | "fee"
  | "return"
  | "loss"
  | "risk"
  | "amount"
  | "composition"
  | "general";

export function classifyIntent(question: string): Intent {
  const q = question.replace(/\s/g, "");
  if (/보수|수수료|비용/.test(q)) return "fee";
  if (/손실|원금|보장|잃/.test(q)) return "loss";
  if (/수익률|얼마나벌|성과/.test(q)) return "return";
  // 위험·등급 판정이 구성 질문보다 먼저다.
  // "왜 구성품은 2등급인데 라벨은 저위험인가요"는 구성이 아니라
  // 라벨 산출 방식을 묻는 질문이다.
  if (/등급|라벨|위험|안전|가중평균/.test(q)) return "risk";
  if (/구성|편입|들어있|무슨상품|어떤상품|포트폴리오/.test(q)) return "composition";
  if (/얼마|금액|적립금|은퇴|시뮬/.test(q)) return "amount";
  return "general";
}

/**
 * 인용 목록에 원문(pdf_text) 근거가 있으면 documented.
 * 정규화본(구성내역)만 있으면 그것도 문서에서 뽑은 사실이지만 원문 페이지를
 * 지목할 수 없으므로 no_document로 둔다 — '공식문서 기반 근거'라고 말하려면
 * 원문의 어느 쪽 어느 줄인지 보여줄 수 있어야 한다.
 */
function tierFromCitations(citations: Citation[]): AnswerTier {
  return citations.some((c) => c.sourceType === "pdf_text" && c.evidence)
    ? "documented"
    : "no_document";
}

export function refusalResult(
  facts: CalcFacts,
  relevance: number,
): AskResult {
  return {
    answer:
      "이 질문에 대한 근거를 확보한 문서에서 찾지 못했습니다. 추측으로 답변하지 않겠습니다. " +
      "상품설명서 원문이나 가입하신 판매사에 직접 확인하시기를 권합니다.",
    citations: [],
    calcStrip: calcStripLines(facts),
    tier: "unrelated",
    refused: true,
    degraded: false,
    warnings: [],
    relevance,
  };
}

/**
 * 폴백 답변 — LLM 없이 계산 엔진 값과 문서 인용만으로 조립한다.
 * 스텁이 아니라 실제로 쓸 수 있는 답변이어야 한다. 키가 없는 상태로도
 * 심사 데모가 돌아가야 하기 때문이다.
 */
export function templateAnswer(
  question: string,
  facts: CalcFacts,
  hits: ScoredChunk[],
  relevance: number,
): AskResult {
  const intent = classifyIntent(question);
  const parts: string[] = [];
  let unresolvedIntent = false;

  const d = facts.labelDistribution;
  const pf = facts.portfolio;

  if (intent === "risk" && pf) {
    parts.push(
      `${pf.detail.provider} ${pf.detail.name}의 라벨은 '${pf.detail.riskLabel}'이지만, ` +
        `구성상품 중 가장 위험한 것은 ${pf.risk.worstGrade}등급이고 위험자산 비중은 ${pf.risk.riskyAssetPct}%입니다.`,
    );
    parts.push(`라벨은 구성상품 등급의 가중평균으로 정해집니다: ${pf.formula}.`);
  } else if (intent === "fee" && d?.feeMultiple != null) {
    parts.push(
      `'${d.label}' 라벨 안에서도 보수는 ${d.minFee}%부터 ${d.maxFee}%까지 ${d.feeMultiple}배 차이가 납니다(중앙값 ${d.medianFee}%).`,
    );
    if (pf?.detail.totalFeePct != null) {
      parts.push(
        `${pf.detail.provider} ${pf.detail.name}의 합성총보수는 연 ${pf.detail.totalFeePct}%입니다.`,
      );
    }
  } else if (intent === "return" && d) {
    parts.push(
      `'${d.label}' 라벨 상품 ${d.count}개의 1년 수익률은 ${d.minReturn}%부터 ${d.maxReturn}%까지 ${d.spreadPp}%p 벌어져 있습니다(중앙값 ${d.medianReturn}%).`,
    );
  } else if (intent === "amount" && facts.simulation) {
    const { base, results, gaps } = facts.simulation;
    parts.push(
      `현재 '${base}' 기준으로 ${facts.yearsToRetire}년 뒤 예상 적립금은 ` +
        `${results[base].median.toLocaleString()}만원입니다(${results[base].pessimistic.toLocaleString()}~${results[base].optimistic.toLocaleString()}만원 범위).`,
    );
    const higher = Object.entries(gaps).find(([l]) => l === "중위험");
    if (higher && higher[1] !== 0) {
      parts.push(
        `같은 조건에서 중위험이면 ${results["중위험"].median.toLocaleString()}만원으로 ` +
          `${higher[1] >= 0 ? "+" : ""}${higher[1].toLocaleString()}만원 차이가 납니다.`,
      );
    }
  } else if (intent === "loss" && pf) {
    const guaranteed = pf.detail.holdings
      .filter((h) => h.kind !== "fund")
      .reduce((s, h) => s + h.ratioPct, 0);
    const subject = withTopicParticle(pf.detail.name);
    parts.push(
      guaranteed === 0
        ? `${subject} 원리금보장상품 없이 전액 실적배당형으로 구성되어 원금 손실이 발생할 수 있습니다.`
        : `${subject} 원리금보장상품이 ${guaranteed}%, 실적배당형이 ${100 - guaranteed}%입니다. 실적배당형 부분은 원금 손실이 가능합니다.`,
    );
  } else if (pf) {
    // composition 의도이거나, 의도를 특정하지 못한 경우.
    // 어느 쪽이든 사용자의 실제 구성은 유효한 맥락이므로 이것으로 연다 —
    // 인용문만 덩그러니 두면 답변이 "문서에는 이렇게 적혀 있습니다"뿐인
    // 껍데기가 된다.
    const holdings = pf.detail.holdings
      .map((h) => `${h.name} ${h.ratioPct}%`)
      .join(", ");
    parts.push(
      `${pf.detail.provider} ${pf.detail.name}은(는) ${holdings}로 구성되며 라벨은 '${pf.detail.riskLabel}', 위험자산 비중은 ${pf.risk.riskyAssetPct}%입니다.`,
    );
    // 의도를 특정하지 못했다면, 검색이 걸렸어도 정작 물어본 것에 대한 답이
    // 문서에 없을 수 있다. 템플릿은 그 불일치를 스스로 판별하지 못하므로
    // (LLM 경로는 프롬프트 규칙 3이 처리한다) 한계를 밝혀 둔다.
    // 반대로 구성을 물었다면 위 문장이 곧 답이므로 단서를 붙이지 않는다.
    unresolvedIntent = intent === "general";
  }

  // 원문(pdf_text) 근거를 인용할 수 있는지가 tier를 가른다.
  // 폴백은 모델처럼 "이 문단이 답을 담고 있나"를 판단할 수 없으므로,
  // 질문의 내용어가 실제로 그 문단에 있는지로 대신 본다.
  //
  // 점수 1위 원문만 보면 안 된다. BM25 점수는 문단 전체의 어휘 밀도라
  // "질문에 답하는 문장을 품고 있는가"와 다르다. 실측: "원금 손실이
  // 발생할 수 있나요"에서 1위 원문은 겹침 1개(실격)였고, 3위 원문이
  // "해지 시 원금손실이 발생할 수 있습니다"로 겹침 2개였다.
  // → 후보 원문을 모두 훑어 가장 잘 맞는 것을 고른다.
  const original = bestOriginalMatch(hits, question);
  const quoted = original
    ? sentenceAnswersQuestion(original.chunk, question)
    : null;

  if (original && quoted) {
    // 인용문에 사업자명을 반드시 붙인다 — 사용자가 가입한 곳이 아닌 문서를
    // "문서에는 이렇게 적혀 있습니다"로 인용하면 자기 상품 얘기로 오해한다.
    const whose =
      facts.profile.provider &&
      original.chunk.provider === facts.profile.provider
        ? "가입하신 상품의 문서"
        : `${original.chunk.provider} 문서`;
    parts.push(`${whose}에는 이렇게 적혀 있습니다: "${quoted}"`);
  }

  if (parts.length === 0) {
    return refusalResult(facts, relevance);
  }

  const tier: AnswerTier = original && quoted ? "documented" : "no_document";

  if (tier === "no_document") {
    parts.push(
      "다만 이 내용은 확보한 공식 문서에서 근거를 찾지 못해 계산 결과로만 답변한 것입니다. " +
        "정확한 답은 판매사에 확인하시기 바랍니다.",
    );
  }

  return {
    answer: parts.join(" "),
    // no_document면 문서 인용을 붙이지 않는다. 약하게 걸린 문단을 '근거'로
    // 제시하면 문서가 그 답을 뒷받침한다는 오해를 준다.
    citations:
      tier === "documented" && original
        ? [toCitation(original.chunk, excerptFrom(original.chunk, quoted ?? undefined))]
        : [],
    calcStrip: calcStripLines(facts),
    tier,
    refused: false,
    degraded: true,
    warnings: [],
    relevance,
  };
}

/**
 * 후보 중 질문과 가장 잘 맞는 원문 청크를 고른다.
 * 마킹 좌표가 있는 원문만 대상이다 — 페이지를 지목할 수 없으면
 * '공식문서 기반 근거'라고 말할 수 없다.
 */
function bestOriginalMatch(
  hits: ScoredChunk[],
  question: string,
): ScoredChunk | null {
  let best: ScoredChunk | null = null;
  let bestCoverage = 0;

  for (const h of hits) {
    if (h.chunk.sourceType !== "pdf_text" || !h.chunk.evidence) continue;
    const coverage = questionCoverage(h.chunk, question);
    if (coverage > bestCoverage) {
      best = h;
      bestCoverage = coverage;
    }
  }
  return best;
}

/**
 * 청크의 대표 문장이 질문을 얼마나 덮는지 0~1로 잰다.
 *
 * 조사가 붙은 원시 어절로 비교하면 양방향으로 틀린다. 실측 사례:
 *   놓침 — "예금자보호가"가 문서의 "예금자보호능"과 글자가 달라 매칭 실패
 *   오탐 — "물가 오르면 어떻게 되나요"가 "손실 추정액은 어떻게 되나요?"와
 *          기능어 둘만으로 겹쳐 통과
 * → BM25에서 이미 쓰는 tokenize()를 그대로 쓴다. 불용어·한 글자를 걸러내고
 *   bigram으로 조사 변형을 흡수하므로 두 문제가 함께 풀린다.
 */
export function questionCoverage(chunk: Chunk, question: string): number {
  const q = new Set(tokenize(question));
  if (q.size === 0) return 0;

  const s = new Set(tokenize(bestSentence(chunk, question)));
  let hit = 0;
  for (const t of q) if (s.has(t)) hit++;

  // 질문 토큰이 하나뿐일 때 비율을 그대로 쓰면 한 번 스친 것만으로 1.0이 된다.
  // "세금은 얼마나 내나요"는 정규화 후 유효 토큰이 '세금' 하나다.
  // 분모에 하한 2를 두어 한 단어 일치가 만점이 되는 것을 막는다.
  return hit / Math.max(q.size, 2);
}

/**
 * 그 청크가 질문에 답하는 문장을 담고 있는지 보고, 있으면 그 문장을 돌려준다.
 *
 * 폴백 경로에는 모델이 없으므로 의미 판단을 할 수 없다. 대신 질문의 내용어가
 * 문장에 실제로 등장하는지를 본다. 한 단어만 스쳐도 통과시키면 "물가 오르면
 * 어떻게 되나요"에 "수익률이 물가상승률보다 낮을 수 있으며"를 근거랍시고
 * 붙이게 되므로, 두 개 이상 겹칠 때만 인정한다.
 */
function sentenceAnswersQuestion(chunk: Chunk, question: string): string | null {
  return questionCoverage(chunk, question) >= DOCUMENTED_COVERAGE
    ? bestSentence(chunk, question)
    : null;
}

/** 문자열에서 숫자만 뽑는다. 천단위 콤마는 제거해 비교 가능한 형태로 만든다. */
function extractNumbers(text: string): string[] {
  return (text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).filter(
    (n) => n.length > 0,
  );
}

/**
 * 2차 방어: 답변 속 숫자가 계산 엔진 출력이나 검색된 문서에 실재하는지 본다.
 * 어디에도 없는 숫자는 LLM이 만들어냈을 가능성이 있으므로 경고로 남긴다.
 */
export function validateNumbers(
  answer: string,
  facts: CalcFacts,
  hits: ScoredChunk[],
  question: string,
): string[] {
  const allowed = new Set<string>();
  const addFrom = (s: string) => extractNumbers(s).forEach((n) => allowed.add(n));

  addFrom(JSON.stringify(facts));
  addFrom(question);
  calcStripLines(facts).forEach(addFrom);
  hits.forEach((h) => {
    addFrom(h.chunk.text);
    addFrom(h.chunk.heading);
  });

  const unknown = extractNumbers(answer).filter((n) => {
    if (allowed.has(n)) return false;
    // 소수점 표기 차이(2.6 vs 2.60) 흡수
    const asNum = Number(n);
    for (const a of allowed) {
      if (Number(a) === asNum) return false;
    }
    return true;
  });

  if (unknown.length === 0) return [];
  return [
    `답변에 계산 엔진·문서에서 확인되지 않는 숫자가 있습니다: ${[...new Set(unknown)].join(", ")}`,
  ];
}

const SYSTEM_PROMPT = `당신은 퇴직연금 디폴트옵션 진단 서비스 '깨움'의 설명 도우미입니다.

[역할]
사용자의 진단 결과와 상품설명서 근거를 바탕으로 질문에 답합니다.

[절대 규칙]
1. 숫자를 새로 만들지 마세요. 금액·비율·수익률·보수는 제공된 '계산 엔진 결과'에
   있는 값만 사용하세요. 직접 계산하지 마세요 — 덧셈, 평균, 환산 모두 금지입니다.
2. 제공된 '문서 근거'에 없는 사실을 지어내지 마세요.
3. 근거가 부족하면 모른다고 말하세요. 추측하지 마세요.
4. 특정 상품이나 사업자를 추천하지 마세요. "옮기세요", "가입하세요" 같은 표현을
   쓰지 마세요. 사실과 사용자의 현재 위치만 전달합니다. 이것은 투자권유 규제
   때문이며 예외가 없습니다.
5. 실제로 근거로 사용한 청크의 id를 citedChunkIds에 담으세요. 사용하지 않은
   청크의 id를 넣지 마세요.
6. 근거로는 [원문] 표시가 붙은 것을 우선 인용하세요. 원문은 상품설명서의
   실제 페이지라 사용자에게 그 위치를 표시해 줄 수 있습니다.
   [구성내역]은 원문에서 뽑아 정리한 요약이라 페이지를 지목할 수 없습니다.
7. 문서가 질문에 답하지 못하면 citedChunkIds를 **빈 배열**로 두고,
   "공식 문서에서 근거를 찾지 못했다"고 밝힌 뒤 계산 엔진 결과로 답할 수
   있는 부분만 답하세요. 억지로 관련 없는 문단을 근거로 끌어오지 마세요.

[문체]
- 2~4문장. 평문. 마크다운 기호를 쓰지 마세요.
- 사용자를 존중하는 존댓말.
- 결론을 먼저, 근거를 뒤에.`;

function buildUserPrompt(
  question: string,
  facts: CalcFacts,
  hits: ScoredChunk[],
  relevance: number,
): string {
  const calcLines = calcStripLines(facts)
    .map((l) => `- ${l}`)
    .join("\n");

  const evidence = hits
    .map((h, idx) => {
      // 원문과 정규화 요약을 구분해 준다. 모델이 어느 쪽을 인용했는지가
      // 곧 답변 등급(documented / no_document)을 가르기 때문이다.
      const kind = h.chunk.sourceType === "pdf_text" ? "원문" : "구성내역";
      const head =
        `[근거 ${idx + 1}] [${kind}] id=${h.chunk.id} · ` +
        `출처=${citationLabel(h.chunk)} · 사업자=${h.chunk.provider}`;
      return `${head}\n${h.chunk.text}`;
    })
    .join("\n\n");

  // 검색 점수가 낮다는 것은 아래 근거가 질문과 잘 맞지 않는다는 뜻이다.
  // 모델이 억지로 연결하지 않도록 그 사실을 알려 준다.
  const weakEvidenceNote =
    relevance < LOW_CONFIDENCE_RELEVANCE
      ? "\n\n[주의] 아래 문서 근거는 질문과의 관련도가 낮게 측정되었습니다. " +
        "근거가 질문에 답하지 못한다면 억지로 연결하지 말고, 문서에서 찾지 " +
        "못했다고 밝힌 뒤 계산 엔진 결과로 답할 수 있는 부분만 답하세요."
      : "";

  return `[사용자 질문]
${question}

[계산 엔진 결과 — 이 숫자들만 사용 가능]
${calcLines}${weakEvidenceNote}

[문서 근거]
${evidence}`;
}

/** 키가 있는지. 없으면 LLM 경로를 시도조차 하지 않는다. */
export function hasApiKey(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
  );
}

export async function generateAnswer(
  question: string,
  facts: CalcFacts,
  hits: ScoredChunk[],
  relevance: number,
): Promise<AskResult> {
  const fallback = () => templateAnswer(question, facts, hits, relevance);

  if (!hasApiKey()) return fallback();

  try {
    const client = new Anthropic();
    const prompt = buildUserPrompt(question, facts, hits, relevance);

    const call = () =>
      client.messages.parse({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        // 이미 확정된 사실을 서술하는 단순 작업이고, 기능명세서가 10초 이내
        // 응답을 요구한다. 깊은 추론이 필요한 작업이 아니다.
        output_config: {
          effort: "low",
          format: zodOutputFormat(AnswerSchema),
        },
        messages: [{ role: "user", content: prompt }],
      });

    let response = await call();
    let parsed = response.parsed_output;

    // 기능명세서 §3: "파싱 실패 시 1회 재시도 후 폴백".
    // 예전에는 재시도도 로그도 없이 조용히 폴백했다. 그러면 화면에는
    // degraded 배지만 뜨고 원인을 알 길이 없다 — 실제로 특정 질문이
    // 이유 없이 요약 모드로 답하는 것을 디버깅하는 데 시간이 걸렸다.
    if (!parsed) {
      console.warn(
        `[M4] 스키마 파싱 실패 (stop_reason=${response.stop_reason}). 1회 재시도합니다. 질문: ${question.slice(0, 40)}`,
      );
      response = await call();
      parsed = response.parsed_output;
    }

    if (!parsed) {
      console.error(
        `[M4] 재시도도 파싱 실패 → 폴백. stop_reason=${response.stop_reason}`,
      );
      return fallback();
    }

    // 모델이 인용한 청크만 근거로 삼는다.
    // 예전에는 인용이 비면 검색 상위를 대신 붙였는데, 그건 모델이
    // "문서에서 못 찾았다"고 말한 것을 무시하고 근거를 지어 붙이는 셈이었다.
    // 빈 인용은 그 자체가 no_document 신호다.
    const citedIds = new Set(parsed.citedChunkIds);
    const citations = hits
      .filter((h) => citedIds.has(h.chunk.id))
      // LLM 경로도 같은 규칙으로 발췌한다 — 모델이 인용한 청크의 어느
      // 대목이 질문과 맞는지 화면에서 바로 보여야 한다.
      .map((h) => toCitation(h.chunk, excerptFrom(h.chunk, bestSentence(h.chunk, question))));

    const tier = tierFromCitations(citations);

    return {
      answer: parsed.answer,
      // no_document면 인용을 노출하지 않는다. 원문 페이지를 지목할 수 없는
      // 근거를 '근거'로 보여주면 문서가 뒷받침한다는 오해를 준다.
      citations: tier === "documented" ? citations : [],
      calcStrip: calcStripLines(facts),
      tier,
      refused: false,
      degraded: false,
      warnings: validateNumbers(parsed.answer, facts, hits, question),
      relevance,
    };
  } catch (error) {
    // 어떤 API 오류든 서비스가 멈추면 안 된다. 폴백은 항상 답을 낸다.
    if (error instanceof Anthropic.APIError) {
      console.error(`Claude API 오류 ${error.status}: ${error.message}`);
    } else {
      console.error("Claude 호출 실패:", error);
    }
    return fallback();
  }
}
