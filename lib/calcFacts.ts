/**
 * calcFacts.ts — 계산 엔진의 출력을 한 덩어리로 모은다
 *
 * ■ 이 파일이 만드는 값이 챗봇이 인용해도 되는 유일한 숫자다.
 *   기획서 §3.4: "챗봇은 금액을 생성하지 않는다. 계산 엔진이 확정한 숫자를
 *   받아 설명만 한다."
 *   → LLM 프롬프트에는 여기서 나온 값만 들어가고, 응답에 그 밖의 숫자가
 *     등장하면 lib/claude.ts가 플래그한다.
 *
 * ■ LLM 미개입. riskEngine·simulate·정적 데이터만 사용한다.
 */
import { products, providers, type Product } from "./data.ts";
import { computeRisk, type RiskResult } from "./riskEngine.ts";
import { findPortfolio, toHoldings, type Portfolio } from "./portfolios.ts";
import { compareGrades, simulate, type SimulationResult } from "./simulate.ts";
import type { UserProfile } from "./profile.ts";

// UserProfile의 정의는 lib/profile.ts에 있다 (서버·브라우저 공용).
// 여기서 재수출해 기존 import 경로를 유지한다. 타입만 재수출하므로
// profile.ts의 sessionStorage 코드가 서버 번들로 끌려오지 않는다.
export type { UserProfile };

export interface LabelDistribution {
  label: string;
  count: number;
  minReturn: number;
  medianReturn: number;
  maxReturn: number;
  spreadPp: number;
  minFee: number | null;
  medianFee: number | null;
  maxFee: number | null;
  feeMultiple: number | null;
}

export interface CalcFacts {
  yearsToRetire: number;
  profile: UserProfile;

  /** 사용자가 속한 라벨의 시장 분포. 라벨을 모르면 null. */
  labelDistribution: LabelDistribution | null;
  /** 전체 라벨 분포 — 라벨 간 겹침을 보여주는 데 쓴다. */
  allDistributions: LabelDistribution[];

  /** 가입 사업자의 위험도별 적립금 비중. */
  providerProfile: {
    name: string;
    ultraLowPct: number | null;
    totalAumJo: number;
  } | null;

  /** 대표 포트폴리오와 가중평균 역산 결과. 데이터가 없으면 null. */
  portfolio: {
    detail: Portfolio;
    risk: RiskResult;
    /** 가중평균 계산식을 문자열로 펼친 것. 화면에 계산 과정을 노출하는 용도. */
    formula: string;
  } | null;

  /** 등급별 은퇴 시점 예상액과 현재 대비 격차. */
  simulation: {
    base: string;
    results: Record<string, SimulationResult>;
    gaps: Record<string, number>;
    assumptionSource: string;
    assumptionAsOf: string;
  } | null;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 원리금보장이 아닌데 보수가 정확히 0%인 행은 공시 누락으로 보고 제외한다. */
function feeEligible(p: Product): boolean {
  return p.fee_pct !== null && !(p.fee_pct === 0 && p.guarantee !== "보장");
}

export function labelDistribution(label: string): LabelDistribution | null {
  const inLabel = products.filter((p) => p.risk_label === label);
  const returns = inLabel
    .map((p) => p.return_1y)
    .filter((v): v is number => v !== null);
  if (returns.length === 0) return null;

  const fees = inLabel
    .filter(feeEligible)
    .map((p) => p.fee_pct)
    .filter((v): v is number => v !== null);

  const minFee = fees.length ? Math.min(...fees) : null;
  const maxFee = fees.length ? Math.max(...fees) : null;

  return {
    label,
    count: returns.length,
    minReturn: round2(Math.min(...returns)),
    medianReturn: round2(median(returns)),
    maxReturn: round2(Math.max(...returns)),
    spreadPp: round2(Math.max(...returns) - Math.min(...returns)),
    minFee,
    medianFee: fees.length ? round2(median(fees)) : null,
    maxFee,
    feeMultiple:
      minFee !== null && maxFee !== null && minFee > 0
        ? round2(maxFee / minFee)
        : null,
  };
}

function buildFormula(pf: Portfolio, risk: RiskResult): string {
  const terms = pf.holdings
    .map((h) => `${h.productGrade}×${h.ratioPct / 100}`)
    .join(" + ");
  return `(${terms}) = ${risk.weightedScore} → ${risk.computedLabel}`;
}

export function buildCalcFacts(profile: UserProfile): CalcFacts {
  const yearsToRetire = profile.retireAge - profile.age;

  const allDistributions = ["초저위험", "저위험", "중위험", "고위험"]
    .map(labelDistribution)
    .filter((d): d is LabelDistribution => d !== null);

  const dist = profile.currentLabel
    ? (allDistributions.find((d) => d.label === profile.currentLabel) ?? null)
    : null;

  const providerRow = profile.provider
    ? providers.find((p) => p.name === profile.provider)
    : undefined;

  const pf = findPortfolio(profile.provider, profile.currentLabel);
  let portfolio: CalcFacts["portfolio"] = null;
  if (pf) {
    const risk = computeRisk(toHoldings(pf), pf.riskLabel);
    portfolio = { detail: pf, risk, formula: buildFormula(pf, risk) };
  }

  let simulation: CalcFacts["simulation"] = null;
  if (yearsToRetire > 0) {
    // 라벨을 모르면 가장 보수적인 초저위험을 기준선으로 잡는다.
    // 방치 상태의 실제 다수가 여기 있으므로(적립금의 84.5%) 기본값으로 타당하다.
    const base = profile.currentLabel ?? "초저위험";
    const cmp = compareGrades(
      profile.balanceMan,
      profile.annualContributionMan,
      yearsToRetire,
      base,
    );
    const sample = simulate(
      profile.balanceMan,
      profile.annualContributionMan,
      yearsToRetire,
      base,
    );
    simulation = {
      base,
      results: cmp.results,
      gaps: cmp.gaps,
      assumptionSource: sample.source,
      assumptionAsOf: sample.asOf,
    };
  }

  return {
    yearsToRetire,
    profile,
    labelDistribution: dist,
    allDistributions,
    providerProfile: providerRow
      ? {
          name: providerRow.name,
          ultraLowPct: providerRow.초저위험_비중,
          totalAumJo: round2(providerRow.total_aum / 1e12),
        }
      : null,
    portfolio,
    simulation,
  };
}

/**
 * 화면의 "계산 엔진 결과 스트립"과 프롬프트에 넣을 요약 줄들.
 * AI가 산수한 게 아니라는 것을 시각적으로 분리하기 위한 재료다.
 */
export function calcStripLines(facts: CalcFacts): string[] {
  const lines: string[] = [];
  lines.push(
    `${facts.profile.age}세 · 은퇴까지 ${facts.yearsToRetire}년 · 적립금 ${facts.profile.balanceMan.toLocaleString()}만원`,
  );

  if (facts.portfolio) {
    const { risk, detail, formula } = facts.portfolio;
    lines.push(
      `${detail.provider} ${detail.name} · 라벨 ${detail.riskLabel} · 가중평균 ${formula}`,
    );
    lines.push(
      `위험자산 비중 ${risk.riskyAssetPct}% · 구성품 최고위험 ${risk.worstGrade}등급`,
    );
  }

  if (facts.labelDistribution) {
    const d = facts.labelDistribution;
    lines.push(
      `'${d.label}' 라벨 ${d.count}개 상품의 1년 수익률 ${d.minReturn}% ~ ${d.maxReturn}% (격차 ${d.spreadPp}%p, 중앙값 ${d.medianReturn}%)`,
    );
    if (d.feeMultiple !== null) {
      lines.push(
        `같은 라벨 보수 ${d.minFee}% ~ ${d.maxFee}% (${d.feeMultiple}배 차이)`,
      );
    }
  }

  if (facts.simulation) {
    const { base, results, gaps } = facts.simulation;
    for (const [label, r] of Object.entries(results)) {
      const gap = gaps[label];
      const gapTxt = label === base ? "기준" : `${gap >= 0 ? "+" : ""}${gap.toLocaleString()}만`;
      lines.push(
        `${label} ${facts.yearsToRetire}년 후 ${r.median.toLocaleString()}만원 (${r.pessimistic.toLocaleString()}~${r.optimistic.toLocaleString()}) · ${gapTxt}`,
      );
    }
  }

  return lines;
}
