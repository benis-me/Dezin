const input = document.getElementById("url");
const status = document.getElementById("status");

chrome.storage.sync.get("dezinUrl", ({ dezinUrl }) => {
  input.value = dezinUrl || "http://localhost:5173";
});

document.getElementById("save").addEventListener("click", () => {
  const url = input.value.trim().replace(/\/+$/, "");
  chrome.storage.sync.set({ dezinUrl: url }, () => {
    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1500);
  });
});
