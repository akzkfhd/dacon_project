/**
 * simulate.ts — 은퇴 시점 적립금 시뮬레이션 (런타임)
 *
 * ■ LLM 미개입. 순수 함수만. lib/simulate.py의 이식본이다.
 *
 * ■ 반드시 지킬 것
 *   1) 단일 숫자를 내지 않는다. 항상 밴드(비관/기준/낙관)를 함께 낸다.
 *      단일 숫자는 확정된 미래처럼 읽혀 오해를 만든다.
 *   2) 기대수익률의 출처를 값과 함께 들고 다닌다.
 *   3) 특정 상품을 추천하지 않는다. 위험등급 단위로만 다룬다.
 *
 * ■ 가정값의 성격 (화면에도 이 한계를 표시할 것)
 *   data/assumptions.json은 비교공시 2026년 1분기 실측치다.
 *   annual_return = 라벨 내 1년 수익률 중앙값
 *   volatility    = 라벨 내 상품 간 수익률 표준편차
 *   즉 '미래 기대수익률 예측'이 아니라 '과거 실적 분포'다.
 */
import { assumptions, type GradeAssumption } from "./data.ts";

export interface SimulationResult {
  gradeLabel: string;
  years: number;
  median: number;
  pessimistic: number;
  optimistic: number;
  realValue: number;
  assumedReturn: number;
  source: string;
  asOf: string;
}

/** 물가상승률. 실질가치 환산용. TODO: 통계청 최신값으로 교체 */
export const INFLATION = 0.021;

export function gradeAssumption(label: string): GradeAssumption {
  const a = assumptions[label];
  if (!a) throw new Error(`알 수 없는 위험등급: ${label}`);
  return a;
}

/**
 * 복리 계산. 적립금은 기간 전체 복리, 납입금은 매년 말 납입 가정.
 * 연금 현가 공식 대신 명시적 루프를 쓴다 — 검산하기 쉽고 의도가 드러난다.
 */
function compound(
  principal: number,
  annualContrib: number,
  rate: number,
  years: number,
): number {
  let balance = principal;
  for (let i = 0; i < years; i++) {
    balance = balance * (1 + rate) + annualContrib;
  }
  return balance;
}

/** 단위는 만원. 원 단위를 쓰면 화면에서 자릿수 오류가 잦다. */
export function simulate(
  currentBalanceMan: number,
  annualContributionMan: number,
  yearsToRetire: number,
  gradeLabel: string,
): SimulationResult {
  if (yearsToRetire <= 0) {
    throw new Error("은퇴까지 남은 기간이 0 이하입니다");
  }

  const a = gradeAssumption(gradeLabel);
  const { annual_return: r, volatility: vol } = a;

  const median = compound(
    currentBalanceMan,
    annualContributionMan,
    r,
    yearsToRetire,
  );
  // 밴드는 수익률에 ±변동성을 적용한 결정론적 3시나리오.
  // 몬테카를로는 여유가 있을 때만. 지금은 재현성과 설명 가능성을 택한다.
  const low = compound(
    currentBalanceMan,
    annualContributionMan,
    r - vol,
    yearsToRetire,
  );
  const high = compound(
    currentBalanceMan,
    annualContributionMan,
    r + vol,
    yearsToRetire,
  );

  return {
    gradeLabel,
    years: yearsToRetire,
    median: Math.round(median),
    pessimistic: Math.round(low),
    optimistic: Math.round(high),
    realValue: Math.round(median / Math.pow(1 + INFLATION, yearsToRetire)),
    assumedReturn: r,
    source: a.source,
    asOf: a.as_of,
  };
}

/** 전 등급을 계산하고 현재 등급 대비 격차를 낸다. */
export function compareGrades(
  currentBalanceMan: number,
  annualContributionMan: number,
  yearsToRetire: number,
  baseGrade: string,
): {
  baseGrade: string;
  results: Record<string, SimulationResult>;
  gaps: Record<string, number>;
} {
  const results: Record<string, SimulationResult> = {};
  for (const label of Object.keys(assumptions)) {
    results[label] = simulate(
      currentBalanceMan,
      annualContributionMan,
      yearsToRetire,
      label,
    );
  }

  const base = results[baseGrade].median;
  const gaps: Record<string, number> = {};
  for (const [label, r] of Object.entries(results)) {
    gaps[label] = r.median - base;
  }

  return { baseGrade, results, gaps };
}

/** 만원 단위를 한국어 표기로. 1억 2,400만 형태. */
export function formatWon(man: number): string {
  const sign = man < 0 ? "-" : "";
  const abs = Math.abs(man);
  const eok = Math.floor(abs / 10000);
  const rest = abs % 10000;
  if (eok && rest) return `${sign}${eok}억 ${rest.toLocaleString()}만`;
  if (eok) return `${sign}${eok}억`;
  return `${sign}${abs.toLocaleString()}만`;
}
