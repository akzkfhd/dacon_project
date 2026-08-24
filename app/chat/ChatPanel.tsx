"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loadProfile, type UserProfile } from "@/lib/profile";
import EvidenceFigure from "./EvidenceFigure";

/**
 * 챗봇 화면. 진단 입력은 /diagnose가 받아 sessionStorage에 넣어 둔 것을 읽는다.
 *
 * 기능명세서 §3.2가 요구하는 세 요소를 반드시 보여준다:
 *   - 컨텍스트 칩        → 사용자를 알고 답한다는 것을 시각화
 *   - 계산 엔진 결과 스트립 → AI가 산수한 게 아님을 시각적으로 분리
 *   - 근거 인용           → 문서명 + 페이지
 * 여기에 근거 미발견 시 거부 표시를 더한다.
 */

interface Citation {
  chunkId: string;
  label: string;
  provider: string;
  sourceType: "pdf_text" | "normalized";
  excerpt: string;
  /** 원문 페이지 이미지 + 하이라이트 좌표. 스캔 PDF·정규화 청크에는 없다. */
  evidence?: {
    image: string;
    aspect: number;
    boxes: Array<{ x: number; y: number; w: number; h: number }>;
  };
}

/** 답변의 근거 등급. lib/claude.ts의 AnswerTier와 같다. */
type AnswerTier = "unrelated" | "no_document" | "documented";

interface AskResult {
  answer: string;
  citations: Citation[];
  calcStrip: string[];
  tier: AnswerTier;
  refused: boolean;
  degraded: boolean;
  warnings: string[];
  relevance: number;
}

interface Turn {
  question: string;
  result?: AskResult;
  error?: string;
}

// 예시 질문은 세 등급을 한 번씩 보여준다: 문서 근거가 붙는 질문 둘과
// 계산 엔진이 답하는 질문 하나. 답이 문서 어디에 있는지 분명한 것만 고른다 —
// "제 상품이 위험한 편인가요?"처럼 범위가 넓은 질문은 위험 고지·위험등급표·
// 성향불일치 항목이 모두 걸려, 사업자에 따라 근거 문단이 들쭉날쭉했다.
const SUGGESTIONS = [
  { tag: "보장", q: "예금자보호가 되나요?" },
  { tag: "문서", q: "이거 원금 손실 날 수 있나요?" },
  { tag: "계산", q: "왜 구성품은 2등급인데 라벨은 저위험인가요?" },
];

export default function ChatPanel({ llmAvailable }: { llmAvailable: boolean }) {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const threadEnd = useRef<HTMLDivElement>(null);

  // 어느 인용의 원문을 펼쳐 볼지. 모바일은 인용 바로 아래에 인라인으로,
  // 데스크톱은 우측 패널에 같은 그림을 띄운다 — 상태를 하나로 두면
  // 두 레이아웃이 어긋나지 않는다.
  const [openEvidence, setOpenEvidence] = useState<Citation | null>(null);
  const toggleEvidence = (c: Citation) =>
    setOpenEvidence((prev) => (prev?.chunkId === c.chunkId ? null : c));

  // sessionStorage는 서버에 없으므로 마운트 후에 읽는다.
  useEffect(() => {
    setProfile(loadProfile());
    setLoaded(true);
  }, []);

  async function ask(question: string) {
    if (!question.trim() || pending || !profile) return;
    setPending(true);
    setTurns((t) => [...t, { question }]);
    setDraft("");
    // 새 질문의 답이 오면 이전 답변의 근거는 맥락이 어긋난다
    setOpenEvidence(null);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, profile }),
      });

      const data = await res.json();
      setTurns((t) => {
        const next = [...t];
        const last = next[next.length - 1];
        if (!res.ok) last.error = data.error ?? "답변을 가져오지 못했습니다.";
        else last.result = data as AskResult;
        return next;
      });
    } catch {
      setTurns((t) => {
        const next = [...t];
        next[next.length - 1].error =
          "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
        return next;
      });
    } finally {
      setPending(false);
      requestAnimationFrame(() =>
        threadEnd.current?.scrollIntoView({ behavior: "smooth" }),
      );
    }
  }

  if (!loaded) {
    return <p className="mt-8 text-[14px] text-txt-3">불러오는 중…</p>;
  }

  // 입력 없이 /chat에 직접 들어온 경우. 진단 컨텍스트가 없으면 이 챗봇은
  // 일반 문서 챗봇과 다를 바 없어지므로, 입력 화면으로 되돌린다.
  if (!profile) {
    return (
      <section className="mt-8">
        <h2 className="text-xl font-bold tracking-[-0.01em] text-ink">
          먼저 기본정보를 입력해 주세요
        </h2>
        <p className="mt-2 text-[15px] text-txt-2">
          이 챗봇은 상품설명서만 읽는 것이 아니라, 입력하신 정보로 계산한 결과를
          함께 근거로 씁니다. 그래서 기본정보 없이는 답변할 수 없습니다.
        </p>
        <button
          onClick={() => router.push("/diagnose")}
          className="mt-6 block w-full rounded-[14px] bg-amber p-4 text-center text-base font-bold text-white"
        >
          기본정보 입력하기
        </button>
      </section>
    );
  }

  const years = profile.retireAge - profile.age;

  return (
    // 데스크톱: 왼쪽 대화 · 오른쪽 원문 근거. 답변과 상품설명서를 나란히 놓고
    // 대조할 수 있어야 '근거 투명성'이 말이 아니라 화면으로 증명된다.
    // 모바일: 한 단으로 접히고 근거는 인용 바로 아래 인라인으로 펼쳐진다.
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
    <section className="mt-6 min-w-0">
      <div className="mb-1 flex items-center gap-2">
        <span className="h-[7px] w-[7px] rounded-full bg-amber" />
        <span className="text-[17px] font-bold text-ink">
          진단 결과에 대해 물어보기
        </span>
      </div>
      <p className="mb-3.5 text-[12.5px] text-txt-3">
        입력하신 정보와 상품설명서를 근거로 답변합니다
      </p>

      {/* 컨텍스트 칩 — 사용자를 알고 답한다는 것을 시각화 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip>
          {profile.age}세 · 은퇴까지 {years}년
        </Chip>
        <Chip>적립금 {profile.balanceMan.toLocaleString()}만</Chip>
        <Chip>{profile.provider ?? "사업자 모름"}</Chip>
        <Chip>{profile.currentLabel ?? "등급 모름"}</Chip>
        <Link
          href="/diagnose"
          className="ml-auto text-[12px] font-semibold text-amber-deep underline underline-offset-2"
        >
          정보 수정
        </Link>
      </div>

      {!llmAvailable && (
        <div className="mt-3 rounded-[10px] border border-line bg-paper-2 px-3 py-2.5 text-[11.5px] leading-relaxed text-txt-2">
          <b className="text-ink">근거 기반 요약 모드</b>로 동작 중입니다.
          ANTHROPIC_API_KEY가 설정되지 않아 검색·계산·인용만으로 답변을
          구성합니다. 키를 설정하면 같은 근거를 AI가 더 자연스럽게 서술합니다.
        </div>
      )}

      {turns.length === 0 && (
        <div className="mt-3.5 flex flex-col gap-[7px]">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.q}
              onClick={() => ask(s.q)}
              className="rounded-[10px] border border-line-2 bg-paper-2 px-3.5 py-2.5 text-left text-[13.5px] leading-snug text-txt transition hover:border-amber hover:text-amber-deep"
            >
              <span className="mb-0.5 block text-[10.5px] font-bold tracking-[0.06em] text-amber-deep">
                {s.tag}
              </span>
              {s.q}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3.5">
        {turns.map((turn, i) => (
          <TurnView
            key={i}
            turn={turn}
            openEvidenceId={openEvidence?.chunkId ?? null}
            onToggleEvidence={toggleEvidence}
          />
        ))}
        {pending && (
          <div className="mt-2.5 flex w-fit gap-1 rounded-[12px] border border-line bg-paper-2 px-4 py-3.5">
            <i className="typing-dot h-1.5 w-1.5 rounded-full bg-line-2" />
            <i
              className="typing-dot h-1.5 w-1.5 rounded-full bg-line-2"
              style={{ animationDelay: ".15s" }}
            />
            <i
              className="typing-dot h-1.5 w-1.5 rounded-full bg-line-2"
              style={{ animationDelay: ".3s" }}
            />
          </div>
        )}
        <div ref={threadEnd} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(draft);
        }}
        className="mt-3.5 flex gap-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="궁금한 점을 입력하세요"
          maxLength={500}
          className="flex-1 rounded-[10px] border border-line-2 bg-paper-2 px-3.5 py-3 text-sm text-txt outline-none focus:border-amber"
        />
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          className="rounded-[10px] bg-ink px-4.5 text-sm font-bold text-white disabled:opacity-40"
        >
          전송
        </button>
      </form>

      <p className="mt-2.5 text-[10.5px] leading-relaxed text-txt-3">
        금액·비율은 계산 엔진이 산출하며 AI가 생성하지 않습니다. 근거를 찾지
        못하면 답변하지 않습니다. 본 서비스는 투자를 권유하지 않습니다.
      </p>
    </section>

      {/* 데스크톱 전용 근거 패널. sticky로 두어 대화를 스크롤해도
          원문이 계속 보이게 한다. */}
      <aside className="hidden lg:sticky lg:top-6 lg:mt-6 lg:block lg:min-w-0">
        {openEvidence?.evidence ? (
          <div className="rounded-[12px] border border-line bg-paper-2 p-4">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-[13px] font-bold text-ink">원문 근거</span>
              <span className="truncate text-[11px] text-txt-3">
                {openEvidence.provider} · {openEvidence.label}
              </span>
            </div>
            <EvidenceFigure
              image={openEvidence.evidence.image}
              aspect={openEvidence.evidence.aspect}
              boxes={openEvidence.evidence.boxes}
              label={openEvidence.label}
              provider={openEvidence.provider}
              // 넓은 화면에서는 페이지 전체를 펼쳐도 글자가 읽힌다.
              // 문서 안에서 근거가 어디쯤인지까지 한눈에 보인다.
              defaultWhole
            />
          </div>
        ) : (
          <div className="rounded-[12px] border border-dashed border-line-2 p-6 text-center text-[12.5px] leading-relaxed text-txt-3">
            답변의 <b className="text-txt-2">근거</b> 아래 &lsquo;원문에서
            확인&rsquo;을 누르면
            <br />
            상품설명서 원문에 표시된 해당 구절이 여기 나타납니다.
          </div>
        )}
      </aside>
    </div>
  );
}

function TurnView({
  turn,
  openEvidenceId,
  onToggleEvidence,
}: {
  turn: Turn;
  openEvidenceId: string | null;
  onToggleEvidence: (c: Citation) => void;
}) {
  const r = turn.result;
  return (
    <div className="mb-3">
      <div className="ml-auto w-fit max-w-[88%] rounded-[12px_12px_4px_12px] bg-ink px-3.5 py-2.5 text-[13.5px] leading-snug text-white">
        {turn.question}
      </div>

      {turn.error && (
        <div className="mt-2 max-w-[95%] rounded-[12px_12px_12px_4px] border border-[#E4B8AE] bg-[#FDF3F1] px-3.5 py-3 text-[13.5px] text-danger">
          {turn.error}
        </div>
      )}

      {r && (
        <div className="mt-2 max-w-[95%]">
          {/* 계산 엔진 결과 스트립 — 답변 위 별도 블록으로 분리한다.
              AI가 산수한 게 아니라는 것을 시각적으로 보여주는 장치다. */}
          {r.calcStrip.length > 0 && (
            <div className="mb-2 rounded-[9px] border border-[#DCE5D8] bg-[#F3F6F2] px-3 py-2.5 text-[11.5px] leading-relaxed text-[#3D5240]">
              <span className="mb-1 block font-bold text-ok">
                계산 엔진 결과 (AI 미개입)
              </span>
              {r.calcStrip.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}

          <div
            className={`rounded-[12px_12px_12px_4px] border px-3.5 py-3 text-[13.5px] leading-relaxed ${
              r.refused
                ? "border-line-2 bg-[#F4F2ED] text-txt-2"
                : "border-line bg-paper-2 text-txt"
            }`}
          >
            {r.tier === "unrelated" && (
              <span className="mb-1.5 block text-[11px] font-bold text-amber-deep">
                이 서비스 범위 밖 · 답변 생성 중단
              </span>
            )}
            {r.tier === "documented" && (
              <span className="mb-1.5 inline-block rounded-full bg-[#E8F1EA] px-2 py-0.5 text-[10.5px] font-bold text-ok">
                공식 문서 근거 있음
              </span>
            )}
            {r.tier === "no_document" && (
              <span className="mb-1.5 inline-block rounded-full bg-[#EEF3F7] px-2 py-0.5 text-[10.5px] font-bold text-[#33546E]">
                계산 결과 기반 · 공식 문서에 근거 없음
              </span>
            )}
            {r.answer}

            {r.citations.length > 0 && (
              <div className="mt-2.5 border-t border-line pt-2.5">
                {r.citations.map((c) => (
                  <div
                    key={c.chunkId}
                    className="mb-1.5 text-[11px] leading-snug text-amber-deep"
                  >
                    <b>근거</b> · {c.provider} · {c.label}
                    {c.sourceType === "normalized" && (
                      <span className="text-txt-3"> (구성내역 정규화본)</span>
                    )}
                    <div className="mt-0.5 text-txt-3">{c.excerpt}</div>
                    {c.evidence && c.evidence.boxes.length > 0 && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => onToggleEvidence(c)}
                          aria-expanded={openEvidenceId === c.chunkId}
                          className={`rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition ${
                            openEvidenceId === c.chunkId
                              ? "border-amber bg-[#FBF1E4] text-amber-deep"
                              : "border-line-2 bg-paper-2 text-txt-2 hover:border-amber hover:text-amber-deep"
                          }`}
                        >
                          {openEvidenceId === c.chunkId
                            ? "원문 접기"
                            : "원문에서 확인"}
                        </button>

                        {/* 인라인 표시는 좁은 화면 전용.
                            데스크톱에서는 우측 패널이 같은 그림을 크게 띄운다. */}
                        {openEvidenceId === c.chunkId && (
                          <div className="mt-2 lg:hidden">
                            <EvidenceFigure
                              image={c.evidence.image}
                              aspect={c.evidence.aspect}
                              boxes={c.evidence.boxes}
                              label={c.label}
                              provider={c.provider}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {r.warnings.length > 0 && (
              <div className="mt-2 rounded-md border border-[#E4B8AE] bg-[#FDF3F1] px-2.5 py-2 text-[11px] text-danger">
                {r.warnings.map((w, i) => (
                  <div key={i}>확인 필요 · {w}</div>
                ))}
              </div>
            )}

            {r.degraded && !r.refused && (
              <div className="mt-2 text-[10.5px] text-txt-3">
                근거 기반 요약 모드로 생성됨 (AI 서술 미적용)
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#D3E0EA] bg-[#EEF3F7] px-2.5 py-1 text-[11px] font-semibold text-[#33546E]">
      {children}
    </span>
  );
}
