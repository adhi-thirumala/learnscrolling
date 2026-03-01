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

    // Scroll the container to a specific reel index
    const scrollToIndex = useCallback((index: number) => {
        const container = containerRef.current;
        if (!container) return;
        const slot = container.children[index] as HTMLElement | undefined;
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

    // Click on video to toggle mute
    const handleVideoClick = useCallback(
        (index: number) => {
            const video = videoRefs.current[index];
            if (!video) return;
            const newMuted = !video.muted;
            video.muted = newMuted;
            setMuted(newMuted);
        },
        [],
    );

    return (
        <div
            ref={containerRef}
            className="h-[80vh] overflow-y-scroll snap-y snap-mandatory rounded-2xl bg-black scrollbar-hide"
            tabIndex={-1}
        >
            {reels.map((reel, i) => (
                <div
                    key={reel.index}
                    className="h-full snap-start snap-always flex items-center justify-center bg-black"
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
                </div>
            ))}
        </div>
    );
}
