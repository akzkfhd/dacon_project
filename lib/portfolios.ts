/**
 * portfolios.ts — 구성상품 상세 로더
 *
 * data/portfolios.json은 scripts/03_verify_engine.py와 공유하는 단일 원천이다.
 * 검증 스크립트가 통과한 데이터와 화면에 뜨는 데이터가 같음을 보장한다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Holding } from "./riskEngine.ts";

export interface Portfolio {
  provider: string;
  name: string;
  riskLabel: string;
  riskGrade: number;
  totalFeePct: number | null;
  docStatedScore: number | null;
  sourceDoc: string;
  holdings: Array<{
    name: string;
    kind: "fund" | "deposit" | "gic" | "elb";
    ratioPct: number;
    productGrade: number;
    ratePct: number | null;
  }>;
}

const raw = JSON.parse(
  readFileSync(path.join(process.cwd(), "data", "portfolios.json"), "utf-8"),
) as { portfolios: Portfolio[] };

export const portfolios: Portfolio[] = raw.portfolios;

export function toHoldings(pf: Portfolio): Holding[] {
  return pf.holdings.map((h) => ({
    name: h.name,
    ratioPct: h.ratioPct,
    productGrade: h.productGrade,
  }));
}

/** 사업자·라벨로 대표 포트폴리오 1건을 찾는다. */
export function findPortfolio(
  provider: string | null,
  riskLabel: string | null,
): Portfolio | null {
  if (!provider) return null;
  const byProvider = portfolios.filter((p) => p.provider === provider);
  if (byProvider.length === 0) return null;
  if (!riskLabel) return byProvider[0];
  return byProvider.find((p) => p.riskLabel === riskLabel) ?? null;
}

export const providersWithPortfolios: string[] = [
  ...new Set(portfolios.map((p) => p.provider)),
];
