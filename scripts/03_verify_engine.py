"""
03_verify_engine.py — 계산 엔진 검증

심사에서 "이 계산 근거가 무엇인가"를 물으면 이 스크립트를 돌려 보인다.

핵심 검증: IBK 상품설명서에 표기된 위험도 2.6을 우리 엔진이 재현하는가.
          재현되면 이 계산은 우리가 지어낸 게 아니라
          사업자가 공시한 공식을 역산한 것임이 증명된다.

실행: python scripts/03_verify_engine.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.risk_engine import (
    Holding,
    compare_within_label,
    compute_risk,
    find_label_overlaps,
)

ROOT = Path(__file__).resolve().parent.parent


def load_portfolios() -> list[dict]:
    """
    실측 데이터(상품설명서 원문에서 전사)를 data/portfolios.json에서 읽는다.

    이 목록은 예전에 이 스크립트에 하드코딩되어 있었다. 런타임(Next.js)이
    같은 데이터를 필요로 하게 되면서 사본이 둘로 갈라질 위험이 생겼고,
    검증 스크립트가 통과해도 화면은 다른 값을 보여주는 사고가 가능해졌다.
    → 단일 원천을 data/portfolios.json에 두고 양쪽이 이를 읽는다.

    출처와 전사 근거는 data/SOURCES.md 참조.
    """
    raw = json.loads((ROOT / "data" / "portfolios.json").read_text(encoding="utf-8"))
    return [
        {
            "provider": pf["provider"],
            "name": pf["name"],
            "risk_label": pf["riskLabel"],
            "doc_stated_score": pf["docStatedScore"],
            "holdings": [
                Holding(h["name"], h["ratioPct"], h["productGrade"])
                for h in pf["holdings"]
            ],
        }
        for pf in raw["portfolios"]
    ]


PORTFOLIOS = load_portfolios()



def main():
    print("=" * 76)
    print("1. 공식 재현 검증 — 문서 표기값과 엔진 계산값 대조")
    print("=" * 76)

    verified = 0
    for pf in PORTFOLIOS:
        if pf["doc_stated_score"] is None:
            continue
        result = compute_risk(pf["holdings"], pf["risk_label"])
        match = abs(result.weighted_score - pf["doc_stated_score"]) < 0.01
        mark = "일치" if match else "불일치"
        print(f"{pf['provider']} {pf['name']}")
        print(f"  문서 표기: {pf['doc_stated_score']}  /  엔진 계산: {result.weighted_score}  →  {mark}")
        if match:
            verified += 1

    print(f"\n검증 통과: {verified}건")

    print("\n" + "=" * 76)
    print("2. 전체 포트폴리오 역산")
    print("=" * 76)
    print(f"{'사업자':12s} {'포트폴리오':24s} {'라벨':8s} {'점수':>6s} {'위험자산':>7s} {'최고위험'}")
    print("-" * 76)

    computed = []
    for pf in PORTFOLIOS:
        r = compute_risk(pf["holdings"], pf["risk_label"])
        computed.append({**pf, "result": r})
        flag = "  ←구성품에 고위험 포함" if r.worst_grade <= 2 and pf["risk_label"] in ("저위험", "중위험") else ""
        print(f"{pf['provider']:12s} {pf['name']:24s} {pf['risk_label']:8s} "
              f"{r.weighted_score:6.2f} {r.risky_asset_pct:6.0f}% {r.worst_grade}등급{flag}")

    print("\n" + "=" * 76)
    print("3. 같은 라벨 안에서의 격차")
    print("=" * 76)
    summary = compare_within_label(computed)
    for label in ("저위험", "중위험", "고위험"):
        if label not in summary:
            continue
        s = summary[label]
        print(f"{label:8s} 상품 {s['count']}개 · 위험자산 "
              f"{s['min_risky_pct']:.0f}% ~ {s['max_risky_pct']:.0f}% "
              f"(격차 {s['spread_pp']:.0f}%p)")

    print("\n" + "=" * 76)
    print("4. 라벨 구간 겹침 — 프로젝트의 핵심 발견")
    print("=" * 76)
    overlaps = find_label_overlaps(summary)
    if overlaps:
        for o in overlaps:
            print(f"  겹침: {o}")
        print("\n  → 한 등급 낮은 라벨을 고른 가입자가")
        print("     다른 사업자의 한 등급 높은 라벨과 같은 위험을 지고 있다.")
    else:
        print("  겹침 없음")

    print("\n" + "=" * 76)
    print("한계 (화면에도 반드시 명시할 것)")
    print("=" * 76)
    print("  - 표본 6개 사업자(하나은행·IBK기업은행·신한투자증권·KB국민은행·삼성생명·")
    print("    미래에셋증권). 전체 40여 곳으로 확장 시 결과가 달라질 수 있다.")
    print("  - IBK는 구성품 개별 등급이 아닌 자산유형 비중으로 근사했다.")
    print("  - 위험자산 비중과 실제 손실 가능성은 다르다.")
    print("    TDF2030과 TDF2050은 같은 등급이어도 성격이 다르다.")


if __name__ == "__main__":
    main()
