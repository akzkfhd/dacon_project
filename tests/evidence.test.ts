/**
 * evidence.test.ts — 원문 마킹 자산의 무결성
 *
 * 이 기능은 "좌표가 맞는가"가 전부다. 좌표가 어긋나면 엉뚱한 문장에
 * 형광펜이 그어지고, 그건 근거 투명성을 내세우는 서비스에서 최악의 오류다.
 * 육안 확인은 사람이 하되, 기계로 잡을 수 있는 것은 여기서 잡는다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { chunks } from "../lib/data.ts";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const pdfChunks = chunks.filter((c) => c.sourceType === "pdf_text");
const withEvidence = chunks.filter((c) => c.evidence);

test("원문 청크 대부분이 마킹 좌표를 갖는다", () => {
  const rate = withEvidence.length / pdfChunks.length;
  assert.ok(
    rate >= 0.95,
    `evidence 보유율 ${(rate * 100).toFixed(1)}% — 파이프라인이 깨졌을 수 있다`,
  );
});

test("모든 하이라이트 좌표가 페이지 안에 있다", () => {
  // 0~1을 벗어나면 이미지 밖에 형광펜이 그려진다
  for (const c of withEvidence) {
    for (const b of c.evidence!.boxes) {
      assert.ok(b.x >= 0 && b.x <= 1, `${c.id}: x=${b.x}`);
      assert.ok(b.y >= 0 && b.y <= 1, `${c.id}: y=${b.y}`);
      assert.ok(b.w > 0 && b.x + b.w <= 1.001, `${c.id}: x+w=${b.x + b.w}`);
      assert.ok(b.h > 0 && b.y + b.h <= 1.001, `${c.id}: y+h=${b.y + b.h}`);
    }
  }
});

test("빈 박스 목록을 가진 evidence는 만들지 않는다", () => {
  // 박스가 없으면 보여줄 게 없는데 UI는 버튼을 띄우게 된다
  for (const c of withEvidence) {
    assert.ok(c.evidence!.boxes.length > 0, `${c.id}의 박스가 비어 있다`);
  }
});

test("참조하는 페이지 이미지가 실제로 존재한다", () => {
  const missing = new Set<string>();
  for (const c of withEvidence) {
    const rel = c.evidence!.image.replace(/^\//, "");
    if (!existsSync(path.join(PUBLIC_DIR, rel))) missing.add(c.evidence!.image);
  }
  assert.equal(
    missing.size,
    0,
    `이미지 파일 누락: ${[...missing].slice(0, 3).join(", ")}`,
  );
});

test("이미지 경로가 URL로 안전하다", () => {
  // 한글·공백이 든 문서명을 그대로 경로에 쓰면 인코딩 문제가 생긴다.
  // 06_render_evidence.py가 해시 기반 docId를 쓰는 이유다.
  for (const c of withEvidence) {
    assert.match(
      c.evidence!.image,
      /^\/evidence\/[0-9a-f]{8}\/\d+\.png$/,
      `${c.id}: 예상치 못한 경로 ${c.evidence!.image}`,
    );
  }
});

test("정규화 청크에는 원문 마킹이 없다", () => {
  // normalized는 원문이 아니라 전사·구조화한 결과라 페이지 좌표가 없다.
  // 스캔 PDF인 미래에셋증권도 여기에 해당한다.
  for (const c of chunks.filter((x) => x.sourceType === "normalized")) {
    assert.equal(c.evidence, undefined, `${c.id}에 evidence가 붙었다`);
  }
});

test("미래에셋증권은 원문 마킹을 제공하지 않는다 — 스캔 PDF 한계", () => {
  const mirae = chunks.filter((c) => c.provider === "미래에셋증권");
  assert.ok(mirae.length > 0);
  assert.ok(
    mirae.every((c) => !c.evidence),
    "스캔 PDF는 텍스트 레이어가 없어 좌표를 만들 수 없다",
  );
});

test("페이지 종횡비가 데이터에 담겨 있다 — A4 가정 금지", () => {
  // 이 문서군에는 1.412·1.414·1.416·1.445 네 비율이 섞여 있다.
  // 화면이 A4로 가정하면 크롭 위치가 어긋난다.
  const ratios = new Set<number>();
  for (const c of withEvidence) {
    const a = c.evidence!.aspect;
    assert.ok(
      typeof a === "number" && a > 0.5 && a < 3,
      `${c.id}: 비정상 종횡비 ${a}`,
    );
    ratios.add(a);
  }
  assert.ok(ratios.size > 1, "실제로 여러 비율이 존재해야 한다");
});
