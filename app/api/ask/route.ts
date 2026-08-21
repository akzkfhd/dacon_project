/**
 * app/api/ask/route.ts — M4 근거 기반 Q&A 엔드포인트
 *
 * 기능명세서 §3 M4: 질문 + 진단결과 + 계산결과 + 문서 청크 → 답변 + 인용,
 * 실패 시 답변 거부.
 *
 * 처리 순서 (순서 자체가 설계다)
 *   ① 계산 엔진으로 확정 숫자를 먼저 만든다   ← LLM 미개입
 *   ② BM25로 문서 근거를 찾는다                ← LLM 미개입
 *   ③ 근거가 약하면 여기서 거부한다            ← LLM을 호출조차 하지 않음
 *   ④ 답변 생성 (키 없으면 템플릿 폴백)
 */
import { NextResponse } from "next/server";
import { buildCalcFacts } from "@/lib/calcFacts";
import { findOwnPortfolioChunk, search, type ScoredChunk } from "@/lib/retrieve";
import { generateAnswer, refusalResult } from "@/lib/claude";
import { validateProfile } from "@/lib/profile";

/** 개인정보를 저장하지 않는다. 요청마다 계산하고 버린다. */
export const dynamic = "force-dynamic";

interface AskBody {
  question?: unknown;
  profile?: unknown;
}

export async function POST(request: Request) {
  let body: AskBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "질문이 비어 있습니다." }, { status: 400 });
  }
  if (question.length > 500) {
    return NextResponse.json(
      { error: "질문이 너무 깁니다. 500자 이내로 입력해 주세요." },
      { status: 400 },
    );
  }

  // 클라이언트 폼과 같은 검증 함수를 쓴다. 규칙이 갈라지면
  // 폼은 통과시키는데 API가 거부하는 상태가 생긴다.
  const profile = validateProfile(body.profile);
  if (typeof profile === "string") {
    return NextResponse.json({ error: profile }, { status: 400 });
  }

  // ① 계산 엔진 — 확정 숫자를 먼저 만든다
  const facts = buildCalcFacts(profile);

  // ② 문서 검색
  // minOriginalText: 원문(pdf_text) 자리를 3개 예약한다.
  // 구성내역 정규화본 15개가 짧고 밀도가 높아 상위를 독점하는데, 페이지
  // 좌표는 원문에만 있다. 예약하지 않으면 '공식문서 기반 근거'를 제시할
  // 원문이 후보에서 밀려 documented 등급이 나오지 않는다.
  const { hits, relevance, belowThreshold } = search(question, {
    k: 5,
    minOriginalText: 3,
    preferProvider: profile.provider ?? undefined,
  });

  // ③ 근거 게이트 — 프롬프트가 아니라 코드가 거부를 결정한다
  if (belowThreshold || hits.length === 0) {
    return NextResponse.json(refusalResult(facts, relevance));
  }

  // 사용자 본인의 구성내역을 근거에 포함시킨다.
  // 검색만으로는 다른 사업자의 유사 문장이 먼저 올라올 수 있는데,
  // "내 상품"을 묻는 질문에 남의 상품 문서를 근거로 다는 것은 오해를 부른다.
  //
  // 단, 원문 쿼터를 잠식하지 않도록 정규화본 자리만 밀어낸다.
  // 예전에는 맨 앞에 끼워 넣어 원문 하나를 밀어냈고, 그 결과 모델이
  // 인용할 원문이 줄어 documented 등급이 잘 나오지 않았다.
  let evidence: ScoredChunk[] = hits;
  if (facts.portfolio) {
    const own = findOwnPortfolioChunk(
      facts.portfolio.detail.provider,
      facts.portfolio.detail.name,
    );
    if (own && !hits.some((h) => h.chunk.id === own.id)) {
      const originals = hits.filter((h) => h.chunk.sourceType === "pdf_text");
      const normalized = hits.filter((h) => h.chunk.sourceType !== "pdf_text");
      evidence = [
        ...originals,
        { chunk: own, score: hits[0].score },
        ...normalized,
      ].slice(0, 5);
    }
  }

  // ④ 답변 생성
  const result = await generateAnswer(question, facts, evidence, relevance);
  return NextResponse.json(result);
}
