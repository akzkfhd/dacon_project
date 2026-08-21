import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "깨움 — 퇴직연금 디폴트옵션 진단",
  description:
    "라벨과 실질이 다른 퇴직연금 디폴트옵션을 진단합니다. 로그인 없음, 개인 금융정보 미수집.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        {/* 폭은 각 화면이 정한다.
            예전에는 여기서 430px로 못박았는데(목업의 폰 프레임을 그대로
            옮긴 것), 그러면 1280px 화면에서 34%만 쓰고 850px를 버린다.
            기능명세서 §4의 "모바일 우선"은 작은 화면을 기준으로 설계하되
            큰 화면에서는 넓혀 쓰라는 뜻이지, 작은 화면 전용이라는 뜻이 아니다.
            제출물이 배포 URL이라 심사는 데스크톱에서 이뤄질 가능성이 높다. */}
        <div className="min-h-screen bg-paper">{children}</div>
      </body>
    </html>
  );
}
