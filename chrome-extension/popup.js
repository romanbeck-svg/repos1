const DRAFT_KEY = "docs-drip-typing-draft";
const textInput = document.getElementById("drip-text");
const minutesInput = document.getElementById("minutes");
const secondsInput = document.getElementById("seconds");
const startButton = document.getElementById("start-btn");
const stopButton = document.getElementById("stop-btn");
const statusElement = document.getElementById("status");

function setStatus(message, tone) {
  statusElement.textContent = message;
  statusElement.className = "popup-status";
  if (tone) {
    statusElement.classList.add(tone);
  }
}

function getDurationMs() {
  const minutes = Number(minutesInput.value || 0);
  const seconds = Number(secondsInput.value || 0);
  return (minutes * 60 + seconds) * 1000;
}

async function saveDraft() {
  await chrome.storage.local.set({
    [DRAFT_KEY]: {
      text: textInput.value,
      minutes: minutesInput.value,
      seconds: secondsInput.value
    }
  });
}

async function loadDraft() {
  const result = await chrome.storage.local.get(DRAFT_KEY);
  const draft = result[DRAFT_KEY];
  if (!draft) {
    return;
  }

  textInput.value = draft.text || "";
  minutesInput.value = draft.minutes || "1";
  secondsInput.value = draft.seconds || "0";
}

async function refreshRunStatus() {
  const response = await chrome.runtime.sendMessage({ type: "GET_RUN_STATUS" });
  if (!response?.ok) {
    setStatus("Ready.");
    return;
  }

  if (response.running) {
    setStatus(`Typing into Google Docs: ${response.progressLabel}`, "is-success");
  } else {
    setStatus(response.message || "Ready.");
  }
}

textInput.addEventListener("input", () => void saveDraft());
minutesInput.addEventListener("input", () => void saveDraft());
secondsInput.addEventListener("input", () => void saveDraft());

startButton.addEventListener("click", async () => {
  const text = textInput.value;
  const durationMs = getDurationMs();

  if (!text.trim()) {
    setStatus("Paste some text before starting.", "is-error");
    return;
  }

  if (!durationMs || durationMs <= 0) {
    setStatus("Choose a duration greater than zero.", "is-error");
    return;
  }

  await saveDraft();

  const response = await chrome.runtime.sendMessage({
    type: "START_DRIP_TYPING",
    payload: {
      text,
      durationMs
    }
  });

  if (!response?.ok) {
    setStatus(response?.message || "Could not start drip typing.", "is-error");
    return;
  }

  setStatus(response.message || "Drip typing armed.", "is-success");
  setTimeout(() => {
    window.close();
  }, 150);
});

stopButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "STOP_DRIP_TYPING" });
  setStatus(response?.message || "Stopped.", response?.ok ? undefined : "is-error");
});

void loadDraft();
void refreshRunStatus();
setInterval(() => {
  void refreshRunStatus();
}, 750);
