/**
 * retrieve.test.ts — 검색과 거부 게이트
 *
 * 이 두 가지가 M4의 신뢰성을 좌우한다:
 *   1) 한국어 조사 변형을 넘어 매칭되는가 (형태소 분석기 없이)
 *   2) 근거가 없을 때 확실히 거부하는가
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  search,
  tokenize,
  citationLabel,
  RELEVANCE_THRESHOLD,
  LOW_CONFIDENCE_RELEVANCE,
} from "../lib/retrieve.ts";
import { chunks } from "../lib/data.ts";

test("토크나이저가 어절과 문자 bigram을 함께 낸다", () => {
  const tokens = tokenize("수익률은");
  assert.ok(tokens.includes("수익률은"), "어절 전체");
  assert.ok(tokens.includes("수익"), "bigram");
  assert.ok(tokens.includes("익률"), "bigram");
});

test("한 글자 한글 어절은 색인하지 않는다", () => {
  // '날'·'수'는 조사·어미 조각이라 의미가 없는데, 문서에 드물게 나타나면
  // IDF만 최대로 받아 순위를 뒤집는다. 실제로 "원금 손실 날 수 있나요"의
  // 1위가 '날'(df=1) 때문에 재투자·과세 문단으로 잘못 잡혔었다.
  const tokens = tokenize("이거 원금 손실 날 수 있나요?");
  assert.ok(!tokens.includes("날"), "'날'이 색인되면 안 된다");
  assert.ok(!tokens.includes("수"), "'수'가 색인되면 안 된다");
  assert.ok(tokens.includes("원금") && tokens.includes("손실"), "내용어는 남아야 한다");
});

test("한 글자 토큰 제거가 원금 손실 질문을 바로잡는다 — 회귀 방지", () => {
  const r = search("이거 원금 손실 날 수 있나요?");
  assert.ok(
    r.relevance > 0.5,
    `원금 손실은 문서의 핵심 주제다. relevance=${r.relevance}`,
  );
  // 1위가 원금 손실/보장을 실제로 다루는 청크여야 한다
  assert.match(r.hits[0].chunk.text, /원금|손실|보장/);
});

test("조사가 달라도 bigram이 겹친다 — 교착어 대응", () => {
  const a = new Set(tokenize("수익률"));
  const b = new Set(tokenize("수익률이"));
  const shared = [...a].filter((t) => b.has(t));
  assert.ok(
    shared.includes("수익") && shared.includes("익률"),
    "조사만 다른 두 표현이 bigram을 공유해야 한다",
  );
});

test("영숫자와 소수점 표기를 보존한다", () => {
  const tokens = tokenize("합성총보수 0.784%");
  assert.ok(tokens.includes("0.784"));
});

test("문서에 있는 내용은 근거를 찾는다", () => {
  const r = search("원금 손실이 발생할 수 있나요");
  assert.ok(r.hits.length > 0, "검색 결과가 있어야 한다");
  assert.ok(
    !r.belowThreshold,
    `상품설명서의 핵심 주제인데 거부됨 (relevance=${r.relevance})`,
  );
});

test("구성상품·비중 질문이 근거를 찾는다", () => {
  const r = search("이 포트폴리오는 어떤 상품으로 구성되어 있나요");
  assert.ok(!r.belowThreshold, `relevance=${r.relevance}`);
});

test("문서와 무관한 질문은 거부한다", () => {
  // 디폴트옵션 설명서에 있을 이유가 없는 주제들
  for (const q of [
    "오늘 서울 날씨 어때요",
    "김치찌개 맛있게 끓이는 법 알려줘",
    "아이폰 배터리 교체 비용",
    "주말에 볼만한 영화 추천해줘",
    "오늘 점심 뭐 먹지",
  ]) {
    const r = search(q);
    assert.ok(
      r.belowThreshold,
      `"${q}"는 거부되어야 하는데 통과함 (relevance=${r.relevance})`,
    );
  }
});

test("계산 엔진으로 답할 질문은 문서 근거가 약해도 거부하지 않는다", () => {
  // 은퇴 시점 예상액은 상품설명서에 있을 리 없다. 문서 관련도가 낮은 게
  // 정상이며, 그렇다고 거부하면 답할 수 있는 질문을 묵살하게 된다.
  // 대신 LOW_CONFIDENCE_RELEVANCE 아래이므로 답변에 한계가 표시된다.
  const r = search("은퇴할 때 얼마나 모이나요");
  assert.ok(!r.belowThreshold, `relevance=${r.relevance}`);
  assert.ok(
    r.relevance < LOW_CONFIDENCE_RELEVANCE,
    "문서 근거가 약하다고 표시되어야 한다",
  );
});

test("빈 질의는 거부한다", () => {
  const r = search("   ");
  assert.equal(r.hits.length, 0);
  assert.ok(r.belowThreshold);
});

test("relevance는 0~1 범위이고 임계값과 일관된다", () => {
  const r = search("합성총보수는 얼마인가요");
  assert.ok(r.relevance >= 0 && r.relevance <= 1);
  assert.equal(r.belowThreshold, r.relevance < RELEVANCE_THRESHOLD);
});

test("사업자 가산점이 해당 사업자 문서를 끌어올린다", () => {
  const plain = search("구성상품 비중", { k: 10 });
  const boosted = search("구성상품 비중", { k: 10, preferProvider: "삼성생명" });

  const countSamsung = (hits: typeof plain.hits) =>
    hits.filter((h) => h.chunk.provider === "삼성생명").length;

  assert.ok(
    countSamsung(boosted.hits) >= countSamsung(plain.hits),
    "가산점을 준 사업자의 청크가 줄어들면 안 된다",
  );
});

test("모든 청크가 인용 가능한 출처를 갖는다", () => {
  for (const c of chunks) {
    assert.ok(c.doc && c.doc.length > 0, `청크 ${c.id}에 문서명이 없다`);
    assert.ok(citationLabel(c).length > 0);
    assert.ok(
      c.sourceType === "pdf_text" || c.sourceType === "normalized",
      `청크 ${c.id}의 sourceType이 잘못됨`,
    );
  }
});

test("원문 청크는 페이지 번호를 갖는다 — 인용의 정밀도", () => {
  const pdfChunks = chunks.filter((c) => c.sourceType === "pdf_text");
  assert.ok(pdfChunks.length > 0);
  assert.ok(
    pdfChunks.every((c) => typeof c.page === "number" && c.page > 0),
    "원문 청크에 페이지 번호가 빠졌다",
  );
});

test("원문 쿼터가 정규화본의 상위 독점을 뚫는다", () => {
  // 구성내역 정규화본 15개는 짧고 밀도가 높아 BM25 상위를 독점한다.
  // 쿼터가 없으면 원문이 후보에 거의 못 들어오고, 원문에만 페이지 좌표가
  // 있으므로 '공식문서 기반 근거'를 제시할 수 없게 된다.
  for (const q of [
    "원금 손실이 발생할 수 있나요",
    "합성총보수는 얼마인가요",
    "구성상품이 뭔가요",
  ]) {
    const plain = search(q, { k: 5, preferProvider: "하나은행" });
    const quota = search(q, { k: 5, minOriginalText: 3, preferProvider: "하나은행" });

    const countOriginal = (r: typeof plain) =>
      r.hits.filter((h) => h.chunk.sourceType === "pdf_text").length;

    assert.ok(
      countOriginal(quota) >= 3,
      `"${q}": 원문 ${countOriginal(quota)}개 (쿼터 없으면 ${countOriginal(plain)}개)`,
    );
  }
});

test("쿼터를 걸어도 relevance는 변하지 않는다", () => {
  // 쿼터는 근거 배치일 뿐 질문-문서 적합도를 바꾸지 않는다.
  const q = "원금 손실이 발생할 수 있나요";
  assert.equal(
    search(q, { k: 5 }).relevance,
    search(q, { k: 5, minOriginalText: 3 }).relevance,
  );
});

test("원문이 부족하면 있는 만큼만 넣는다", () => {
  // 미래에셋증권은 스캔 PDF라 원문 청크가 0개다. 없는 데이터를 만들지 않는다.
  const r = search("구성상품이 뭔가요", {
    k: 5,
    minOriginalText: 5,
    preferProvider: "미래에셋증권",
  });
  assert.ok(r.hits.length > 0, "결과 자체는 나와야 한다");
  assert.ok(r.hits.length <= 5);
});
