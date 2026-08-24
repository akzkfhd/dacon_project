import { SUPPORTED_PROVIDERS } from "@/lib/profile";
import TopBar from "@/app/TopBar";
import ProfileForm from "./ProfileForm";

/**
 * S2 입력 화면. 기본정보만 받고 챗봇(/chat)으로 넘긴다.
 *
 * 서버 컴포넌트로 사업자 목록만 넘기고, 입력 상태는 ProfileForm(클라이언트)이
 * 관리한다.
 *
 * 사업자는 상품설명서를 확보한 6곳만 보여 준다. 전체 41곳을 나열하면
 * 자료 없는 곳을 고른 사용자가 무엇을 물어도 답을 못 받는다 —
 * 고를 수 있다는 것이 답할 수 있다는 뜻이어야 한다.
 */
export default function DiagnosePage() {
  return (
    <main className="mx-auto max-w-[430px] px-[22px] py-[26px] pb-10 lg:max-w-[560px]">
      <TopBar backHref="/" step={1} />
      <ProfileForm providers={[...SUPPORTED_PROVIDERS]} />
    </main>
  );
}
