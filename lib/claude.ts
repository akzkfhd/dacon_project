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

const AnswerSchema = z.object({
  answer: z
    .string()
    .describe("사용자에게 보여줄 답변. 2~4문장. 마크다운 없이 평문."),
  citedChunkIds: z
    .array(z.string())
    .describe("답변의 근거로 실제 사용한 청크의 id 목록"),
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

export interface AskResult {
  answer: string;
  citations: Citation[];
  calcStrip: string[];
  /** 근거를 찾지 못해 답변을 거부했다. */
  refused: boolean;
  /** LLM 없이 템플릿으로 생성했다. UI가 배지로 알린다. */
  degraded: boolean;
  /** 숫자 검증 경고 등. 비어 있어야 정상. */
  warnings: string[];
  relevance: number;
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

/** 청크에서 질문 토큰을 가장 많이 포함한 문장을 고른다. 폴백 답변의 인용문이 된다. */
function bestSentence(chunk: Chunk, question: string): string {
  const qTokens = new Set(
    (question.toLowerCase().match(/[가-힣]{2,}|[a-z0-9]+/g) ?? []).filter(
      (t) => t.length >= 2,
    ),
  );
  const sentences = chunk.text
    .split(/\n|(?<=[.。!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15)
    // 정보가 없는 문장은 인용 후보에서 뺀다.
    // - 물음표로 끝나는 문장: 문서의 FAQ 질문이라 답이 아니다
    // - "…의 구성 내역입니다": 정규화 청크의 제목 줄
    .filter((s) => !s.endsWith("?") && !/구성 내역입니다\.?$/.test(s));

  if (sentences.length === 0) return chunk.text.slice(0, 160);

  let best = sentences[0];
  let bestHits = -1;
  for (const s of sentences) {
    const lower = s.toLowerCase();
    let hits = 0;
    for (const t of qTokens) if (lower.includes(t)) hits++;
    if (hits > bestHits) {
      best = s;
      bestHits = hits;
    }
  }
  return best;
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

  // 의도를 특정했더라도 문서 근거가 약하면 마찬가지로 밝힌다.
  // 예: "은퇴할 때 얼마나 모이나요"는 계산 엔진으로 답할 수 있지만
  // 상품설명서에 근거가 있는 내용이 아니다. 그 차이를 숨기지 않는다.
  if (relevance < LOW_CONFIDENCE_RELEVANCE) {
    unresolvedIntent = true;
  }

  // 의도별 문장이 없거나 부족하면 문서 인용으로 채운다.
  // 인용문에 사업자명을 반드시 붙인다 — 사용자가 가입한 곳이 아닌 문서를
  // "문서에는 이렇게 적혀 있습니다"로 인용하면 자기 상품 얘기로 오해한다.
  const top = hits[0];
  if (top) {
    const whose =
      facts.profile.provider && top.chunk.provider === facts.profile.provider
        ? "가입하신 상품의 문서"
        : `${top.chunk.provider} 문서`;
    parts.push(`${whose}에는 이렇게 적혀 있습니다: "${bestSentence(top.chunk, question)}"`);
  }

  if (parts.length === 0) {
    return refusalResult(facts, relevance);
  }

  if (unresolvedIntent) {
    parts.push(
      "다만 질문하신 내용이 확보한 문서에 직접 나와 있지 않을 수 있습니다. " +
        "위 내용은 가입 상품의 구성 정보이며, 정확한 답은 판매사에 확인하시기 바랍니다.",
    );
  }

  return {
    answer: parts.join(" "),
    citations: hits.slice(0, 3).map((h) => toCitation(h.chunk)),
    calcStrip: calcStripLines(facts),
    refused: false,
    degraded: true,
    warnings: [],
    relevance,
  };
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
    .map(
      (h, i) =>
        `[근거 ${i + 1}] id=${h.chunk.id} · 출처=${citationLabel(h.chunk)} · 사업자=${h.chunk.provider}\n${h.chunk.text}`,
    )
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
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // 이미 확정된 사실을 서술하는 단순 작업이고, 기능명세서가 10초 이내
      // 응답을 요구한다. 깊은 추론이 필요한 작업이 아니다.
      output_config: {
        effort: "low",
        format: zodOutputFormat(AnswerSchema),
      },
      messages: [
        {
          role: "user",
          content: buildUserPrompt(question, facts, hits, relevance),
        },
      ],
    });

    const parsed = response.parsed_output;
    // 스키마 파싱 실패 → 폴백 (기획서 §3 "파싱 실패 시 1회 재시도 후 폴백")
    if (!parsed) return fallback();

    const citedIds = new Set(parsed.citedChunkIds);
    const cited = hits.filter((h) => citedIds.has(h.chunk.id));
    // 모델이 인용 id를 하나도 못 맞히면 검색 상위 결과를 근거로 보여준다.
    // 근거 없는 답변을 내보내지 않기 위한 최소 보장이다.
    const citations = (cited.length > 0 ? cited : hits.slice(0, 2)).map((h) =>
      toCitation(h.chunk),
    );

    return {
      answer: parsed.answer,
      citations,
      calcStrip: calcStripLines(facts),
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
