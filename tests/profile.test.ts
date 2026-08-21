/**
 * profile.test.ts — 입력 검증과 세션 보관
 *
 * 화면이 입력(/diagnose)과 챗봇(/chat)으로 나뉘면서 이 모듈이 둘 사이의
 * 계약이 됐다. 폼과 API 라우트가 같은 규칙을 쓰는지, 세션 왕복이 손실 없이
 * 되는지가 핵심이다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROFILE,
  RISK_LABELS,
  validateProfile,
  loadProfile,
  saveProfile,
  clearProfile,
  type UserProfile,
} from "../lib/profile.ts";

const VALID: UserProfile = {
  age: 38,
  retireAge: 60,
  balanceMan: 4500,
  annualContributionMan: 300,
  provider: "하나은행",
  currentLabel: "저위험",
};

test("정상 입력을 통과시킨다", () => {
  assert.deepEqual(validateProfile(VALID), VALID);
});

test("기본값은 그 자체로 유효하다", () => {
  // 폼이 기본값으로 시작하는데 그게 검증에 걸리면 첫 화면부터 오류가 뜬다
  assert.notEqual(typeof validateProfile(DEFAULT_PROFILE), "string");
});

test("나이 범위를 강제한다", () => {
  assert.match(String(validateProfile({ ...VALID, age: 18 })), /나이/);
  assert.match(String(validateProfile({ ...VALID, age: 71 })), /나이/);
});

test("은퇴 나이는 현재 나이보다 커야 한다", () => {
  assert.match(String(validateProfile({ ...VALID, retireAge: 38 })), /은퇴/);
  assert.match(String(validateProfile({ ...VALID, retireAge: 30 })), /은퇴/);
});

test("음수 금액을 거부한다", () => {
  assert.match(String(validateProfile({ ...VALID, balanceMan: -1 })), /적립금/);
  assert.match(
    String(validateProfile({ ...VALID, annualContributionMan: -1 })),
    /납입액/,
  );
});

test("숫자가 아닌 값을 거부한다", () => {
  assert.equal(typeof validateProfile({ ...VALID, age: "서른여덟" }), "string");
  assert.equal(typeof validateProfile({}), "string");
  assert.equal(typeof validateProfile(null), "string");
});

test("'모름'은 null로 정규화한다", () => {
  const r = validateProfile({ ...VALID, provider: "모름", currentLabel: "모름" });
  assert.notEqual(typeof r, "string");
  assert.equal((r as UserProfile).provider, null);
  assert.equal((r as UserProfile).currentLabel, null);
});

test("알 수 없는 위험등급은 null로 떨어뜨린다", () => {
  const r = validateProfile({ ...VALID, currentLabel: "적당위험" });
  assert.equal((r as UserProfile).currentLabel, null);
});

test("모든 위험등급 라벨을 받아들인다", () => {
  for (const label of RISK_LABELS) {
    const r = validateProfile({ ...VALID, currentLabel: label });
    assert.equal((r as UserProfile).currentLabel, label);
  }
});

test("연간 납입액은 생략 가능하다 — 0으로 채운다", () => {
  const { annualContributionMan: _omitted, ...withoutContribution } = VALID;
  const r = validateProfile(withoutContribution);
  assert.equal((r as UserProfile).annualContributionMan, 0);
});

// ── 세션 보관 ──────────────────────────────────────────────
// sessionStorage는 node에 없다. 최소 구현으로 대체해 왕복을 검증한다.

function withFakeSession(fn: () => void) {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  try {
    fn();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

test("세션 저장 후 그대로 복원된다", () => {
  withFakeSession(() => {
    saveProfile(VALID);
    assert.deepEqual(loadProfile(), VALID);
  });
});

test("저장된 값이 없으면 null", () => {
  withFakeSession(() => {
    assert.equal(loadProfile(), null);
  });
});

test("지우면 사라진다 — 세션 종료 시 소멸 원칙", () => {
  withFakeSession(() => {
    saveProfile(VALID);
    clearProfile();
    assert.equal(loadProfile(), null);
  });
});

test("깨진 저장값은 null로 처리한다 — 앱이 멈추지 않는다", () => {
  withFakeSession(() => {
    window.sessionStorage.setItem("kkaeum:profile", "{이건 JSON이 아님");
    assert.equal(loadProfile(), null);
  });
});

test("저장값이 검증을 통과하지 못하면 null", () => {
  // 개발자도구로 고쳤거나 스키마가 바뀐 경우
  withFakeSession(() => {
    window.sessionStorage.setItem(
      "kkaeum:profile",
      JSON.stringify({ ...VALID, age: 999 }),
    );
    assert.equal(loadProfile(), null);
  });
});

test("서버에서는 세션 접근이 조용히 무시된다", () => {
  // window가 없는 상태(SSR). 예외를 던지면 페이지 렌더가 깨진다.
  assert.equal(loadProfile(), null);
  assert.doesNotThrow(() => saveProfile(VALID));
  assert.doesNotThrow(() => clearProfile());
});
