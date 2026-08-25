# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트

라벨과 실질이 다른 퇴직연금 디폴트옵션을 진단하는 서비스 (2026 금융 AI Challenge 출품). 자세한 문제 정의·설계 배경은 `README.md`, 데이터 출처·재현 방법은 `data/SOURCES.md`를 참고할 것 — 둘 다 이 저장소의 핵심 문서이며 매우 자세하다.

## 명령어

```bash
npm install
npm run dev              # http://localhost:3000/diagnose 부터 시작
npm run build
npm test                 # node --test "tests/**/*.test.ts"
node --test tests/riskEngine.test.ts   # 단일 테스트 파일만 실행
```

앱을 처음 돌리기 전에 최소 1회 필요 (`data/extracted/`, `data/chunks.json`은 gitignore):

```bash
python scripts/01_extract_pdf.py data/raw/<file>.pdf   # PDF → data/extracted/*.json
python scripts/05_build_chunks.py                       # → data/chunks.json (RAG 검색 대상)
python scripts/06_render_evidence.py                     # → public/evidence/*.png + 좌표
```

`chunks.json`을 다시 만들면 `06_render_evidence.py`도 다시 돌려야 좌표가 맞는다.

데이터 재생성/검증 (모두 배포에는 포함되지 않는 오프라인 파이프라인):

```bash
pip install openpyxl pdfplumber anthropic
python scripts/04_build_dataset.py     # 비교공시 엑셀 → products/providers/assumptions.json, 기획서 수치 재현 리포트 stdout 출력
python scripts/03_verify_engine.py     # 위험등급 가중평균 엔진 검증 (IBK 표기값 2.6 재현)
python scripts/02_normalize_llm.py data/extracted/<file>.json   # 사업자별 양식 → 공통 스키마 (ANTHROPIC_API_KEY 필요)
```

`ANTHROPIC_API_KEY`는 `.env.local`에 둔다 (`.env.example` 복사). Next.js와 Python 스크립트(`scripts/_env.py`)가 이 파일 하나를 공유한다. 없어도 앱은 전부 동작하며 "근거 기반 요약 모드"로 강등된다. `NEXT_PUBLIC_` 접두사 금지 — 이 키는 `app/api/ask`에서만 서버 전용으로 읽는다.

## 코딩 규칙

**함수 하나당 기능 하나.** 새 함수를 작성하거나 기존 함수를 수정할 때 하나의 함수가 여러 책임을 동시에 하지 않도록 한다. 여러 일을 해야 하면 작은 함수로 쪼개고 상위 함수에서 조합한다.

**모든 함수에 설명 주석을 단다.** 함수 선언 바로 위에 그 함수가 무엇을 하는지 설명하는 주석을 남긴다 (매개변수·반환값이 자명하지 않다면 함께 명시). TypeScript는 `/** ... */`, Python은 docstring을 사용한다.

## 설계 원칙 (코드 작성 시 반드시 지킬 것)

**숫자는 코드가, 말은 AI가.** `lib/` 아래 계산 모듈(`riskEngine.ts`, `simulate.ts`, `calcFacts.ts`)에는 LLM이 개입하지 않는다 — 금융 서비스에서 LLM이 산수를 하면 환각이 금액 오류로 직결된다. 금액·비율을 다루는 새 로직은 이 순수 함수 계층에 넣고, `lib/claude.ts`(AI 서술 계층)는 그 결과를 문장으로 옮기기만 하게 유지한다.

**외부 런타임 의존 0.** 공시 데이터를 런타임에 호출하지 않는다. 새 데이터가 필요하면 스크립트로 사전 수집·정적 JSON화해서 저장소에 동봉한다. 벡터DB·임베딩 API도 이 원칙 때문에 의도적으로 배제했다 (`lib/retrieve.ts`는 순수 BM25).

**추천하지 않는다.** 특정 사업자·상품을 권하는 문구/로직을 추가하지 않는다. "당신의 위치는 여기입니다"까지가 산출물의 한계.

**거부는 코드가 결정한다.** "근거 없으면 거부하라"를 프롬프트에 맡기지 않는다 — `app/api/ask`의 근거 게이트(relevance 임계값)가 LLM 호출 전에 판정한다.

## 아키텍처

```
/diagnose (ProfileForm) → sessionStorage 저장 → /chat (ChatPanel)
```

입력값은 서버로 저장되지 않고 sessionStorage에만 둔다 (탭 닫으면 소멸). URL 쿼리스트링·localStorage 둘 다 의도적으로 쓰지 않음 (README "실행" 절에 이유 있음). 검증 규칙은 `lib/profile.ts`의 `validateProfile()` 하나이며 폼과 `app/api/ask`가 공유 — 규칙을 갈라놓지 말 것.

### 챗봇(M4) 파이프라인 — `app/api/ask/route.ts`

```
질문 + 진단 입력
  → ① 계산 엔진   riskEngine + simulate + products.json 분포   [LLM 미개입]
  → ② 문서 검색   chunks.json 대상 BM25, 원문 청크 3자리 예약   [LLM 미개입]
                  가입 사업자를 밝혔으면 그 사업자 청크로 범위 제한(하드 필터)
  → ③ 근거 게이트  relevance < 0.06 이면 여기서 거부            [LLM 호출 안 함]
  → ④ 답변 생성    키 없음: 템플릿 폴백 / 키 있음: Claude 서술
  → ⑤ 숫자 검증    calcFacts/문서에 없는 숫자 있으면 경고
  → ⑥ 등급 판정    원문 인용 여부 → documented / no_document
  → ⑦ 근거 표시    documented면 EvidenceFigure가 원문 페이지 형광펜 마킹
```

답변 등급 3단계(`unrelated` / `no_document` / `documented`)는 relevance 점수로 나누지 않는다 — 무관 문서와 관련 문서의 relevance 분포가 겹치기 때문. 대신 **답변이 실제로 원문을 인용했는지**로 판정한다 (LLM 경로는 모델이 반환한 `citedChunkIds`, 폴백 경로는 질문-문장 bigram 커버리지 ≥0.3). 이 판정 로직을 손댈 때는 이 정의를 유지할 것.

폴백(템플릿) 경로와 LLM 경로는 반환 구조가 동일해야 한다 — UI(`ChatPanel.tsx`)가 분기하지 않는다.

### 데이터 단일 원천

- `data/portfolios.json` — 구성상품 상세. `scripts/03_verify_engine.py`(검증)와 `lib/portfolios.ts`(런타임)가 공유. 하드코딩 금지, 항상 이 파일을 통해 읽을 것.
- `data/chunks.json` — RAG 검색 대상 (원문 청크 + 정규화 구성내역, 중복 제거됨). `scripts/05_build_chunks.py`가 `data/extracted/*.json` + `data/portfolios.json`에서 생성.
- `data/products.json` / `providers.json` / `assumptions.json` — 비교공시 엑셀(`data/raw/`)에서 `scripts/04_build_dataset.py`가 생성. LLM 미개입 (엑셀 자체가 이미 공통 스키마).
- `lib/risk_engine.py` / `lib/simulate.py` — 대응하는 `.ts` 파일의 Python 원본, 오프라인 검증용. 위험등급 계산 공식을 바꾸면 두 언어 버전을 동시에 수정하고 `03_verify_engine.py`로 재검증할 것.

### 사업자별 특이사항 (코드에서 분기 처리된 것들)

- **미래에셋증권**은 PDF가 스캔본(텍스트 레이어 없음) → 원문 청크·페이지 좌표 없음, 구성내역 정규화본으로만 답변 가능. 근거 표시 UI가 "구성내역 정규화본"으로 구분 표기.
- **IBK기업은행**은 구성품 개별 등급이 아닌 자산유형 비중으로 근사.
- **KB증권**은 파일명(`Default_1669193286004.pdf`)에 사업자 단서가 없어 `05_build_chunks.py`의 `PROVIDER_PATTERNS`에 파일명을 통째로 지정했다. 또 이 한 파일에 포트폴리오 4종이 모두 들어 있다 — 사업자 단위 근거 필터는 포트폴리오를 갈라 주지 못하므로, 같은 문서 안에서 초저위험(예금자보호 O)과 고위험(보호 X) 페이지가 함께 후보에 오른다.
- 위험등급 환산(6단계 펀드 등급 ↔ 5단계 디폴트옵션 등급)은 `lib/risk_engine.py`의 `FUND_GRADE_TO_DO_GRADE`에 있으며, IBK·삼성생명·미래에셋증권 세 사업자 문서에서 독립적으로 동일하게 확인된 값.

## 레이아웃 메모

`/chat`은 데스크톱(≥1024px)에서 2단(왼쪽 대화·오른쪽 원문 근거 sticky), 모바일은 단일 단. 근거 선택 상태(`openEvidence`)는 `ChatPanel`이 들고 두 레이아웃이 공유한다 — 각 레이아웃에 따로 상태를 두면 화면 폭 전환 시 어긋난다.
