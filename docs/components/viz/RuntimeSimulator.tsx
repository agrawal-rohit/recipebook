"use client";

import { useEffect, useRef } from "react";
import { mountPlayer, type PlayerHandle } from "@/lib/viz/player";

export function RuntimeSimulator() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let handle: PlayerHandle | undefined;
    try {
      handle = mountPlayer(host);
    } catch (error) {
      host.textContent =
        error instanceof Error
          ? `Simulator failed to start: ${error.message}`
          : "Simulator failed to start.";
    }

    return () => {
      handle?.destroy();
    };
  }, []);

  return <div ref={hostRef} className="cheetos-viz" />;
}
