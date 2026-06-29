import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import App from "./App.tsx";
import { ApiProvider } from "./lib/api-context.tsx";
import { AgentsProvider } from "./lib/agents-context.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { native } from "./lib/native.ts";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "./styles/globals.css";

// Dark-first: design tools look most premium dark. Set before first paint (no flash).
const saved = localStorage.getItem("dezin.theme");
if (saved !== "light") document.documentElement.classList.add("dark");

// Light up native chrome (draggable regions, traffic-light clearance) inside Electron.
if (native?.isElectron) {
  document.documentElement.classList.add("electron");
  if (native.platform === "darwin") document.documentElement.classList.add("electron-mac");
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
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
