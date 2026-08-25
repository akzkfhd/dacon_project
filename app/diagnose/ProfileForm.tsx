"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_PROFILE,
  INVESTMENT_TYPE_LABEL,
  RISK_LABELS,
  loadProfile,
  saveProfile,
  validateProfile,
  type UserProfile,
} from "@/lib/profile";

/**
 * S2 입력 화면. 진단에 쓸 기본정보만 받고 챗봇(/chat)으로 넘긴다.
 *
 * 입력값은 sessionStorage에만 저장한다 — 서버로 보내지 않고, 탭을 닫으면
 * 사라진다. 이 화면에 다시 오면 직전 입력이 복원되어 수정할 수 있다.
 */
export default function ProfileForm({
  providers,
}: {
  providers: string[];
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE);
  const [error, setError] = useState<string | null>(null);
  // sessionStorage는 서버에 없다. 첫 렌더는 기본값으로 하고 마운트 후 복원한다.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const saved = loadProfile();
    if (saved) setProfile(saved);
    setRestored(true);
  }, []);

  function set<K extends keyof UserProfile>(key: K, value: UserProfile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
    setError(null);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const checked = validateProfile(profile);
    if (typeof checked === "string") {
      setError(checked);
      return;
    }
    saveProfile(checked);
    router.push("/chat");
  }

  const years = profile.retireAge - profile.age;

  return (
    <form onSubmit={submit}>
      <div className="mt-6 mb-2.5 text-xs font-bold tracking-[0.14em] text-amber-deep uppercase">
        1분 진단 · 기본정보
      </div>
      <h2 className="text-xl font-bold tracking-[-0.01em] text-ink">
        몇 가지만 알려주세요
      </h2>
      <p className="mt-1.5 text-[15px] text-txt-2">
        계좌 연동도, 로그인도 없습니다. 입력값은 서버로 전송·저장되지 않으며
        브라우저를 닫으면 사라집니다.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Field label="현재 나이">
          <NumberInput
            value={profile.age}
            onChange={(v) => set("age", v)}
            min={19}
            max={70}
          />
        </Field>
        <Field label="예상 은퇴 나이">
          <NumberInput
            value={profile.retireAge}
            onChange={(v) => set("retireAge", v)}
            min={profile.age + 1}
            max={100}
          />
        </Field>
        <Field label="현재 적립금 (만원)">
          <NumberInput
            value={profile.balanceMan}
            onChange={(v) => set("balanceMan", v)}
            min={0}
          />
        </Field>
        <Field label="연간 납입액 (만원)">
          <NumberInput
            value={profile.annualContributionMan}
            onChange={(v) => set("annualContributionMan", v)}
            min={0}
          />
        </Field>
      </div>

      {years > 0 && (
        <p className="mt-2.5 text-[12.5px] text-txt-3">
          은퇴까지 <b className="text-amber-deep">{years}년</b> 남았습니다.
        </p>
      )}

      <Field label="가입 사업자" className="mt-5">
        <select
          value={profile.provider ?? "모름"}
          onChange={(e) =>
            set("provider", e.target.value === "모름" ? null : e.target.value)
          }
          className="w-full rounded-[10px] border border-line-2 bg-paper-2 p-[13px_14px] text-txt"
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value="모름">모름</option>
        </select>
        <span className="mt-1.5 block text-[12px] text-txt-3">
          상품설명서를 확보한 {providers.length}개 사업자입니다. 구성상품·보수와
          원문 근거를 함께 보여 드릴 수 있는 곳만 실었습니다.
        </span>
      </Field>

      <Field label="지금 어떤 투자유형으로 운용되고 있나요?" className="mt-5">
        <div className="flex flex-wrap gap-2">
          {/*
            화면에는 투자유형 이름을 보여 주되 저장되는 값은 공시 라벨
            그대로다. 계산 엔진·상품 데이터·문서 검색이 전부 공시 라벨을
            키로 쓰기 때문에, 여기서 값을 바꾸면 진단이 통째로 어긋난다.
          */}
          {RISK_LABELS.map((l) => (
            <Chip
              key={l}
              selected={profile.currentLabel === l}
              onClick={() => set("currentLabel", l)}
            >
              {INVESTMENT_TYPE_LABEL[l]}
            </Chip>
          ))}
          <Chip
            selected={profile.currentLabel === null}
            onClick={() => set("currentLabel", null)}
          >
            모름
          </Chip>
        </div>
        {profile.currentLabel === null && (
          <span className="mt-2 block text-[12px] text-txt-3">
            모르는 것이 정상입니다. 대부분의 가입자가 자신의 운용 유형을
            모릅니다. 유형 없이도 진단은 가능하며, 가장 보수적인
            {" "}{INVESTMENT_TYPE_LABEL["초저위험"]}을 기준으로 계산합니다.
          </span>
        )}
      </Field>

      {error && (
        <p className="mt-4 rounded-[10px] border border-[#E4B8AE] bg-[#FDF3F1] px-3.5 py-3 text-[13px] text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!restored}
        className="mt-6 block w-full rounded-[14px] bg-amber p-4 text-center text-base font-bold tracking-[-0.01em] text-white disabled:opacity-40"
      >
        진단 결과에 대해 물어보기
      </button>

      <p className="mt-4 text-[11.5px] leading-relaxed text-txt-3">
        본 서비스는 투자를 권유하지 않으며 정보 제공을 목적으로 합니다. 개인
        금융정보를 서버에 수집·저장하지 않습니다.
      </p>
    </form>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-2 block text-sm font-semibold text-ink">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full rounded-[10px] border border-line-2 bg-paper-2 p-[13px_14px] text-txt outline-none focus:border-amber"
    />
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[10px] border px-3.5 py-2.5 text-sm transition ${
        selected
          ? "border-amber bg-[#FBF1E4] font-bold text-amber-deep"
          : "border-line-2 bg-paper-2 text-txt"
      }`}
    >
      {children}
    </button>
  );
}
