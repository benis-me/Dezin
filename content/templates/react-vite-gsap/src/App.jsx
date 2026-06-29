import { useEffect, useRef } from "react";
import { gsap } from "gsap";

/**
 * Starter component — replace with the real design. GSAP is wired and ready.
 * Compose the design from focused components in src/components/ when it grows.
 */
export default function App() {
  const root = useRef(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      gsap.from("[data-reveal]", { y: 24, opacity: 0, duration: 0.8, stagger: 0.08, ease: "power3.out" });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <main ref={root} style={{ minHeight: "100svh", display: "grid", placeItems: "center", padding: "24px" }}>
      <div style={{ maxWidth: "var(--container)", textAlign: "center" }}>
        <h1 data-reveal style={{ fontFamily: "var(--font-display)", fontSize: "clamp(2.5rem, 6vw, 4.5rem)", letterSpacing: "-0.03em", margin: 0 }}>
          Ready to build.
        </h1>
        <p data-reveal style={{ color: "var(--fg-2)", fontSize: "1.125rem", marginTop: "16px" }}>
          A Vite + React + GSAP project. Describe the design and Dezin builds it here.
        </p>
      </div>
    </main>
  );
}
