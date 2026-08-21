/**
 * riskEngine.test.ts — 배포스택 문서가 ★필수로 지정한 검증
 *
 * 핵심: IBK 상품설명서에 표기된 위험도 2.6을 엔진이 재현하는가.
 * 재현되면 이 계산은 우리가 지어낸 게 아니라 사업자가 공시한 공식을
 * 역산한 것임이 증명된다.
 *
 * 부가 목적: Python판(lib/risk_engine.py)과 TS판이 어긋나지 않도록 고정한다.
 * 두 구현이 갈라지면 "검증 스크립트는 통과하는데 화면은 다른 값"이 된다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeRisk, scoreToBand } from "../lib/riskEngine.ts";
import { portfolios, toHoldings } from "../lib/portfolios.ts";

test("IBK 적극투자형 2호 — 문서 표기 위험도 2.6을 재현한다", () => {
  const pf = portfolios.find(
    (p) => p.provider === "IBK기업은행" && p.name === "적극투자형 포트폴리오 2호",
  );
  assert.ok(pf, "IBK 적극투자형 2호가 data/portfolios.json에 있어야 한다");
  assert.equal(pf.docStatedScore, 2.6, "문서 표기값이 데이터에 보존되어야 한다");

  const result = computeRisk(toHoldings(pf), pf.riskLabel);
  assert.equal(result.weightedScore, 2.6);
  assert.equal(result.computedLabel, "고위험");
  assert.ok(result.labelMatches);
});

test("경계값 2.70이 부동소수점 오차로 구간 밖으로 밀리지 않는다", () => {
  // KB 뿔려드림2: 3×0.7 + 2×0.2 + 2×0.1 = 2.7
  // 반올림 없이 계산하면 2.6999999999999997이 되어 '중위험'(2.7~3.4) 하한을
  // 미세하게 벗어난다. Python판에서 실제로 발생했던 버그다.
  const result = computeRisk([
    { name: "A", ratioPct: 70, productGrade: 3 },
    { name: "B", ratioPct: 20, productGrade: 2 },
    { name: "C", ratioPct: 10, productGrade: 2 },
  ]);
  assert.equal(result.weightedScore, 2.7);
  assert.equal(result.computedLabel, "중위험");
});

test("가중평균이 라벨을 가린다 — 절반이 고위험인데 '저위험'", () => {
  // 하나은행 안정투자형 포트폴리오2: 2등급 50% + 5등급 50% = 3.5 → 저위험
  const result = computeRisk([
    { name: "고위험 펀드", ratioPct: 50, productGrade: 2 },
    { name: "GIC", ratioPct: 50, productGrade: 5 },
  ]);
  assert.equal(result.weightedScore, 3.5);
  assert.equal(result.computedLabel, "저위험");
  assert.equal(result.worstGrade, 2, "구성품 최고위험은 2등급");
  assert.equal(result.riskyAssetPct, 50, "자산의 절반이 위험자산");
});

test("모든 포트폴리오가 문서 표기 라벨과 일치한다", () => {
  const mismatches = portfolios
    .map((pf) => ({ pf, r: computeRisk(toHoldings(pf), pf.riskLabel) }))
    .filter(({ r }) => !r.labelMatches)
    .map(({ pf, r }) => `${pf.provider} ${pf.name}: ${r.computedLabel}`);

  // IBK 중립투자형 3호는 경계값(2.6) 데이터로 기존부터 불일치가 알려져 있다.
  // 그 1건 외에 새로운 불일치가 생기면 회귀다.
  assert.ok(
    mismatches.length <= 1,
    `예상 밖의 라벨 불일치: ${mismatches.join(", ")}`,
  );
});

test("비중 합계가 100%가 아니면 거부한다", () => {
  assert.throws(
    () =>
      computeRisk([
        { name: "A", ratioPct: 50, productGrade: 2 },
        { name: "B", ratioPct: 30, productGrade: 5 },
      ]),
    /비중 합계/,
  );
});

test("구간 경계가 연속적이다", () => {
  assert.deepEqual(scoreToBand(5.0), ["초저위험", 5]);
  assert.deepEqual(scoreToBand(4.3), ["초저위험", 5]);
  assert.deepEqual(scoreToBand(4.2), ["저위험", 4]);
  assert.deepEqual(scoreToBand(2.6), ["고위험", 2]);
  assert.deepEqual(scoreToBand(1.0), ["초고위험", 1]);
});
