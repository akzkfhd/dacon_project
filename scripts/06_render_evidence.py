"""
06_render_evidence.py — 인용 근거를 원문 PDF 위에 마킹하기 위한 자산 생성

■ 무엇을 만드는가
  1) public/evidence/{docId}/{page}.png  — 인용될 수 있는 페이지의 렌더링 이미지
  2) data/chunks.json의 각 pdf_text 청크에 evidence 필드
       { "image": "/evidence/a3f9c1/5.png",
         "aspect": 1.4151,                 ← 페이지 높이/너비
         "boxes": [{x, y, w, h}, ...] }   ← 0~1로 정규화된 하이라이트 사각형

  화면은 이미지를 깔고 boxes를 %로 얹기만 하면 된다. 런타임에 PDF를 다루지
  않으므로 PDF.js 같은 의존성이 필요 없다 — 배포스택 §1의 "인프라를 하나
  줄이는 게 완주에 유리"를 따른다.

■ 좌표는 어떻게 얻는가
  청크 텍스트는 page.extract_text() 출력의 연속된 조각이고,
  page.extract_words()는 같은 순서로 단어와 좌표를 준다.
  → 공백을 제거한 전체 문자열에서 청크의 위치를 찾고, 그 구간의 문자들이
    어느 단어에서 왔는지 되짚으면 해당 단어들의 좌표를 얻는다.
  실측 결과 362개 pdf_text 청크 전부(100%) 정렬에 성공했다.

■ 정렬에 실패하면 evidence를 붙이지 않는다
  좌표를 추측해서 엉뚱한 문장에 형광펜을 긋는 것이 최악이다.
  02_normalize_llm.py가 검증 실패 시 "자동 보정 안 함"을 지키는 것과 같은 방침.

사용법: python scripts/06_render_evidence.py [--force]
  --force 를 주면 이미 있는 이미지도 다시 렌더링한다.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
CHUNKS_PATH = ROOT / "data" / "chunks.json"
EVIDENCE_DIR = ROOT / "public" / "evidence"

# 원본 PDF는 저장소 밖(해커톤 데이터 모음/{사업자}/)에 있다.
# data/raw·extracted와 같은 성격이라 저장소에 넣지 않는다.
PDF_ROOT = ROOT.parent.parent

# 909px 폭. 실측상 표·차트까지 읽히면서 페이지당 ~41KB로 가볍다.
RESOLUTION = 110

# 같은 줄로 묶을 세로 허용 오차(pt). 한 줄 안에서도 글자마다 top이 미세하게
# 다르므로 그대로 묶으면 사각형이 잘게 쪼개진다.
LINE_TOLERANCE = 3.0

# 하이라이트를 글자에 딱 붙이면 답답해 보인다. 좌우로 살짝 여유를 준다(pt).
BOX_PADDING_X = 1.5
BOX_PADDING_Y = 1.0


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


def doc_id(doc_name: str) -> str:
    """문서 파일명 → URL에 쓸 짧은 식별자.

    파일명을 그대로 경로에 쓰면 한글·괄호·공백이 URL 인코딩 문제를 일으킨다.
    """
    return hashlib.sha1(doc_name.encode("utf-8")).hexdigest()[:8]


def find_pdf(doc_name: str) -> Path | None:
    """저장소 밖 사업자 폴더에서 원본 PDF를 찾는다."""
    for path in PDF_ROOT.glob(f"*/{doc_name}"):
        if "kkaeum" not in str(path):
            return path
    return None


def page_aspect(page) -> float:
    """페이지 높이/너비. 화면이 크롭 높이를 계산할 때 쓴다.

    A4(1.414)로 가정하면 안 된다 — 실측 결과 이 문서군에는 1.412·1.414·
    1.416·1.445 네 가지가 섞여 있다. 1.445 페이지가 48장이나 되어
    하드코딩하면 크롭 위치가 눈에 띄게 어긋난다.
    """
    return round(float(page.height) / float(page.width), 4)


def align_boxes(page, chunk_text: str) -> list[dict] | None:
    """
    청크 텍스트에 해당하는 단어들을 찾아 줄 단위 사각형(정규화 좌표)으로 만든다.
    찾지 못하면 None — 호출부가 evidence를 붙이지 않는다.
    """
    words = page.extract_words()
    if not words:
        return None

    # 공백 제거 문자열과, 각 문자가 몇 번째 단어에서 왔는지의 대응표
    pieces, owner = [], []
    for i, w in enumerate(words):
        t = norm(w["text"])
        pieces.append(t)
        owner.extend([i] * len(t))
    flat = "".join(pieces)

    target = norm(chunk_text)
    if not target:
        return None

    pos = flat.find(target)
    if pos < 0:
        return None

    matched = [words[i] for i in sorted(set(owner[pos : pos + len(target)]))]
    if not matched:
        return None

    # 같은 줄끼리 묶는다
    lines: dict[int, list] = {}
    for w in matched:
        lines.setdefault(round(w["top"] / LINE_TOLERANCE), []).append(w)

    pw, ph = float(page.width), float(page.height)
    boxes = []
    for group in lines.values():
        x0 = min(w["x0"] for w in group) - BOX_PADDING_X
        x1 = max(w["x1"] for w in group) + BOX_PADDING_X
        y0 = min(w["top"] for w in group) - BOX_PADDING_Y
        y1 = max(w["bottom"] for w in group) + BOX_PADDING_Y

        # 페이지 밖으로 나가지 않게 자른다 — 화면 밖에 형광펜이 그려지면 안 된다
        x0, y0 = max(0.0, x0), max(0.0, y0)
        x1, y1 = min(pw, x1), min(ph, y1)
        if x1 <= x0 or y1 <= y0:
            continue

        boxes.append({
            "x": round(x0 / pw, 5),
            "y": round(y0 / ph, 5),
            "w": round((x1 - x0) / pw, 5),
            "h": round((y1 - y0) / ph, 5),
        })

    if not boxes:
        return None
    # 위에서 아래로 정렬해 두면 UI에서 첫 박스를 기준점으로 쓰기 편하다
    boxes.sort(key=lambda b: b["y"])
    return boxes


def main() -> None:
    force = "--force" in sys.argv
    chunks = json.loads(CHUNKS_PATH.read_text(encoding="utf-8"))

    # 문서별로 묶어 PDF를 한 번만 연다
    by_doc: dict[str, list[dict]] = {}
    for c in chunks:
        if c["sourceType"] == "pdf_text" and c.get("page"):
            by_doc.setdefault(c["doc"], []).append(c)

    print(f"대상 문서 {len(by_doc)}개 · pdf_text 청크 "
          f"{sum(len(v) for v in by_doc.values())}개")

    rendered = skipped = aligned = failed = 0
    missing_pdfs = []

    for doc, doc_chunks in sorted(by_doc.items()):
        pdf_path = find_pdf(doc)
        if pdf_path is None:
            missing_pdfs.append(doc)
            continue

        did = doc_id(doc)
        out_dir = EVIDENCE_DIR / did
        out_dir.mkdir(parents=True, exist_ok=True)

        with pdfplumber.open(pdf_path) as pdf:
            for c in doc_chunks:
                page_no = c["page"]
                if page_no > len(pdf.pages):
                    failed += 1
                    continue
                page = pdf.pages[page_no - 1]

                img_path = out_dir / f"{page_no}.png"
                if force or not img_path.exists():
                    page.to_image(resolution=RESOLUTION).save(str(img_path))
                    rendered += 1
                else:
                    skipped += 1

                boxes = align_boxes(page, c["text"])
                if boxes:
                    c["evidence"] = {
                        "image": f"/evidence/{did}/{page_no}.png",
                        "aspect": page_aspect(page),
                        "boxes": boxes,
                    }
                    aligned += 1
                else:
                    # 좌표를 못 찾으면 붙이지 않는다. 화면은 텍스트 인용만 보여준다.
                    c.pop("evidence", None)
                    failed += 1
                    print(f"  정렬 실패: {doc[:40]} {page_no}p — {c['text'][:40]!r}")

    CHUNKS_PATH.write_text(
        json.dumps(chunks, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    total_bytes = sum(p.stat().st_size for p in EVIDENCE_DIR.rglob("*.png"))
    # rendered는 실제 생성한 이미지 수, skipped는 이미 있는 이미지를 재사용한
    # 청크 수다(여러 청크가 한 페이지를 공유한다). 단위가 달라 헷갈리므로
    # 이미지 수를 따로 센다.
    image_count = len(list(EVIDENCE_DIR.rglob("*.png")))
    print("")
    print(f"페이지 이미지 {image_count}장 (이번에 새로 렌더링 {rendered}장)")
    print(f"좌표 정렬 성공 {aligned} / 실패 {failed}")
    print(f"public/evidence 총 {total_bytes / 1024 / 1024:.1f} MB")

    if missing_pdfs:
        print(f"\n원본 PDF를 찾지 못한 문서 {len(missing_pdfs)}개 "
              f"(해당 청크는 원문 마킹 없이 텍스트 인용만 제공):")
        for d in missing_pdfs[:5]:
            print(f"  {d}")


if __name__ == "__main__":
    main()
