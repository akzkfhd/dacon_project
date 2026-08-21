"""
risk_engine.py — 위험등급 가중평균 역산 엔진

■ 이 파일에 LLM은 절대 개입하지 않는다. 순수 함수만 존재한다.
  근거: 금융 서비스에서 LLM이 산수를 하면 환각이 금액 오류로 직결된다.

■ 계산 공식의 출처 (우리가 만든 게 아니다)
  IBK기업은행 디폴트옵션 상품설명서 1p에 명시:
    "포트폴리오 위험도 : 개별상품 디폴트옵션 위험도를 편입비중으로 가중평균하여 산출한 값
     예시) 펀드 위험등급 3등급50% + 4등급50%
           = 디폴트옵션 적용 위험도 2등급*50% + 3등급*50% = 2.5 (고위험)"

  하나은행 문서에도 동일 취지가 있다:
    "포트폴리오의 위험등급은 개별 구성상품의 위험등급을 구성비중별로 가중평균하여 적용"

  검증: IBK 적극투자형 2호의 문서 표기 위험도 2.6과
        본 엔진 계산값 2.60이 일치함을 확인 (tests 참조).

■ 이 엔진이 드러내는 문제 (프로젝트의 핵심 논거)
  가중평균이라서, 구성품 중 어느 것도 고위험이 아닌데 포트폴리오가 고위험이 되거나,
  반대로 자산의 절반이 고위험인데 '저위험' 라벨이 붙는다.
  실측 결과 같은 '중위험' 라벨 안에서 위험자산 비중이 60~80%로 20%p 벌어졌고,
  '저위험' 상단(60%)과 '중위험' 하단(60%)이 겹쳤다.
"""
from dataclasses import dataclass

# 디폴트옵션 위험도 점수 → 라벨 구간 (IBK 문서 기준)
# 주의: 숫자가 작을수록 위험하다 (1등급=초고위험, 5등급=초저위험)
RISK_BANDS = [
    (4.3, 5.0, "초저위험", 5),
    (3.5, 4.2, "저위험", 4),
    (2.7, 3.4, "중위험", 3),
    (1.9, 2.6, "고위험", 2),
    (1.0, 1.8, "초고위험", 1),
]

# 금융투자상품 위험등급(1~6) → 디폴트옵션 적용 위험도(1~5) 매핑 (IBK 문서 표)
FUND_GRADE_TO_DO_GRADE = {1: 1, 2: 2, 3: 2, 4: 3, 5: 4, 6: 5}

# 위험자산으로 간주하는 디폴트옵션 위험도 상한
# (3등급 이하 = 중위험 이상 = 실적배당형 자산)
RISKY_ASSET_MAX_GRADE = 3


@dataclass
class Holding:
    name: str
    ratio_pct: float
    product_grade: int  # 디폴트옵션 위험도 1~5


@dataclass
class RiskResult:
    weighted_score: float       # 가중평균 점수
    computed_label: str         # 역산된 라벨
    computed_grade: int         # 역산된 등급
    risky_asset_pct: float      # 위험자산(실적배당형) 비중
    worst_grade: int            # 구성품 중 가장 위험한 등급
    label_matches: bool         # 문서 라벨과 역산 결과 일치 여부


def score_to_band(score: float) -> tuple[str, int]:
    """가중평균 점수를 라벨과 등급으로 변환."""
    for low, high, label, grade in RISK_BANDS:
        if low <= score <= high:
            return label, grade
    return "구간외", 0


def compute_risk(holdings: list[Holding], stated_label: str | None = None) -> RiskResult:
    """
    구성상품 목록으로부터 포트폴리오 위험도를 역산한다.

    stated_label을 주면 문서 표기와 계산 결과의 일치 여부를 검사한다.
    불일치는 데이터 오류 신호이므로 화면에 노출하지 않고 로그로 남긴다.
    """
    if not holdings:
        raise ValueError("구성상품이 비어 있습니다")

    total_ratio = sum(h.ratio_pct for h in holdings)
    if abs(total_ratio - 100) > 1:
        raise ValueError(f"비중 합계가 {total_ratio}%입니다 (100%여야 함)")

    # 부동소수점 오차 방지: 비중(%)·등급(정수)의 곱은 항상 0.01 단위인데,
    # 부동소수점 합산 결과가 예: 2.6999999999999997로 나와 구간 경계(2.7)를
    # 살짝 벗어나 "구간외"로 오분류되는 사례가 실측 데이터에서 발견됨
    # (KB국민은행 중립투자형 포트폴리오 2_뿔려드림 2, 문서 표기 경계값 2.70).
    weighted = round(sum(h.ratio_pct / 100 * h.product_grade for h in holdings), 2)
    label, grade = score_to_band(weighted)

    risky = sum(
        h.ratio_pct for h in holdings
        if h.product_grade <= RISKY_ASSET_MAX_GRADE
    )
    worst = min(h.product_grade for h in holdings)

    return RiskResult(
        weighted_score=round(weighted, 2),
        computed_label=label,
        computed_grade=grade,
        risky_asset_pct=round(risky, 1),
        worst_grade=worst,
        label_matches=(stated_label is None or stated_label == label),
    )


def compare_within_label(portfolios: list[dict]) -> dict:
    """
    같은 라벨 안에서의 격차를 산출한다. 크로스 사업자 비교의 핵심.

    portfolios: [{"provider", "name", "risk_label", "result": RiskResult}, ...]
    반환: 라벨별 위험자산 비중의 최소·최대·격차
    """
    by_label: dict[str, list] = {}
    for pf in portfolios:
        by_label.setdefault(pf["risk_label"], []).append(pf)

    summary = {}
    for label, group in by_label.items():
        pcts = [pf["result"].risky_asset_pct for pf in group]
        summary[label] = {
            "count": len(group),
            "min_risky_pct": min(pcts),
            "max_risky_pct": max(pcts),
            "spread_pp": round(max(pcts) - min(pcts), 1),
        }
    return summary


def find_label_overlaps(summary: dict) -> list[str]:
    """
    라벨 구간이 겹치는 지점을 찾는다.
    '저위험' 상단과 '중위험' 하단이 겹치면, 한 등급 낮은 라벨을 고른 사람이
    다른 회사의 한 등급 높은 라벨과 같은 위험을 지고 있다는 뜻이다.
    """
    order = ["초저위험", "저위험", "중위험", "고위험", "초고위험"]
    present = [lbl for lbl in order if lbl in summary]

    overlaps = []
    for lower, higher in zip(present, present[1:]):
        lo, hi = summary[lower], summary[higher]
        # 낮은 위험 라벨의 최대치가 높은 위험 라벨의 최소치 이상이면 겹침
        if lo["max_risky_pct"] >= hi["min_risky_pct"]:
            overlaps.append(
                f"'{lower}' 최대 {lo['max_risky_pct']}% ≥ "
                f"'{higher}' 최소 {hi['min_risky_pct']}%"
            )
    return overlaps
