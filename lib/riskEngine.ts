/**
 * riskEngine.ts — 위험등급 가중평균 역산 엔진 (런타임)
 *
 * ■ 이 파일에 LLM은 절대 개입하지 않는다. 순수 함수만 존재한다.
 *   금융 서비스에서 LLM이 산수를 하면 환각이 금액 오류로 직결된다.
 *
 * ■ lib/risk_engine.py의 이식본이다. 두 구현이 조용히 어긋나면
 *   "파이썬으로 검증한 값"과 "화면에 뜨는 값"이 달라진다.
 *   tests/riskEngine.test.ts가 IBK 문서 표기값 2.6 재현을 고정해 이를 막는다.
 *
 * ■ 계산 공식의 출처 (우리가 만든 게 아니다)
 *   IBK기업은행 디폴트옵션 상품설명서 1p:
 *     "포트폴리오 위험도 : 개별상품 디폴트옵션 위험도를 편입비중으로
 *      가중평균하여 산출한 값"
 */

/** 디폴트옵션 위험도 점수 → 라벨 구간. 숫자가 작을수록 위험하다. */
export const RISK_BANDS: ReadonlyArray<
  readonly [number, number, string, number]
> = [
  [4.3, 5.0, "초저위험", 5],
  [3.5, 4.2, "저위험", 4],
  [2.7, 3.4, "중위험", 3],
  [1.9, 2.6, "고위험", 2],
  [1.0, 1.8, "초고위험", 1],
];

/** 금융투자상품 위험등급(1~6) → 디폴트옵션 적용 위험도(1~5). IBK 문서 표. */
export const FUND_GRADE_TO_DO_GRADE: Readonly<Record<number, number>> = {
  1: 1,
  2: 2,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
};

/** 위험자산(실적배당형)으로 간주하는 디폴트옵션 위험도 상한. */
export const RISKY_ASSET_MAX_GRADE = 3;

export interface Holding {
  name: string;
  ratioPct: number;
  productGrade: number;
}

export interface RiskResult {
  weightedScore: number;
  computedLabel: string;
  computedGrade: number;
  riskyAssetPct: number;
  worstGrade: number;
  labelMatches: boolean;
}

export function scoreToBand(score: number): [string, number] {
  for (const [low, high, label, grade] of RISK_BANDS) {
    if (score >= low && score <= high) return [label, grade];
  }
  return ["구간외", 0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeRisk(
  holdings: Holding[],
  statedLabel?: string,
): RiskResult {
  if (holdings.length === 0) {
    throw new Error("구성상품이 비어 있습니다");
  }

  const totalRatio = holdings.reduce((s, h) => s + h.ratioPct, 0);
  if (Math.abs(totalRatio - 100) > 1) {
    throw new Error(`비중 합계가 ${totalRatio}%입니다 (100%여야 함)`);
  }

  // 부동소수점 오차 방지. Python판과 동일하게 소수 둘째 자리에서 반올림한
  // 뒤 구간을 판정한다. 이 반올림이 없으면 2.6999999999999997 같은 값이
  // 구간 경계(2.7)를 미세하게 벗어나 "구간외"로 오분류된다.
  // (KB국민은행 중립투자형 포트폴리오 2_뿔려드림 2에서 실제 발생했던 버그)
  const weighted = round2(
    holdings.reduce((s, h) => s + (h.ratioPct / 100) * h.productGrade, 0),
  );
  const [label, grade] = scoreToBand(weighted);

  const risky = holdings
    .filter((h) => h.productGrade <= RISKY_ASSET_MAX_GRADE)
    .reduce((s, h) => s + h.ratioPct, 0);

  const worst = Math.min(...holdings.map((h) => h.productGrade));

  return {
    weightedScore: weighted,
    computedLabel: label,
    computedGrade: grade,
    riskyAssetPct: Math.round(risky * 10) / 10,
    worstGrade: worst,
    labelMatches: statedLabel === undefined || statedLabel === label,
  };
}
