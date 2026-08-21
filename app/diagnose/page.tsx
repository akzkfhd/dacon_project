import { providers } from "@/lib/data";
import { providersWithPortfolios } from "@/lib/portfolios";
import TopBar from "@/app/TopBar";
import ProfileForm from "./ProfileForm";

/**
 * S2 입력 화면. 기본정보만 받고 챗봇(/chat)으로 넘긴다.
 *
 * 서버 컴포넌트로 사업자 목록만 넘기고, 입력 상태는 ProfileForm(클라이언트)이
 * 관리한다. 사업자 목록은 정적 데이터라 서버에서 읽는 편이 번들에 유리하다.
 */
export default function DiagnosePage() {
  // 구성상품 상세를 확보한 사업자를 앞에 둔다 — 이 사업자를 고르면
  // 가중평균 계산 과정까지 답변에 나온다.
  const withDetail = providersWithPortfolios;
  const others = providers
    .map((p) => p.name)
    .filter((n) => !withDetail.includes(n))
    .sort();

  return (
    <main className="mx-auto max-w-[430px] px-[22px] py-[26px] pb-10 lg:max-w-[560px]">
      <TopBar backHref="/" step={1} />
      <ProfileForm providersWithDetail={withDetail} otherProviders={others} />
    </main>
  );
}
