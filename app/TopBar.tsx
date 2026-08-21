import Link from "next/link";

/**
 * 상단 바 + 진행 표시.
 * 입력(1) → 챗봇(2)으로 화면이 나뉘면서, 사용자가 지금 어느 단계인지와
 * 되돌아갈 곳이 어디인지 보여줄 필요가 생겼다.
 */
export default function TopBar({
  backHref,
  backLabel = "뒤로",
  step,
  totalSteps = 2,
}: {
  backHref: string;
  backLabel?: string;
  step: number;
  totalSteps?: number;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line pb-3">
      <Link
        href={backHref}
        aria-label={backLabel}
        className="text-[22px] leading-none text-txt-2"
      >
        ‹
      </Link>
      <span className="text-base font-bold tracking-[-0.02em] text-ink">
        깨움<span className="text-amber">.</span>
      </span>
      <div className="ml-auto flex gap-[5px]" aria-label={`${totalSteps}단계 중 ${step}단계`}>
        {Array.from({ length: totalSteps }, (_, i) => (
          <i
            key={i}
            className={`h-[3px] w-[22px] rounded-sm transition ${
              i < step ? "bg-amber" : "bg-line-2"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
