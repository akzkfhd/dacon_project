"use client";

import { useMemo, useState } from "react";

/**
 * 원문 페이지 이미지 위에 근거 구절을 형광펜으로 표시하는 순수 표시 컴포넌트.
 *
 * 열고 닫는 상태는 갖지 않는다 — 모바일(인라인)과 데스크톱(우측 패널)이
 * 같은 그림을 서로 다른 자리에서 쓰기 때문에, 표시 여부는 호출부가 정한다.
 *
 * ■ 왜 이미지 + 좌표인가
 *   PDF.js를 런타임에 띄우면 번들이 1MB 넘게 늘고 모바일에서 무겁다.
 *   빌드 타임(scripts/06_render_evidence.py)에 페이지를 PNG로 굽고
 *   0~1 정규화 좌표만 넘기면 런타임 의존성이 0이다.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function EvidenceFigure({
  image,
  aspect,
  boxes,
  label,
  provider,
  /** 좁은 화면에서는 인용 부분만 확대해 보여주는 것이 기본이다. */
  defaultWhole = false,
}: {
  image: string;
  /** 페이지 높이/너비. 문서마다 다르다(실측 1.412~1.445). */
  aspect: number;
  boxes: Box[];
  label: string;
  provider: string;
  defaultWhole?: boolean;
}) {
  const [whole, setWhole] = useState(defaultWhole);

  // 하이라이트 전체를 감싸는 영역. 확대 보기의 기준이 된다.
  const span = useMemo(() => {
    const y0 = Math.min(...boxes.map((b) => b.y));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    return { y0, y1 };
  }, [boxes]);

  // 하이라이트 위아래로 약간의 문맥을 남긴다. 문장만 덜렁 보이면
  // 어떤 표·항목에 속한 내용인지 알 수 없다.
  const pad = 0.035;
  const viewTop = Math.max(0, span.y0 - pad);
  const viewBottom = Math.min(1, span.y1 + pad);
  const viewH = Math.max(0.06, viewBottom - viewTop);

  return (
    <div>
      {/* padding-top 퍼센트는 '컨테이너 폭' 기준이므로 페이지 종횡비를 곱해야
          실제 높이가 된다. 종횡비는 페이지마다 데이터로 받는다 — A4로
          가정하면 1.445짜리 문서(48장)에서 크롭 위치가 어긋난다. */}
      <div
        className="relative overflow-hidden rounded-[8px] border border-line bg-white"
        style={{ paddingTop: `${(whole ? aspect : viewH * aspect) * 100}%` }}
      >
        {/* 이미지와 하이라이트를 같은 좌표계에 놓고 통째로 이동시킨다.
            whole=false면 잘라낸 구간이 컨테이너 상단에 오도록 위로 민다.

            주의: translateY의 퍼센트는 '컨테이너'가 아니라 '자기 자신의
            높이'(=페이지 전체 높이) 기준이다. 따라서 페이지 상단에서
            viewTop 비율만큼 내려간 지점을 맞추려면 그대로 viewTop을 쓴다.
            viewH로 나누면 1/viewH 배(보통 4배 이상) 과하게 밀려
            하이라이트가 통째로 화면 밖으로 사라진다. */}
        <div
          className="absolute inset-x-0 top-0"
          style={whole ? undefined : { transform: `translateY(-${viewTop * 100}%)` }}
        >
          {/* aspectRatio를 명시해 이미지 로드 전에도 높이를 갖게 한다.
              하이라이트가 이 박스를 기준으로 배치되므로, 높이가 0이면
              형광펜이 한 점으로 뭉쳤다가 튀는 레이아웃 흔들림이 생긴다. */}
          <div className="relative" style={{ aspectRatio: `1 / ${aspect}` }}>
            {/* 페이지 이미지는 정적 자산이라 next/image의 최적화가 필요 없다.
                img를 쓰면 서버리스 이미지 변환도 타지 않는다.
                loading="lazy"는 쓰지 않는다 — 사용자가 '원문에서 확인'을
                눌러야 마운트되므로 이미 온디맨드다. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image}
              alt={`${provider} ${label} 원문 페이지`}
              className="block w-full"
            />
            {boxes.map((b, i) => (
              <span
                key={i}
                aria-hidden
                className="absolute rounded-[2px] bg-amber/30 ring-1 ring-amber/60"
                style={{
                  left: `${b.x * 100}%`,
                  top: `${b.y * 100}%`,
                  width: `${b.w * 100}%`,
                  height: `${b.h * 100}%`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setWhole((v) => !v)}
          className="text-[11px] font-semibold text-amber-deep underline underline-offset-2"
        >
          {whole ? "인용 부분만 보기" : "전체 페이지 보기"}
        </button>
        <span className="text-[10.5px] text-txt-3">
          형광펜 표시가 답변의 근거 구절입니다
        </span>
      </div>
    </div>
  );
}
