"""
_env.py — .env 파일을 읽어 환경변수로 올린다 (의존성 없음)

■ 왜 필요한가
  Next.js는 .env.local을 자동으로 읽지만 Python 스크립트는 읽지 않는다.
  그래서 같은 키를 두 곳에 따로 넣어야 했다.
  이 모듈이 그 간극을 메워, 저장소 루트의 .env.local 하나로 통일한다.

■ 왜 python-dotenv를 쓰지 않는가
  20줄이면 되는 일에 의존성을 늘리지 않는다.
  배포스택 문서의 판단을 따른다 — "인프라가 하나 늘 때마다 완주 확률이 떨어진다".

■ 우선순위 (앞이 이길수록 강함)
  1. 이미 설정된 환경변수 (export ANTHROPIC_API_KEY=... 로 준 값)
  2. .env.local
  3. .env
  이미 있는 값을 덮어쓰지 않는 것이 dotenv 계열의 표준 동작이다.
  일회성으로 다른 키를 쓰고 싶을 때 export가 이기는 편이 편하다.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 뒤쪽이 먼저 읽혀 이긴다(먼저 채워진 값을 덮어쓰지 않으므로).
ENV_FILES = (".env.local", ".env")


def _parse(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        # KEY="값" / KEY='값' 둘 다 허용
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def load_env() -> None:
    """저장소 루트의 .env.local / .env를 환경변수로 올린다. 파일이 없으면 조용히 넘어간다."""
    for name in ENV_FILES:
        path = ROOT / name
        if not path.exists():
            continue
        for key, value in _parse(path).items():
            # 빈 값은 '설정되지 않음'으로 취급한다 — .env.example을 그대로
            # 복사해 두고 키를 안 채운 경우, 빈 문자열이 올라가면
            # "키가 있다"고 잘못 판단하게 된다.
            if value and key not in os.environ:
                os.environ[key] = value


def require(key: str) -> str:
    """
    필수 환경변수를 읽는다. 없으면 무엇을 어떻게 하라는지 알려주고 종료한다.
    KeyError 스택트레이스만 던지면 원인을 찾기 어렵다.
    """
    load_env()
    value = os.environ.get(key)
    if not value:
        raise SystemExit(
            f"환경변수 {key}가 없습니다.\n"
            f"  1) cp .env.example .env.local\n"
            f"  2) .env.local 의 {key}= 뒤에 키를 채워 넣으세요\n"
            f"  (또는 export {key}=... 로 일회성 지정)"
        )
    return value
