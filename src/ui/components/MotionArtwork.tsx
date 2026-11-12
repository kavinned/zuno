import { useEffect, useRef } from "react";
import type Hls from "hls.js";
import type { AppleMotion } from "../../datasource/apple/motion";

/**
 * The motion clip itself: HLS in a muted looping video.
 *
 * Fades in only after the first real frame so the static artwork stays visible while the
 * stream starts — a black rectangle where the cover was reads as a broken image. On a fatal
 * playback error it tries the fallback rendition once, then reports upward so the caller can
 * put the static cover back.
 */
export function MotionArtwork({
  motion,
  playing,
  className,
  onUnavailable,
}: {
  motion: AppleMotion;
  playing: boolean;
  className?: string;
  onUnavailable?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onUnavailableRef = useRef(onUnavailable);

  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let disposed = false;
    let hls: Hls | null = null;
    let currentUrl: string | null = null;
    let usedFallback = false;

    const fail = () => {
      if (disposed) return;
      if (!usedFallback && motion.fallbackUrl && motion.fallbackUrl !== currentUrl) {
        usedFallback = true;
        void attach(motion.fallbackUrl);
        return;
      }
      disposed = true;
      onUnavailableRef.current?.();
    };

    const attach = async (url: string) => {
      currentUrl = url;
      const { default: HlsPlayer } = await import("hls.js");
      if (disposed) return;

      if (HlsPlayer.isSupported()) {
        hls = new HlsPlayer({
          capLevelToPlayerSize: true,
          maxBufferLength: 10,
          enableWorker: true,
        });
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          hls?.destroy();
          hls = null;
          fail();
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        void video.play().catch(() => {});
      } else {
        fail();
      }
    };

    const onError = () => fail();
    /* The first decoded frame, not the first play: opening the split while audio is paused must
       still show the clip's frame rather than an empty slot. */
    const onReady = () => video.setAttribute("data-ready", "");

    video.removeAttribute("data-ready");
    video.addEventListener("error", onError);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("playing", onReady);
    void attach(motion.url);

    return () => {
      disposed = true;
      hls?.destroy();
      video.removeEventListener("error", onError);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("playing", onReady);
      video.removeAttribute("src");
      video.removeAttribute("data-ready");
      video.load();
    };
  }, [motion.url, motion.fallbackUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, [playing, motion.url]);

  return (
    <video
      ref={videoRef}
      className={className}
      muted
      loop
      playsInline
      autoPlay={playing}
      aria-hidden="true"
    />
  );
}
