import { forget, pair } from "./dezin-client.js";

const input = document.getElementById("url");
const status = document.getElementById("status");
const pairCode = document.getElementById("pair-code");
const pairButton = document.getElementById("pair");
const forgetButton = document.getElementById("forget");
const pairState = document.getElementById("pair-state");

function setState(state, message = "") {
  document.body.dataset.state = state;
  pairButton.disabled = state === "pairing";
  pairState.innerHTML =
    state === "paired"
      ? "<strong>Paired.</strong> Capture and Analyze are ready."
      : state === "pairing"
        ? "<strong>Pairing…</strong> Checking the one-time code."
        : "<strong>Unpaired.</strong> Generate a code in Dezin Settings.";
  status.textContent = message;
}

chrome.storage.sync.get("dezinUrl").then(({ dezinUrl }) => {
  input.value = dezinUrl || "http://127.0.0.1:7457";
});

chrome.storage.local.get("dezinCredential").then(({ dezinCredential }) => {
  setState(dezinCredential?.token ? "paired" : "unpaired");
});

document.getElementById("save").addEventListener("click", async () => {
  const url = input.value.trim().replace(/\/+$/, "");
  await chrome.storage.sync.set({ dezinUrl: url });
  status.textContent = "URL saved.";
  setTimeout(() => (status.textContent = ""), 1500);
});

pairButton.addEventListener("click", async () => {
  const code = pairCode.value.trim();
  if (!code) return setState("error", "Enter the pairing code from Dezin Settings.");
  setState("pairing");
  try {
    await pair(code);
    pairCode.value = "";
    setState("paired", "Paired successfully.");
  } catch (error) {
    setState("error", error instanceof Error ? error.message : String(error));
  }
});

forgetButton.addEventListener("click", async () => {
  await forget();
  setState("unpaired", "Credential removed.");
});
