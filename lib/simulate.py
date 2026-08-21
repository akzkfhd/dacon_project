"""
simulate.py — 은퇴 시점 적립금 시뮬레이션

■ LLM 미개입. 순수 함수만.
  S4 화면(슬라이더 → 금액 격차)의 계산을 담당한다.

■ 반드시 지킬 것
  1) 단일 숫자를 내지 않는다. 항상 밴드(비관/기준/낙관)를 함께 낸다.
     단일 숫자는 확정된 미래처럼 읽혀 오해를 만든다.
  2) 기대수익률의 출처를 값과 함께 들고 다닌다.
     화면에서 "이 숫자 왜 이렇게 나왔나"에 답할 수 있어야 한다.
  3) 특정 상품을 추천하지 않는다. 위험등급 단위로만 다룬다.

■ 가정값 출처 (2026-08 갱신)
  GRADE_ASSUMPTIONS는 더 이상 임시값이 아니다. scripts/04_build_dataset.py가
  비교공시 2026년 1분기 원자료(324개 상품)에서 라벨별 1년 수익률의
  중앙값(annual_return)과 표준편차(volatility)를 계산해
  data/assumptions.json으로 만들고, 이 모듈은 그 값을 로드한다.

  ■ 이것이 여전히 근사치인 이유 (한계를 숨기지 않는다)
    - '과거 실적'이지 '미래 기대수익률'이 아니다. 고용노동부 공시 등
      전방(forward-looking) 기대수익률로 교체하면 더 정확해진다.
    - volatility는 '시간에 따른 변동성'이 아니라 '같은 시점 같은 라벨 안에서
      상품 간 실제로 벌어진 격차'다. 다만 이 프로젝트의 핵심 메시지
      ("같은 라벨인데 성과가 이렇게 갈린다")를 그대로 밴드에 반영한다는
      점에서, 근거 없는 가정값보다는 훨씬 정직하다.
  data/assumptions.json의 source·as_of 필드에 근거를 명시해 화면에 노출한다.
"""
import json
from dataclasses import dataclass
from pathlib import Path

_ASSUMPTIONS_PATH = Path(__file__).resolve().parent.parent / "data" / "assumptions.json"


def _load_grade_assumptions() -> dict:
    if not _ASSUMPTIONS_PATH.exists():
        raise FileNotFoundError(
            f"{_ASSUMPTIONS_PATH}이 없습니다. "
            "먼저 python scripts/04_build_dataset.py를 실행하세요."
        )
    return json.loads(_ASSUMPTIONS_PATH.read_text(encoding="utf-8"))


GRADE_ASSUMPTIONS = _load_grade_assumptions()

INFLATION = 0.021  # 물가상승률. 실질가치 환산용. TODO: 통계청 최신값


@dataclass
class SimulationResult:
    grade_label: str
    years: int
    median: int          # 기준 시나리오 (만원)
    pessimistic: int     # 비관 시나리오 (만원)
    optimistic: int      # 낙관 시나리오 (만원)
    real_value: int      # 물가 반영 실질가치 (만원)
    assumed_return: float
    source: str


def _compound(principal: float, annual_contrib: float, rate: float, years: int) -> float:
    """
    복리 계산. 적립금은 기간 전체 복리, 납입금은 매년 말 납입 가정.
    연금 현가 공식 대신 명시적 루프를 쓴다 — 검산하기 쉽고 의도가 드러난다.
    """
    balance = principal
    for _ in range(years):
        balance = balance * (1 + rate) + annual_contrib
    return balance


def simulate(
    current_balance_man: float,
    annual_contribution_man: float,
    years_to_retire: int,
    grade_label: str,
) -> SimulationResult:
    """
    단위는 만원. 원 단위를 쓰면 화면에서 자릿수 오류가 잦다.
    """
    if years_to_retire <= 0:
        raise ValueError("은퇴까지 남은 기간이 0 이하입니다")
    if grade_label not in GRADE_ASSUMPTIONS:
        raise ValueError(f"알 수 없는 위험등급: {grade_label}")

    a = GRADE_ASSUMPTIONS[grade_label]
    r, vol = a["annual_return"], a["volatility"]

    median = _compound(current_balance_man, annual_contribution_man, r, years_to_retire)
    # 밴드는 수익률에 ±변동성을 적용한 결정론적 3시나리오.
    # 몬테카를로는 여유가 있을 때만. 지금은 재현성과 설명 가능성을 택한다.
    low = _compound(current_balance_man, annual_contribution_man, r - vol, years_to_retire)
    high = _compound(current_balance_man, annual_contribution_man, r + vol, years_to_retire)

    real = median / ((1 + INFLATION) ** years_to_retire)

    return SimulationResult(
        grade_label=grade_label,
        years=years_to_retire,
        median=round(median),
        pessimistic=round(low),
        optimistic=round(high),
        real_value=round(real),
        assumed_return=r,
        source=a["source"],
    )


def compare_grades(
    current_balance_man: float,
    annual_contribution_man: float,
    years_to_retire: int,
    base_grade: str,
) -> dict:
    """
    전 등급을 계산하고 현재 등급 대비 격차를 낸다. S4 슬라이더용.
    """
    results = {
        label: simulate(current_balance_man, annual_contribution_man, years_to_retire, label)
        for label in GRADE_ASSUMPTIONS
    }
    base = results[base_grade].median

    return {
        "base_grade": base_grade,
        "results": results,
        "gaps": {label: r.median - base for label, r in results.items()},
    }


def format_won(man: int) -> str:
    """만원 단위를 한국어 표기로. 1억 2,400만 형태."""
    eok, rest = divmod(man, 10000)
    if eok and rest:
        return f"{eok}억 {rest:,}만"
    if eok:
        return f"{eok}억"
    return f"{man:,}만"
