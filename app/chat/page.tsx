import { hasApiKey } from "@/lib/claude";
import TopBar from "@/app/TopBar";
import ChatPanel from "./ChatPanel";

/**
 * 챗봇 화면(M4). 진단 입력은 /diagnose에서 받고 sessionStorage로 전달받는다.
 *
 * 서버 컴포넌트에서는 LLM 가용 여부만 넘긴다. 프로필은 서버가 알 수 없고,
 * 알아서도 안 된다 — 기획서 §4.4의 "서버 미저장" 원칙이다.
 */
export default function ChatPage() {
  return (
    <main className="mx-auto max-w-[430px] px-[22px] py-[26px] pb-10 lg:max-w-[1180px]">
      <TopBar backHref="/diagnose" backLabel="입력 화면으로" step={2} />
      <ChatPanel llmAvailable={hasApiKey()} />
    </main>
  );
}
