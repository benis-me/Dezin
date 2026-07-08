/**
 * Starter component — replace with the real design. Compose the design from focused
 * components in src/components/ when it grows.
 *
 * The `data-reveal` entrance is plain CSS (see index.css) so nothing is pre-committed to
 * one animation library: reach for `motion` (from `motion/react`) for React component/UI
 * motion, or `gsap` for scroll/timeline choreography — both are installed — and add more as
 * the design needs. Keep all motion behind `prefers-reduced-motion`.
 */
export default function App() {
  return (
    <main style={{ minHeight: "100svh", display: "grid", placeItems: "center", padding: "24px" }}>
      <div style={{ maxWidth: "var(--container)", textAlign: "center" }}>
        <h1 data-reveal style={{ fontFamily: "var(--font-display)", fontSize: "clamp(2.5rem, 6vw, 4.5rem)", letterSpacing: "-0.03em", margin: 0 }}>
          Ready to build.
        </h1>
        <p data-reveal style={{ color: "var(--fg-2)", fontSize: "1.125rem", marginTop: "16px" }}>
          A Vite + React project. Describe the design and Dezin builds it here.
        </p>
      </div>
    </main>
  );
}
