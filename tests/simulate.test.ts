/**
 * simulate.test.ts — 복리 시뮬레이션 손계산 대조
 * 배포스택 문서가 ★필수로 지정한 검증.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { simulate, compareGrades, formatWon, INFLATION } from "../lib/simulate.ts";
import { assumptions } from "../lib/data.ts";

test("복리 계산이 손계산과 일치한다 — 납입 없음", () => {
  // 초저위험 r=0.0213. 1000만원 × 1.0213^10
  const r = assumptions["초저위험"].annual_return;
  const expected = Math.round(1000 * Math.pow(1 + r, 10));

  const result = simulate(1000, 0, 10, "초저위험");
  assert.equal(result.median, expected);
});

test("복리 계산이 손계산과 일치한다 — 매년 말 납입", () => {
  // balance = balance*(1+r) + C 를 3회. P=1000, C=100, r=중위험
  const r = assumptions["중위험"].annual_return;
  let b = 1000;
  for (let i = 0; i < 3; i++) b = b * (1 + r) + 100;

  const result = simulate(1000, 100, 3, "중위험");
  assert.equal(result.median, Math.round(b));
});

test("밴드는 항상 비관 < 기준 < 낙관 순서다", () => {
  for (const label of Object.keys(assumptions)) {
    const r = simulate(4500, 300, 22, label);
    assert.ok(
      r.pessimistic <= r.median && r.median <= r.optimistic,
      `${label}: 밴드 순서가 어긋남`,
    );
  }
});

test("단일 숫자를 내지 않는다 — 밴드가 항상 함께 나온다", () => {
  const r = simulate(4500, 0, 22, "고위험");
  assert.ok(r.pessimistic > 0);
  assert.ok(r.optimistic > r.pessimistic, "변동성이 있으면 밴드에 폭이 있어야 한다");
});

test("실질가치는 물가만큼 명목보다 작다", () => {
  const r = simulate(4500, 0, 22, "중위험");
  assert.equal(r.realValue, Math.round(r.median / Math.pow(1 + INFLATION, 22)));
  assert.ok(r.realValue < r.median);
});

test("가정값의 출처가 결과에 실려 나온다", () => {
  const r = simulate(1000, 0, 5, "저위험");
  assert.match(r.source, /비교공시/);
  assert.equal(r.asOf, "2026-03-31");
});

test("등급을 올리면 기준 시나리오 금액이 커진다", () => {
  const cmp = compareGrades(4500, 0, 22, "초저위험");
  assert.equal(cmp.gaps["초저위험"], 0, "기준 등급의 격차는 0");
  assert.ok(cmp.gaps["저위험"] > 0);
  assert.ok(cmp.gaps["중위험"] > cmp.gaps["저위험"]);
  assert.ok(cmp.gaps["고위험"] > cmp.gaps["중위험"]);
});

test("은퇴까지 남은 기간이 0 이하면 거부한다", () => {
  assert.throws(() => simulate(1000, 0, 0, "중위험"), /0 이하/);
});

test("알 수 없는 등급은 거부한다", () => {
  assert.throws(() => simulate(1000, 0, 10, "적당위험"), /알 수 없는 위험등급/);
});

test("금액 표기가 한국어 단위를 따른다", () => {
  assert.equal(formatWon(12400), "1억 2,400만");
  assert.equal(formatWon(10000), "1억");
  assert.equal(formatWon(4500), "4,500만");
  assert.equal(formatWon(-3000), "-3,000만");
});
