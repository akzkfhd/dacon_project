import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // lib/data.ts·lib/portfolios.ts는 이 파일들을 런타임에 fs로 읽는다.
  // 경로를 문자열로 조립하므로 번들러의 정적 추적이 따라가지 못한다.
  // → 서버리스 함수에 함께 올라가도록 명시한다.
  //
  // 와일드카드(./data/*.json)를 쓰면 안 된다. data/ 트리 전체가 딸려 들어가
  // 런타임이 읽지도 않는 extracted/·raw/ 1.8MB까지 함수에 포함됐다.
  // 게다가 그 둘은 gitignore라 Vercel 빌드 환경에는 존재하지도 않는다.
  // 읽는 파일만 정확히 나열한다.
  outputFileTracingIncludes: {
    "/api/ask": [
      "./data/products.json",
      "./data/providers.json",
      "./data/assumptions.json",
      "./data/chunks.json",
      "./data/portfolios.json",
    ],
  },

  // 추적기는 readFileSync(동적 경로)를 만나면 그 디렉터리 전체를 보수적으로
  // 끌어온다. 그래서 런타임이 읽지도 않는 extracted/·raw/까지 함수에
  // 들어갔다(1.8MB). 이 둘은 빌드 입력물이고 gitignore 대상이라
  // Vercel 빌드 환경에는 아예 없다. 명시적으로 제외한다.
  outputFileTracingExcludes: {
    "/api/ask": ["./data/extracted/**", "./data/raw/**"],
  },
};

export default nextConfig;
