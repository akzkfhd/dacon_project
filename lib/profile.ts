/**
 * profile.ts — 사용자 진단 입력의 타입·검증·보관
 *
 * ■ 이 모듈은 서버와 브라우저 양쪽에서 쓴다.
 *   node:fs 같은 서버 전용 모듈을 import하지 않는다 (클라이언트 번들에 들어간다).
 *   반대로 sessionStorage 접근은 전부 typeof window 가드 안에 둔다.
 *
 * ■ 왜 sessionStorage인가
 *   기획서 §4.4: "로그인 없음. 입력값은 브라우저 세션에만 존재, 서버 미저장.
 *   세션 종료 시 소멸."
 *   sessionStorage가 이 요구를 그대로 만족한다 — 탭을 닫으면 사라진다.
 *
 *   URL 쿼리스트링은 쓰지 않는다. 나이·적립금은 개인 금융정보인데
 *   주소창·브라우저 히스토리·리퍼러 헤더에 남는다.
 *   localStorage도 쓰지 않는다. 탭을 닫아도 남아 "세션 종료 시 소멸"을 어긴다.
 *   공용 PC에서 쓰는 사용자를 상정한 설계다.
 */

export interface UserProfile {
  age: number;
  retireAge: number;
  balanceMan: number;
  annualContributionMan: number;
  /** 가입 사업자. "모름"이면 null. */
  provider: string | null;
  /** 현재 운용 라벨. "모름"/"운용지시 안 함"이면 null. */
  currentLabel: string | null;
}

export const RISK_LABELS = ["초저위험", "저위험", "중위험", "고위험"] as const;
export type RiskLabel = (typeof RISK_LABELS)[number];

/**
 * 화면에 보여 줄 투자유형 이름.
 *
 * 저장·계산·검색에는 절대 쓰지 않는다. 내부 값은 공시 용어(초저위험…고위험)
 * 그대로여야 한다 — products.json·portfolios.json·chunks.json과 위험등급
 * 엔진이 모두 그 문자열을 키로 쓰고, 상품설명서 원문에도 그 단어가 적혀 있다.
 * 여기서 바꾸는 것은 사용자에게 보이는 이름뿐이다.
 *
 * '위험등급'이라는 말이 상품 선택을 위험도 순위처럼 읽히게 해서, 사업자들이
 * 실제로 쓰는 투자유형 이름(안정형·안정투자형·중립투자형·적극투자형)으로
 * 표시한다.
 */
export const INVESTMENT_TYPE_LABEL: Record<RiskLabel, string> = {
  초저위험: "안정형",
  저위험: "안정투자형",
  중위험: "중립투자형",
  고위험: "적극투자형",
};

/** 공시 라벨을 화면 표시용 투자유형 이름으로 바꾼다. 모르는 값은 그대로 둔다. */
export function investmentTypeName(label: string | null): string | null {
  if (label === null) return null;
  return INVESTMENT_TYPE_LABEL[label as RiskLabel] ?? label;
}

/**
 * 선택 가능한 사업자.
 *
 * 상품설명서를 확보해 구성상품·보수·근거 문서를 실제로 제시할 수 있는 곳만
 * 둔다. 전체 41개 사업자를 다 보여 주면, 자료가 없는 곳을 고른 사용자는
 * 무엇을 물어도 "확보한 자료에 없습니다"만 듣게 된다. 고를 수 있다는 것이
 * 답할 수 있다는 뜻이어야 한다.
 *
 * 이 목록은 lib/portfolios.ts의 providersWithPortfolios와 반드시 일치한다
 * (tests/profile.test.ts가 어긋남을 잡는다). 여기에 따로 적어 두는 이유는
 * 이 모듈이 브라우저 번들에 들어가기 때문이다 — 데이터 JSON을 import하면
 * 포트폴리오 전체가 클라이언트로 딸려 간다.
 */
export const SUPPORTED_PROVIDERS = [
  "KB국민은행",
  "IBK기업은행",
  "삼성생명",
  "신한투자증권",
  "미래에셋증권",
  "하나은행",
  "KB증권",
] as const;

export const DEFAULT_PROFILE: UserProfile = {
  age: 38,
  retireAge: 60,
  balanceMan: 4500,
  annualContributionMan: 0,
  provider: null,
  currentLabel: "저위험",
};

const STORAGE_KEY = "kkaeum:profile";

/**
 * 입력값 검증. 서버(API 라우트)와 클라이언트(입력 폼)가 같은 함수를 쓴다.
 * 규칙이 두 곳에 갈라지면 폼은 통과시키는데 API가 거부하는 상태가 생긴다.
 *
 * @returns 정상이면 UserProfile, 아니면 사용자에게 보여줄 오류 메시지
 */
export function validateProfile(raw: unknown): UserProfile | string {
  const r = (raw ?? {}) as Record<string, unknown>;

  const age = Number(r.age);
  const retireAge = Number(r.retireAge);
  const balanceMan = Number(r.balanceMan);
  const annualContributionMan = Number(r.annualContributionMan ?? 0);

  if (!Number.isFinite(age) || age < 19 || age > 70) {
    return "나이는 19~70 사이여야 합니다.";
  }
  if (!Number.isFinite(retireAge) || retireAge <= age || retireAge > 100) {
    return "예상 은퇴 나이는 현재 나이보다 커야 합니다.";
  }
  if (!Number.isFinite(balanceMan) || balanceMan < 0) {
    return "적립금은 0 이상이어야 합니다.";
  }
  if (!Number.isFinite(annualContributionMan) || annualContributionMan < 0) {
    return "연간 납입액은 0 이상이어야 합니다.";
  }

  // 자료가 없는 사업자는 '모름'과 같게 취급한다. 폼에서는 고를 수 없지만
  // 세션에 남은 예전 값이나 API 직접 호출로 들어올 수 있다.
  const provider =
    typeof r.provider === "string" &&
    (SUPPORTED_PROVIDERS as readonly string[]).includes(r.provider)
      ? r.provider
      : null;

  const currentLabel =
    typeof r.currentLabel === "string" &&
    (RISK_LABELS as readonly string[]).includes(r.currentLabel)
      ? r.currentLabel
      : null;

  return { age, retireAge, balanceMan, annualContributionMan, provider, currentLabel };
}

/** 세션에 저장. 브라우저에서만 동작한다. */
export function saveProfile(profile: UserProfile): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

/**
 * 세션에서 읽는다. 없거나 깨졌으면 null.
 * 저장된 값도 반드시 검증을 거친다 — 사용자가 개발자도구로 고칠 수 있고,
 * 앱 버전이 올라가며 스키마가 바뀌었을 수도 있다.
 */
export function loadProfile(): UserProfile | null {
  if (typeof window === "undefined") return null;

  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = validateProfile(JSON.parse(raw));
    return typeof parsed === "string" ? null : parsed;
  } catch {
    return null;
  }
}

export function clearProfile(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}
