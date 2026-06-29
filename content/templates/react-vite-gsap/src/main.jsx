import React from "react";
import { createRoot } from "react-dom/client";
// Fonts via Fontsource (self-hosted, no network/availability worries). Swap to the
// design system's typeface, e.g. "@fontsource-variable/geist". Never rely on a font
// merely being installed on the machine.
import "@fontsource-variable/inter";
import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
