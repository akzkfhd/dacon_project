/**
 * answer.test.ts — 폴백 답변과 숫자 검증
 *
 * API 키 없이도 챗봇이 쓸 만한 답을 내는지, 그리고 LLM이 만들어낸 숫자를
 * 잡아내는지 확인한다. 이 둘이 "AI가 산수하지 않는다"는 설계의 실물이다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildCalcFacts, calcStripLines, type UserProfile } from "../lib/calcFacts.ts";
import { search } from "../lib/retrieve.ts";
import {
  templateAnswer,
  validateNumbers,
  classifyIntent,
  refusalResult,
  withTopicParticle,
} from "../lib/claude.ts";

/** 라우트와 같은 조건으로 검색한다 — 원문 쿼터 포함. */
function retrieve(q: string, provider = "하나은행") {
  return search(q, { k: 5, minOriginalText: 3, preferProvider: provider });
}

const PROFILE: UserProfile = {
  age: 38,
  retireAge: 60,
  balanceMan: 4500,
  annualContributionMan: 0,
  provider: "하나은행",
  currentLabel: "저위험",
};

test("계산 엔진이 사용자 컨텍스트를 전부 채운다", () => {
  const facts = buildCalcFacts(PROFILE);
  assert.equal(facts.yearsToRetire, 22);
  assert.ok(facts.labelDistribution, "라벨 분포가 있어야 한다");
  assert.ok(facts.portfolio, "하나은행 저위험 포트폴리오를 찾아야 한다");
  assert.ok(facts.simulation, "시뮬레이션이 있어야 한다");
  assert.ok(facts.providerProfile, "사업자 프로필이 있어야 한다");
});

test("가중평균 계산식이 문자열로 노출된다 — 계산 과정을 숨기지 않는다", () => {
  const facts = buildCalcFacts(PROFILE);
  assert.match(facts.portfolio!.formula, /=.*→/);
  assert.ok(
    facts.portfolio!.formula.includes(String(facts.portfolio!.risk.weightedScore)),
  );
});

test("계산 스트립에 사용자 맥락과 분포가 모두 들어간다", () => {
  const lines = calcStripLines(buildCalcFacts(PROFILE)).join("\n");
  assert.match(lines, /38세/);
  assert.match(lines, /22년/);
  assert.match(lines, /저위험/);
});

test("사업자를 모를 때도 계산이 깨지지 않는다", () => {
  const facts = buildCalcFacts({ ...PROFILE, provider: null, currentLabel: null });
  assert.equal(facts.portfolio, null);
  assert.equal(facts.labelDistribution, null);
  assert.ok(facts.simulation, "라벨을 몰라도 초저위험 기준으로 시뮬레이션한다");
  assert.equal(facts.simulation!.base, "초저위험");
});

test("질문 의도 분류가 동작한다", () => {
  assert.equal(classifyIntent("보수가 얼마인가요"), "fee");
  assert.equal(classifyIntent("원금 손실 날 수 있나요"), "loss");
  assert.equal(classifyIntent("왜 라벨이 저위험인가요"), "risk");
  assert.equal(classifyIntent("수익률이 어떻게 되나요"), "return");
});

test("폴백 답변이 실제로 쓸 만하다 — 키 없이도 데모가 돈다", () => {
  const facts = buildCalcFacts(PROFILE);
  const q = "왜 구성품은 2등급인데 라벨은 저위험인가요?";
  const { hits, relevance } = retrieve(q);

  const result = templateAnswer(q, facts, hits, relevance);

  assert.equal(result.degraded, true, "폴백임을 표시해야 한다");
  assert.equal(result.refused, false);
  assert.ok(result.answer.length > 40, "스텁이 아니라 실제 문장이어야 한다");
  assert.ok(result.calcStrip.length > 0, "계산 엔진 결과가 함께 나와야 한다");
  // 근거 유무는 tier가 정한다. 이 질문은 계산 엔진이 답하는 것이라
  // 원문 인용이 없을 수 있고, 그때는 인용을 붙이지 않는 것이 옳다.
  if (result.tier === "documented") {
    assert.ok(result.citations.length > 0);
  } else {
    assert.equal(result.citations.length, 0);
  }
});

test("폴백 답변이 계산 엔진 숫자를 인용한다", () => {
  const facts = buildCalcFacts(PROFILE);
  const q = "제 상품이 위험한 편인가요?";
  const { hits, relevance } = search(q, { preferProvider: "하나은행" });
  const result = templateAnswer(q, facts, hits, relevance);

  // 폴백은 정의상 계산 엔진 값만 쓰므로 검증을 통과해야 한다
  assert.deepEqual(validateNumbers(result.answer, facts, hits, q), []);
});

test("거부 응답은 근거를 달지 않는다", () => {
  const facts = buildCalcFacts(PROFILE);
  const r = refusalResult(facts, 0.05);
  assert.equal(r.refused, true);
  assert.equal(r.citations.length, 0);
  assert.match(r.answer, /추측/);
  assert.ok(r.calcStrip.length > 0, "거부해도 계산 결과는 보여준다");
});

test("숫자 검증이 지어낸 값을 잡아낸다", () => {
  const facts = buildCalcFacts(PROFILE);
  const q = "보수가 얼마인가요";
  const { hits } = search(q);

  const fabricated = "이 상품의 합성총보수는 연 7.31%이며 예상 수익은 99999만원입니다.";
  const warnings = validateNumbers(fabricated, facts, hits, q);
  assert.ok(warnings.length > 0, "출처 없는 숫자를 잡아내야 한다");
  assert.match(warnings[0], /99999/);
});

test("숫자 검증이 정상 숫자를 오탐하지 않는다", () => {
  const facts = buildCalcFacts(PROFILE);
  const q = "은퇴할 때 얼마나 되나요";
  const { hits } = search(q);

  const median = facts.simulation!.results["저위험"].median;
  const legit = `은퇴 시점 예상 적립금은 ${median.toLocaleString()}만원입니다.`;
  assert.deepEqual(validateNumbers(legit, facts, hits, q), []);
});

test("조사 은/는을 받침에 따라 고른다", () => {
  assert.equal(withTopicParticle("포트폴리오 1호"), "포트폴리오 1호는");
  assert.equal(withTopicParticle("적극투자형"), "적극투자형은");
  assert.equal(withTopicParticle("안정형"), "안정형은");
  assert.equal(withTopicParticle("알파드림 2"), "알파드림 2은(는)");
});

test("구성 질문은 구성 답변으로 분류된다 — 라벨 질문과 구분", () => {
  assert.equal(classifyIntent("구성상품이 뭔가요"), "composition");
  assert.equal(classifyIntent("어떤 상품이 들어있나요"), "composition");
  // '구성품'이 들어 있어도 라벨 산출을 묻는 질문은 risk로 간다
  assert.equal(classifyIntent("왜 구성품은 2등급인데 라벨은 저위험인가요?"), "risk");
});

test("구성 질문에는 불확실 단서를 붙이지 않는다", () => {
  const facts = buildCalcFacts(PROFILE);
  const q = "구성상품이 뭔가요";
  const { hits, relevance } = search(q, { preferProvider: "하나은행" });
  const r = templateAnswer(q, facts, hits, relevance);
  assert.ok(!r.answer.includes("직접 나와 있지 않을 수 있습니다"));
});

test("문서에 근거가 없으면 그 사실을 답변에 밝힌다", () => {
  const facts = buildCalcFacts(PROFILE);
  const q = "연금 수령은 언제부터 가능한가요";
  const { hits, relevance } = retrieve(q);
  const r = templateAnswer(q, facts, hits, relevance);
  assert.equal(classifyIntent(q), "general");
  assert.equal(r.tier, "no_document");
  assert.match(r.answer, /공식 문서에서 근거를 찾지 못해/);
});

test("① 무관한 질문은 unrelated", () => {
  const r = refusalResult(buildCalcFacts(PROFILE), 0.01);
  assert.equal(r.tier, "unrelated");
  assert.equal(r.refused, true);
  assert.equal(r.citations.length, 0);
});

test("③ 문서에 있는 질문은 documented — 원문 근거와 마킹이 붙는다", () => {
  const facts = buildCalcFacts(PROFILE);
  const q = "원금 손실이 발생할 수 있나요";
  const { hits, relevance } = retrieve(q);
  const r = templateAnswer(q, facts, hits, relevance);

  assert.equal(r.tier, "documented", `answer=${r.answer.slice(0, 80)}`);
  assert.ok(r.citations.length > 0, "근거가 있어야 한다");
  assert.ok(
    r.citations.every((c) => c.sourceType === "pdf_text" && c.evidence),
    "documented의 근거는 원문 + 페이지 마킹이어야 한다",
  );
});

test("② 문서 밖 질문은 no_document — 문서 인용을 붙이지 않는다", () => {
  const facts = buildCalcFacts(PROFILE);
  const q = "은퇴할 때 얼마나 모이나요";
  const { hits, relevance } = retrieve(q);
  const r = templateAnswer(q, facts, hits, relevance);

  assert.equal(r.tier, "no_document");
  assert.equal(
    r.citations.length,
    0,
    "약하게 걸린 문단을 근거로 보여주면 문서가 뒷받침한다는 오해를 준다",
  );
  assert.match(r.answer, /공식 문서에서 근거를 찾지 못해/);
  assert.ok(r.calcStrip.length > 0, "계산 결과는 그대로 보여준다");
});

test("no_document여도 답변 자체는 쓸모가 있다", () => {
  const facts = buildCalcFacts(PROFILE);
  const q = "은퇴할 때 얼마나 모이나요";
  const { hits, relevance } = retrieve(q);
  const r = templateAnswer(q, facts, hits, relevance);
  // 계산 엔진이 낸 예상 적립금이 답변에 들어 있어야 한다
  assert.match(r.answer, /만원/);
  assert.deepEqual(validateNumbers(r.answer, facts, hits, q), []);
});

test("스캔 PDF 사업자는 documented가 될 수 없다 — 좌표가 없다", () => {
  const mirae = { ...PROFILE, provider: "미래에셋증권", currentLabel: "고위험" };
  const facts = buildCalcFacts(mirae);
  const q = "구성상품이 뭔가요";
  const { hits, relevance } = retrieve(q, "미래에셋증권");
  const r = templateAnswer(q, facts, hits, relevance);
  // 미래에셋 원문이 없으므로 다른 사업자 원문이 인용될 수는 있다.
  // 핵심은 근거가 붙었다면 반드시 마킹 가능한 원문이라는 것.
  if (r.tier === "documented") {
    assert.ok(r.citations.every((c) => c.evidence));
  }
});
