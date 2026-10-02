"use client";

import { useEffect, useRef, useState } from "react";

type RevealProps = {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "section" | "span" | "h2" | "p";
  threshold?: number;
  once?: boolean;
};

export function Reveal({
  children,
  className = "",
  delay = 0,
  as: Tag = "div",
  threshold = 0,
  once = true,
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      setVisible(true);
      if (once) return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            if (once) io.unobserve(entry.target);
          } else if (!once) {
            setVisible(false);
          }
        }
      },
      { threshold, rootMargin: "0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [threshold, once]);

  return (
    <Tag
      ref={ref as React.Ref<never>}
      style={{ animationDelay: visible ? `${delay}ms` : undefined }}
      className={`${className} ${visible ? "animate-fade-up" : "opacity-0 translate-y-6"} motion-reduce:opacity-100 motion-reduce:translate-y-0 motion-reduce:animate-none`}
    >
      {children}
    </Tag>
  );
}
