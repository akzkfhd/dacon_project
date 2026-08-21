import Link from "next/link";
import { products, providers } from "@/lib/data";

/**
 * 임시 랜딩. S1 정식 화면은 별도 작업이며, 지금은 챗봇(/diagnose)으로
 * 들어가는 입구 역할만 한다. 숫자는 정적 데이터셋에서 직접 계산한다 —
 * 하드코딩하면 데이터가 갱신될 때 화면만 옛 수치로 남는다.
 */
export default function Home() {
  const totalAum = products.reduce((s, p) => s + (p.aum_total ?? 0), 0);
  const ultraLowAum = products
    .filter((p) => p.risk_label === "초저위험")
    .reduce((s, p) => s + (p.aum_total ?? 0), 0);
  const ultraLowPct = ((ultraLowAum / totalAum) * 100).toFixed(1);

  const mid = products
    .filter((p) => p.risk_label === "중위험" && p.return_1y !== null)
    .map((p) => p.return_1y as number);

  return (
    <main className="mx-auto max-w-[430px] px-[22px] py-[26px] pb-10 lg:max-w-[560px]">
      <div className="mb-2.5 text-xs font-bold tracking-[0.14em] text-amber-deep uppercase">
        퇴직연금 디폴트옵션
      </div>
      <h1 className="text-[27px] leading-[1.28] font-extrabold tracking-[-0.02em] text-ink">
        같은 &lsquo;중위험&rsquo;인데,
        <br />
        누구는 {Math.min(...mid).toFixed(2)}% 누구는{" "}
        <span className="text-amber">{Math.max(...mid).toFixed(2)}%</span>
      </h1>

      <div className="mt-5 rounded-[14px] border border-line bg-paper-2 p-[16px_18px]">
        <div className="text-[13px] text-txt-2">
          디폴트옵션 적립금 중 초저위험 상품 비중
        </div>
        <div className="mt-0.5 text-[15px] font-bold text-ink">
          {ultraLowPct}% — {(ultraLowAum / 1e12).toFixed(1)}조 원이 사실상 예금에
        </div>
        <div className="mt-1.5 text-[11px] text-txt-3">
          출처: 사전지정운용방법 상품별 비교공시 · 2026년 1분기 기준 · 상품{" "}
          {products.length}개 / 사업자 {providers.length}개
        </div>
      </div>

      <p className="mt-3 text-[15px] text-txt-2">
        라벨은 같은 것을 샀다고 말하지만, 실제로는 다른 것을 샀습니다.
        <br />
        내 상품이 무엇으로 구성되어 있는지 물어보세요.
      </p>

      <Link
        href="/diagnose"
        className="mt-[22px] block w-full rounded-[14px] bg-amber p-4 text-center text-base font-bold tracking-[-0.01em] text-white"
      >
        진단하고 물어보기 · 로그인 없음
      </Link>

      <p className="mt-4 text-[11.5px] leading-relaxed text-txt-3">
        본 서비스는 투자를 권유하지 않으며 정보 제공을 목적으로 합니다. 개인
        금융정보를 수집·저장하지 않습니다. 과거 수익률은 미래 수익을 보장하지
        않습니다.
      </p>
    </main>
  );
}
