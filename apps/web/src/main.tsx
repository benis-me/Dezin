import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import App from "./App.tsx";
import { ApiProvider } from "./lib/api-context.tsx";
import { AgentsProvider } from "./lib/agents-context.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { native } from "./lib/native.ts";
import { applyThemePreference, readThemePreference } from "./lib/theme.ts";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "./styles/globals.css";

// Dark-first: design tools look most premium dark. Set before first paint (no flash).
applyThemePreference(readThemePreference());

// Light up native chrome (draggable regions, traffic-light clearance) inside Electron.
if (native?.isElectron) {
  document.documentElement.classList.add("electron");
  if (native.platform === "darwin") document.documentElement.classList.add("electron-mac");
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
      <ApiProvider>
        <AgentsProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AgentsProvider>
      </ApiProvider>
    </MotionConfig>
  </StrictMode>,
);
