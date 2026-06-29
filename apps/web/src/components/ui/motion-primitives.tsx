import type { ReactNode } from "react";
import { motion, type Variants } from "motion/react";

const EASE = [0.25, 1, 0.5, 1] as const;

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0 },
};

/** Fade + lift in on mount. The canonical entrance for messages, sections, panels. */
export function FadeIn({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={fadeUp}
      transition={{ duration: 0.32, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/** A list whose children enter in a staggered cascade. Pair with <StaggerItem>. */
export function Stagger({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "ul" | "div" }) {
  const Comp = as === "ul" ? motion.ul : motion.div;
  return (
    <Comp
      className={className}
      initial="hidden"
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.045 } } }}
    >
      {children}
    </Comp>
  );
}

export function StaggerItem({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "li" | "div" }) {
  const Comp = as === "li" ? motion.li : motion.div;
  return (
    <Comp className={className} variants={fadeUp} transition={{ duration: 0.32, ease: EASE }}>
      {children}
    </Comp>
  );
}
