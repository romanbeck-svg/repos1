(function () {
  const ROOT_ID = "screenshot-problem-solver-root";

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);

    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.innerHTML = `
        <div class="sps-backdrop"></div>
        <section class="sps-card" role="dialog" aria-live="polite" aria-label="Extension status">
          <div class="sps-header">
            <h2>Extension Status</h2>
            <button class="sps-close" type="button" aria-label="Close">x</button>
          </div>
          <div class="sps-body"></div>
        </section>
      `;
      document.documentElement.appendChild(root);

      root.querySelector(".sps-close").addEventListener("click", hideRoot);
      root.querySelector(".sps-backdrop").addEventListener("click", hideRoot);
    }

    return root;
  }

  function hideRoot() {
    const root = document.getElementById(ROOT_ID);
    if (root) {
      root.classList.remove("visible");
    }
  }

  function showMessage(text, tone, title) {
    const root = ensureRoot();
    const heading = root.querySelector(".sps-header h2");
    const body = root.querySelector(".sps-body");
    heading.textContent = title || "Extension Status";
    body.textContent = text;
    body.className = `sps-body ${tone || ""}`.trim();
    root.classList.add("visible");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SHOW_ANALYSIS_STATUS") {
      showMessage(message.message || "Working...", "is-status", "Screen Analysis");
      return;
    }

    if (message?.type === "SHOW_ANALYSIS_RESULT") {
      showMessage(message.answer || "No answer returned.", "is-result", "Screen Analysis");
      return;
    }

    if (message?.type === "SHOW_ANALYSIS_ERROR") {
      showMessage(message.message || "Something went wrong.", "is-error", "Screen Analysis");
      return;
    }

    if (message?.type === "DOCS_RUN_STATUS") {
      showMessage(message.message || "Google Docs drip typing update.", message.status === "failed" ? "is-error" : "is-status", "Google Docs Drip Typing");
      return;
    }

    if (message?.type === "DOCS_CHECK_READY" || message?.type === "DOCS_INSERT_TEXT_CHUNK") {
      sendResponse({ ok: false, message: "Google Docs text insertion is now handled in the background debugger pipeline." });
    }
  });
})();
