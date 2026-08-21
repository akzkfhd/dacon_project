"""
02_normalize_llm.py — 사업자별 상이한 PDF 텍스트를 공통 스키마로 정규화

■ 이 파일이 프로젝트에서 AI가 실제로 일하는 지점이다.

왜 LLM이어야 하는가 (규칙 기반이 실패하는 실측 근거):

  1) 용어가 다르다
       하나은행 "구성비율(%)" / IBK "편입비중" / 신한 "비율"
  2) 자릿수가 다르다
       0.784% vs 0.71832% vs 0.8169%
  3) 표 구조가 다르다
       하나은행은 PowerPoint 내보내기라 상품명이 표 셀 밖 텍스트 상자에 떠 있다.
       pdfplumber로 표를 뽑으면 상품명 열이 전부 None으로 나온다.
       게다가 상품명이 두 줄로 쪼개지는 경우가 있어(NH-Amundi하나로적격TDF2030)
       정규식 매칭은 실제로 1건 누락됐다.
  4) 문서 구조가 다르다
       IBK는 상세표에 상품유형 정의 문단이 섞여 있고,
       신한은 구성상품별 상세 페이지가 별도로 존재한다.

  → 사업자가 3곳일 때도 이미 깨진다. 40곳으로 확장하면 유지 불가능하다.
    LLM은 "이 문서에서 구성상품과 비중을 찾아라"는 의도 수준으로 지시할 수 있다.

■ 설계 원칙: 숫자는 코드가, 말은 AI가
    LLM은 문서에 있는 값을 '찾아서 옮기는' 일만 한다.
    가중평균·복리 같은 계산은 절대 시키지 않는다 (lib/ 순수 함수가 담당).
    프롬프트에 "계산하지 말라"를 명시하고, 스키마 검증으로 이중 방어한다.

■ API 키
    저장소 루트의 .env.local에서 ANTHROPIC_API_KEY를 읽는다 (scripts/_env.py).
    Next.js 앱과 같은 파일을 쓰므로 키를 두 곳에 넣을 필요가 없다.
        cp .env.example .env.local   # 그리고 키를 채워 넣기
"""
import json
import sys
from pathlib import Path

import anthropic

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _env import require  # noqa: E402  (경로 삽입 후에 import해야 한다)

MODEL = "claude-sonnet-4-6"

# 공통 스키마. 사업자가 무엇이라 부르든 이 형태로 수렴시킨다.
SCHEMA = """{
  "provider": "사업자명",
  "as_of": "기준일 (YYYY-MM-DD, 문서에 있으면)",
  "portfolios": [
    {
      "name": "포트폴리오명",
      "risk_label": "초저위험|저위험|중위험|고위험|초고위험",
      "risk_grade": 1-5,
      "total_fee_pct": 합성총보수 (숫자, %),
      "holdings": [
        {
          "name": "구성상품명",
          "kind": "fund|deposit|gic|elb",
          "ratio_pct": 편입비중 (숫자, %),
          "product_grade": 구성상품의 디폴트옵션 위험도 1-5,
          "rate_pct": 원리금보장상품 금리 (숫자, 없으면 null)
        }
      ]
    }
  ]
}"""

PROMPT = """다음은 퇴직연금 디폴트옵션 상품설명서에서 추출한 텍스트입니다.
사업자마다 용어와 표 구조가 다릅니다. 아래 공통 스키마로 정규화하세요.

[중요 규칙]
1. 문서에 있는 값만 옮기세요. 계산하지 마세요.
   - 가중평균, 합계, 환산 등 어떤 산술도 수행하지 마세요.
   - 그런 계산은 별도 코드가 담당합니다.
2. 문서에 없는 값은 null로 두세요. 추정하지 마세요.
3. 용어 대응 (사업자별 표현이 다름):
   - "구성비율" = "편입비중" = "비율" → ratio_pct
   - "합성총보수" = "수수료 및 기타비용" → total_fee_pct
   - 위험등급이 "2등급(고위험)" 형태면 grade=2, label="고위험"
4. 구성상품의 위험등급과 포트폴리오 전체 위험등급을 혼동하지 마세요.
   포트폴리오 등급은 구성상품 등급의 가중평균으로 산출된 별개 값입니다.
5. 출력은 JSON만. 설명, 마크다운 코드펜스 없이.

[공통 스키마]
{schema}

[문서 텍스트]
{document}
"""


def normalize(document_text: str) -> dict:
    # .env.local → .env → 이미 설정된 환경변수 순으로 찾는다.
    # 없으면 무엇을 어떻게 하라는지 알려주고 종료한다.
    client = anthropic.Anthropic(api_key=require("ANTHROPIC_API_KEY"))

    response = client.messages.create(
        model=MODEL,
        max_tokens=8000,
        messages=[{
            "role": "user",
            "content": PROMPT.format(schema=SCHEMA, document=document_text),
        }],
    )

    raw = "".join(block.text for block in response.content if block.type == "text")
    cleaned = raw.replace("```json", "").replace("```", "").strip()
    return json.loads(cleaned)


def validate(data: dict) -> list[str]:
    """스키마 검증. LLM 출력을 그대로 믿지 않는다."""
    problems = []

    for pf in data.get("portfolios", []):
        name = pf.get("name", "?")
        holdings = pf.get("holdings", [])

        if not holdings:
            problems.append(f"{name}: 구성상품 없음")
            continue

        total = sum(h.get("ratio_pct") or 0 for h in holdings)
        # 비중 합은 100%여야 한다. 벗어나면 추출 누락 신호.
        if abs(total - 100) > 1:
            problems.append(f"{name}: 비중 합계 {total}% (100%가 아님)")

        for h in holdings:
            if h.get("ratio_pct") is None:
                problems.append(f"{name}: '{h.get('name')}' 비중 누락")
            if h.get("product_grade") is None:
                problems.append(f"{name}: '{h.get('name')}' 구성상품 등급 누락")

    return problems


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    src = Path(sys.argv[1])
    extracted = json.loads(src.read_text(encoding="utf-8"))

    # 페이지 텍스트를 이어붙여 전달 (표는 텍스트에도 대체로 포함됨)
    document = "\n\n".join(
        f"--- {p['page_no']}페이지 ---\n{p['text']}" for p in extracted["pages"]
    )

    print(f"{src.name} 정규화 중... ({len(document):,}자)")
    data = normalize(document)

    problems = validate(data)
    if problems:
        print("\n검증 경고:")
        for p in problems:
            print(f"  - {p}")
        print("\n※ 경고가 있으면 원문을 직접 확인하세요. 자동 보정하지 않습니다.")
    else:
        print("검증 통과")

    out = Path("data/normalized") / f"{src.stem}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n포트폴리오 {len(data.get('portfolios', []))}개 → {out}")


if __name__ == "__main__":
    main()
