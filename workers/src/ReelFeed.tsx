import { useEffect, useRef, useCallback, useState } from "react";

interface Reel {
    index: number;
    url: string;
}

interface ReelFeedProps {
    reels: Reel[];
}

export default function ReelFeed({ reels }: ReelFeedProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
    const currentIndexRef = useRef(0);
    // Track whether user has clicked to unmute (autoplay may require muted start)
    const [muted, setMuted] = useState(false);
    const [paused, setPaused] = useState<Record<number, boolean>>({});
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Scroll the container to a specific reel index
    // +1 offset because children[0] is the sticky control bar
    const scrollToIndex = useCallback((index: number) => {
        const container = containerRef.current;
        if (!container) return;
        const slot = container.children[index + 1] as HTMLElement | undefined;
        slot?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, []);

    // Arrow key navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't hijack arrow keys if user is typing in an input/textarea
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

            if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                e.preventDefault();
                const next = Math.min(currentIndexRef.current + 1, reels.length - 1);
                currentIndexRef.current = next;
                scrollToIndex(next);
            } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                e.preventDefault();
                const next = Math.max(currentIndexRef.current - 1, 0);
                currentIndexRef.current = next;
                scrollToIndex(next);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [reels.length, scrollToIndex]);

    // IntersectionObserver: auto-play visible video, pause + reset others
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const observers: IntersectionObserver[] = [];

        videoRefs.current.forEach((video, index) => {
            if (!video) return;

            const observer = new IntersectionObserver(
                (entries) => {
                    const entry = entries[0];
                    if (!entry) return;
                    if (entry.isIntersecting) {
                        // Reset to start and play
                        video.currentTime = 0;
                        video.muted = muted;
                        const playPromise = video.play();
                        if (playPromise !== undefined) {
                            playPromise.catch(() => {
                                // Autoplay blocked — retry muted
                                video.muted = true;
                                setMuted(true);
                                video.play().catch(() => {});
                            });
                        }
                        currentIndexRef.current = index;
                        setPaused((prev) => ({ ...prev, [index]: false }));
                    } else {
                        video.pause();
                        video.currentTime = 0;
                    }
                },
                {
                    root: container,
                    threshold: 0.6,
                },
            );

            observer.observe(video);
            observers.push(observer);
        });

        return () => observers.forEach((o) => o.disconnect());
    }, [reels, muted]);

    // Click on video to toggle play/pause
    const handleVideoClick = useCallback(
        (index: number) => {
            const video = videoRefs.current[index];
            if (!video) return;
            if (video.paused) {
                video.play().catch(() => {});
                setPaused((prev) => ({ ...prev, [index]: false }));
            } else {
                video.pause();
                setPaused((prev) => ({ ...prev, [index]: true }));
            }
        },
        [],
    );

    // Toggle mute
    const handleMuteToggle = useCallback(() => {
        const newMuted = !muted;
        setMuted(newMuted);
        videoRefs.current.forEach((video) => {
            if (video) video.muted = newMuted;
        });
    }, [muted]);

    // Toggle fullscreen
    const handleFullscreen = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        if (!document.fullscreenElement) {
            container.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
        } else {
            document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
        }
    }, []);

    // Sync fullscreen state when user exits via Escape key
    useEffect(() => {
        const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener("fullscreenchange", onFsChange);
        return () => document.removeEventListener("fullscreenchange", onFsChange);
    }, []);

    return (
        <div
            ref={containerRef}
            className={`${isFullscreen ? "h-screen" : "h-[80vh]"} overflow-y-scroll snap-y snap-mandatory rounded-2xl bg-black scrollbar-hide relative`}
            tabIndex={-1}
        >
            {/* Control buttons - fixed in top-right of the scroll container */}
            <div className="sticky top-0 z-20 flex justify-end pointer-events-none">
                <div className="flex gap-2 p-3 pointer-events-auto">
                    {/* Mute / Unmute */}
                    <button
                        onClick={handleMuteToggle}
                        className="w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
                        title={muted ? "Unmute" : "Mute"}
                    >
                        {muted ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <line x1="23" y1="9" x2="17" y2="15" />
                                <line x1="17" y1="9" x2="23" y2="15" />
                            </svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                            </svg>
                        )}
                    </button>
                    {/* Download current reel */}
                    <a
                        href={reels[currentIndexRef.current]?.url ?? "#"}
                        download
                        onClick={(e) => {
                            const url = reels[currentIndexRef.current]?.url;
                            if (!url) { e.preventDefault(); return; }
                            // Force download via blob to avoid navigating away
                            e.preventDefault();
                            fetch(url)
                                .then((r) => r.blob())
                                .then((blob) => {
                                    const a = document.createElement("a");
                                    a.href = URL.createObjectURL(blob);
                                    a.download = `reel-${currentIndexRef.current + 1}.mp4`;
                                    a.click();
                                    URL.revokeObjectURL(a.href);
                                })
                                .catch(() => {});
                        }}
                        className="w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors cursor-pointer"
                        title="Download"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                    </a>
                    {/* Fullscreen toggle */}
                    <button
                        onClick={handleFullscreen}
                        className="w-9 h-9 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
                        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    >
                        {isFullscreen ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                                <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                                <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                                <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                            </svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                                <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                                <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                            </svg>
                        )}
                    </button>
                </div>
            </div>

            {reels.map((reel, i) => (
                <div
                    key={reel.index}
                    className="h-full snap-start snap-always flex items-center justify-center bg-black relative"
                >
                    <video
                        ref={(el) => {
                            videoRefs.current[i] = el;
                        }}
                        src={reel.url}
                        playsInline
                        loop
                        preload="metadata"
                        className="h-full max-w-full object-contain cursor-pointer"
                        onClick={() => handleVideoClick(i)}
                    />
                    {/* Play icon overlay when paused */}
                    {paused[i] && (
                        <div
                            className="absolute inset-0 flex items-center justify-center pointer-events-none"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="white" fillOpacity="0.7" stroke="none">
                                <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
