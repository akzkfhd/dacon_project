"""
01_extract_pdf.py — 디폴트옵션 상품설명서 PDF에서 원시 텍스트·표 추출

역할: M1 모듈의 '전처리' 단계.
     이 스크립트는 정규화하지 않는다. 정규화는 02_normalize_llm.py가 담당.

왜 분리하는가:
    사업자마다 PDF 양식이 완전히 다르다. 실측 결과:
      - 하나은행:  "구성비율(%)"  · 합성총보수 0.784%    · PowerPoint 내보내기
      - IBK기업은행: "편입비중"    · 합성총보수 0.71832% · 표 중심 문서
      - 신한투자증권: "비율"       · "수수료 및 기타비용" 0.8169%
    같은 개념을 세 가지 이름으로 부르고 자릿수도 다르다.
    → 규칙 기반 파싱은 사업자가 늘어날수록 깨진다. 여기서는 '뽑기'만 하고
      '해석'은 LLM에 넘긴다.

OCR이 필요한가: 아니다.
    검증 결과 디폴트옵션 설명서는 텍스트 레이어가 살아있는 디지털 PDF다.
    (하나은행 문서는 PowerPoint 내보내기, 폰트 임베드 확인)
    도넛 차트 안 숫자는 이미지라 추출되지 않지만, 같은 값이 표에 있으므로 무해.

사용법:
    python scripts/01_extract_pdf.py data/raw/하나은행_2026_07.pdf
"""
import json
import sys
from pathlib import Path

import pdfplumber


def extract_page(page):
    """한 페이지에서 텍스트와 표를 원형 그대로 뽑는다."""
    return {
        "page_no": page.page_number,
        "text": page.extract_text() or "",
        "tables": [
            [[(cell or "").replace("\n", " ").strip() for cell in row] for row in table]
            for table in page.extract_tables()
        ],
    }


def extract_pdf(pdf_path: Path) -> dict:
    with pdfplumber.open(pdf_path) as pdf:
        pages = [extract_page(p) for p in pdf.pages]

    return {
        "source_file": pdf_path.name,
        "page_count": len(pages),
        "pages": pages,
    }


def has_text_layer(result: dict) -> bool:
    """텍스트 레이어 존재 여부. False면 OCR 검토가 필요하다는 신호."""
    total = sum(len(p["text"]) for p in result["pages"])
    return total > 100 * result["page_count"]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"파일 없음: {pdf_path}")
        sys.exit(1)

    result = extract_pdf(pdf_path)

    if not has_text_layer(result):
        print("경고: 텍스트가 거의 추출되지 않았습니다. 스캔 PDF일 수 있습니다.")
        print("     이 경우에만 OCR을 검토하세요.")

    out = Path("data/extracted") / f"{pdf_path.stem}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    table_count = sum(len(p["tables"]) for p in result["pages"])
    print(f"{result['page_count']}페이지 · 표 {table_count}개 추출 → {out}")
    print("다음 단계: python scripts/02_normalize_llm.py " + str(out))


if __name__ == "__main__":
    main()
