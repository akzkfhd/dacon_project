/**
 * data.ts — 정적 데이터셋 로더 (서버 전용)
 *
 * 런타임에 외부 공시를 호출하지 않는다. 빌드 타임에 확정된 JSON만 읽는다.
 * 심사 기간 중 외부 사이트 장애가 서비스 다운으로 이어지지 않게 하기 위함.
 *
 * import 대신 fs를 쓰는 이유: 같은 모듈을 Next 런타임과 node --test 양쪽에서
 * 그대로 쓰기 위해서다. JSON import는 두 환경의 assertion 문법이 달라진다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface Product {
  name: string;
  provider: string;
  guarantee: string | null;
  product_type: string | null;
  risk_label: string | null;
  return_1y: number | null;
  fee_pct: number | null;
  aum_total: number | null;
}

export interface Provider {
  name: string;
  product_count: number;
  total_aum: number;
  초저위험_비중: number | null;
  저위험_비중: number | null;
  중위험_비중: number | null;
  고위험_비중: number | null;
}

export interface GradeAssumption {
  annual_return: number;
  volatility: number;
  source: string;
  as_of: string;
}

/** 원문 페이지 위 하이라이트 사각형. 0~1로 정규화된 비율 좌표. */
export interface EvidenceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 인용 구절을 원문 PDF 페이지 이미지 위에 마킹하기 위한 정보.
 * scripts/06_render_evidence.py가 채운다. 좌표 정렬에 실패한 청크와
 * 스캔 PDF(미래에셋증권)에는 없다.
 */
export interface ChunkEvidence {
  /** public/ 기준 경로. 예: /evidence/8b94ffba/1.png */
  image: string;
  /** 페이지 높이/너비. 문서마다 다르므로 A4로 가정하지 않는다. */
  aspect: number;
  boxes: EvidenceBox[];
}

export interface Chunk {
  id: string;
  provider: string;
  doc: string;
  page: number | null;
  heading: string;
  text: string;
  sourceType: "pdf_text" | "normalized";
  occurrences: Array<{ doc: string; page: number | null }>;
  evidence?: ChunkEvidence;
}

const DATA_DIR = path.join(process.cwd(), "data");

function load<T>(filename: string): T {
  return JSON.parse(readFileSync(path.join(DATA_DIR, filename), "utf-8")) as T;
}

// 모듈 로드 시 1회만 읽는다. 서버리스 인스턴스가 살아 있는 동안 재사용된다.
export const products: Product[] = load("products.json");
export const providers: Provider[] = load("providers.json");
export const assumptions: Record<string, GradeAssumption> =
  load("assumptions.json");
export const chunks: Chunk[] = load("chunks.json");

export const RISK_LABELS = ["초저위험", "저위험", "중위험", "고위험"] as const;
export type RiskLabel = (typeof RISK_LABELS)[number];
