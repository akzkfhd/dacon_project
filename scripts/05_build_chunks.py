"""
05_build_chunks.py — 상품설명서 → 검색 가능한 청크 (data/chunks.json)

■ 역할: M4(근거 기반 Q&A)의 검색 대상을 만든다.
  런타임(Next.js)은 이 JSON 하나만 읽는다. PDF도, 벡터DB도 런타임에 없다.
  "외부 런타임 의존 0" 원칙에 따라 빌드 타임에 전부 확정한다.

■ 입력 두 갈래

  A. data/extracted/*.json  ← 01_extract_pdf.py 출력 (PDF 원문 텍스트)
     sourceType="pdf_text". 페이지 번호가 그대로 인용 근거가 된다.
     "상품설명서 13p에 이렇게 쓰여 있습니다"라고 말할 수 있는 유일한 재료.

  B. data/portfolios.json  ← 정규화된 구성상품 상세 (단일 원천)
     sourceType="normalized". "이 포트폴리오는 무엇으로 구성되는가"류 질문에
     답하는 재료. 원문 자체는 아니고 원문에서 뽑아 구조화한 것이므로
     출처를 구분해 표기한다 — 근거의 성격이 다르면 다르게 보여야 한다.

     scripts/03_verify_engine.py가 검증하는 바로 그 파일을 읽는다. 사업자별
     *_portfolios.json을 따로 읽던 이전 방식은 IBK기업은행·신한투자증권이
     빠져 있었고(그 둘은 사업자별 파일이 없다), 그 결과 두 사업자 가입자가
     "내 상품 구성" 질문을 하면 다른 사업자 문서가 근거로 달렸다.

■ 중복 제거가 필수인 이유
  44개 문서 중 상당수가 같은 사업자의 형제 문서다. 예를 들어 KB국민은행
  8개 문서는 '위험등급 설명'·'투자자 권리보호'·'FAQ' 페이지가 글자 단위로
  동일하다. 중복을 두면 BM25 상위 k개가 같은 문단으로 가득 차서 정작
  질문에 맞는 청크가 밀려난다. 정규화 텍스트 해시로 묶고, 어느 문서들에
  나타났는지는 occurrences에 남긴다.

사용법: python scripts/05_build_chunks.py
"""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRACTED_DIR = ROOT / "data" / "extracted"
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "chunks.json"

# 청크 크기. 너무 작으면 문맥이 끊기고, 너무 크면 검색 정밀도가 떨어진다.
TARGET_CHARS = 500
MAX_CHARS = 900
MIN_CHARS = 60

# 파일명 → 사업자. 파일명 규칙이 사업자마다 완전히 달라 패턴 매칭이 필요하다.
PROVIDER_PATTERNS = [
    (re.compile(r"^하나은행"), "하나은행"),
    (re.compile(r"^IBK_RPM"), "IBK기업은행"),
    (re.compile(r"Shinhan_Securities"), "신한투자증권"),
    (re.compile(r"KB디폴트옵션"), "KB국민은행"),
    (re.compile(r"삼성생명|핵심설명서"), "삼성생명"),
    (re.compile(r"^8[12]000\d"), "미래에셋증권"),
]

KIND_LABEL = {
    "fund": "펀드(실적배당)",
    "deposit": "정기예금(원리금보장)",
    "gic": "이율보증보험 GIC(원리금보장)",
    "elb": "ELB(원리금보장)",
}

GRADE_LABEL = {1: "초고위험", 2: "고위험", 3: "중위험", 4: "저위험", 5: "초저위험"}


def provider_of(stem: str) -> str:
    for pattern, name in PROVIDER_PATTERNS:
        if pattern.search(stem):
            return name
    return "미상"


def normalize_for_hash(text: str) -> str:
    """공백·숫자 서식 차이를 무시한 중복 판정용 정규화."""
    return re.sub(r"\s+", " ", text).strip()


def split_page_text(text: str) -> list[str]:
    """
    페이지 텍스트를 청크로 자른다.
    줄 단위로 누적하다 TARGET_CHARS를 넘으면 끊는다. 문단 경계(빈 줄)를
    우선 존중하되, 상품설명서는 빈 줄이 거의 없어 길이 기준이 주로 작동한다.
    """
    lines = [ln.strip() for ln in text.split("\n")]
    chunks: list[str] = []
    buf: list[str] = []
    size = 0

    for line in lines:
        if not line:
            continue
        # 한 줄이 통째로 너무 길면 문장 단위로 쪼갠다
        pieces = [line] if len(line) <= MAX_CHARS else re.split(r"(?<=[.。])\s+", line)
        for piece in pieces:
            if size + len(piece) > TARGET_CHARS and buf:
                chunks.append("\n".join(buf))
                buf, size = [], 0
            buf.append(piece)
            size += len(piece) + 1

    if buf:
        chunks.append("\n".join(buf))

    return [c for c in chunks if len(normalize_for_hash(c)) >= MIN_CHARS]


def build_pdf_chunks() -> list[dict]:
    chunks = []
    if not EXTRACTED_DIR.exists():
        return chunks

    for path in sorted(EXTRACTED_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        doc = data.get("source_file", path.name)
        provider = provider_of(path.stem)

        for page in data.get("pages", []):
            page_no = page.get("page_no")
            for piece in split_page_text(page.get("text", "")):
                chunks.append({
                    "provider": provider,
                    "doc": doc,
                    "page": page_no,
                    "heading": f"{provider} · {doc} {page_no}p",
                    "text": piece,
                    "sourceType": "pdf_text",
                })
    return chunks


def portfolio_to_text(pf: dict) -> str:
    """포트폴리오 1건을 검색·인용 가능한 산문으로 편다."""
    provider = pf["provider"]
    lines = [
        f"{provider} 디폴트옵션 {pf['name']}의 구성 내역입니다.",
        f"라벨은 {pf['riskLabel']}({pf['riskGrade']}등급)입니다.",
    ]

    fee = pf.get("totalFeePct")
    if fee is None:
        lines.append("합성총보수는 이 문서에 숫자로 공시되어 있지 않습니다.")
    else:
        lines.append(f"합성총보수는 연 {fee}%입니다.")

    lines.append("구성상품:")
    for h in pf["holdings"]:
        kind = KIND_LABEL.get(h["kind"], h["kind"])
        grade = h["productGrade"]
        line = (
            f"- {h['name']} / 비중 {h['ratioPct']}% / {kind} / "
            f"{grade}등급({GRADE_LABEL.get(grade, '')})"
        )
        if h.get("ratePct") is not None:
            line += f" / 약정금리 연 {h['ratePct']}%"
        lines.append(line)

    guaranteed = sum(
        h["ratioPct"] for h in pf["holdings"]
        if h["kind"] in ("deposit", "gic", "elb")
    )
    if guaranteed == 0:
        lines.append("원리금보장상품이 없어 전액 원금 손실 가능성이 있습니다.")
    elif guaranteed == 100:
        lines.append("전액 원리금보장상품으로 구성됩니다.")
    else:
        lines.append(
            f"원리금보장상품 비중은 {guaranteed}%이며, "
            f"나머지 {round(100 - guaranteed, 1)}%는 원금 손실이 발생할 수 있습니다."
        )

    # 가중평균 계산식을 문장에 포함시킨다. "왜 라벨이 이렇게 나왔나" 질문의
    # 근거가 되는 핵심 정보이고, 검색어와도 잘 맞는다.
    terms = " + ".join(
        f"{h['productGrade']}×{h['ratioPct'] / 100:g}" for h in pf["holdings"]
    )
    lines.append(
        f"위험도는 구성상품 등급을 편입비중으로 가중평균해 산출합니다: {terms}."
    )

    return "\n".join(lines)


def build_portfolio_chunks() -> list[dict]:
    path = DATA_DIR / "portfolios.json"
    if not path.exists():
        return []

    raw = json.loads(path.read_text(encoding="utf-8"))
    return [
        {
            "provider": pf["provider"],
            "doc": pf["sourceDoc"],
            "page": None,
            "heading": f"{pf['provider']} · {pf['name']} 구성 내역",
            "text": portfolio_to_text(pf),
            "sourceType": "normalized",
        }
        for pf in raw["portfolios"]
    ]


def deduplicate(chunks: list[dict]) -> list[dict]:
    """
    동일 텍스트를 하나로 합친다. 어느 문서들에 나타났는지는 occurrences에 남겨
    "이 문구는 KB 8개 문서에 공통으로 있다"는 사실을 잃지 않는다.
    """
    seen: dict[str, dict] = {}
    for c in chunks:
        key = hashlib.sha1(
            normalize_for_hash(c["text"]).encode("utf-8")
        ).hexdigest()

        if key in seen:
            existing = seen[key]
            occ = {"doc": c["doc"], "page": c["page"]}
            if occ not in existing["occurrences"]:
                existing["occurrences"].append(occ)
            continue

        seen[key] = {
            **c,
            "id": key[:12],
            "occurrences": [{"doc": c["doc"], "page": c["page"]}],
        }

    return list(seen.values())


def main():
    pdf_chunks = build_pdf_chunks()
    pf_chunks = build_portfolio_chunks()
    chunks = deduplicate(pdf_chunks + pf_chunks)

    OUT_PATH.write_text(
        json.dumps(chunks, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"원문 청크 {len(pdf_chunks)}개 + 구성내역 청크 {len(pf_chunks)}개")
    print(f"중복 제거 후 {len(chunks)}개 → {OUT_PATH.relative_to(ROOT)}")

    print("\n사업자별 청크 수")
    by_provider: dict[str, dict[str, int]] = {}
    for c in chunks:
        entry = by_provider.setdefault(c["provider"], {"pdf_text": 0, "normalized": 0})
        entry[c["sourceType"]] += 1

    for provider, counts in sorted(by_provider.items(), key=lambda kv: -sum(kv[1].values())):
        note = ""
        if counts["pdf_text"] == 0:
            note = "  ← 원문 텍스트 없음(스캔 PDF). 구성내역 청크로만 답변 가능"
        print(f"  {provider:10s} 원문 {counts['pdf_text']:4d} · 구성내역 {counts['normalized']:3d}{note}")


if __name__ == "__main__":
    main()
