const BACKEND_URL = "http://localhost:3001/analyze-screenshot";
const MIN_CHAR_DELAY_MS = 40;
const ARM_DELAY_MS = 4000;
const DEBUGGER_VERSION = "1.3";

let activeRun = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isGoogleDoc(tab) {
  return Boolean(tab?.url && /^https:\/\/docs\.google\.com\/document\//.test(tab.url));
}

async function sendToTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    console.error("Failed to send message to tab:", error);
    return null;
  }
}

async function showOverlay(tabId, payload) {
  await sendToTab(tabId, payload);
}

function getDebuggerTarget(tabId) {
  return { tabId };
}

async function attachDebugger(tabId) {
  const target = getDebuggerTarget(tabId);
  await chrome.debugger.attach(target, DEBUGGER_VERSION);
  return target;
}

async function detachDebugger(target) {
  try {
    await chrome.debugger.detach(target);
  } catch {
    // Ignore detach errors during cleanup.
  }
}

async function sendDebuggerCommand(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function insertCharacterWithDebugger(target, char) {
  if (char === "\n") {
    await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      unmodifiedText: "\r",
      text: "\r"
    });
    await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    return;
  }

  await sendDebuggerCommand(target, "Input.insertText", {
    text: char
  });
}

function clearRunTimer() {
  if (activeRun?.timerId) {
    clearTimeout(activeRun.timerId);
  }
}

async function stopDripTyping(message, status = "stopped") {
  if (!activeRun) {
    return { ok: false, message: "No drip typing run is active." };
  }

  const tabId = activeRun.tabId;
  const debuggerTarget = activeRun.debuggerTarget;
  clearRunTimer();
  activeRun = null;
  if (debuggerTarget) {
    await detachDebugger(debuggerTarget);
  }
  await sendToTab(tabId, {
    type: "DOCS_RUN_STATUS",
    status,
    message
  });

  return { ok: true, message };
}

async function scheduleNextCharacter() {
  if (!activeRun) {
    return;
  }

  const currentRun = activeRun;
  const tab = await getActiveTab();

  if (!tab?.id || tab.id !== currentRun.tabId || !isGoogleDoc(tab)) {
    await stopDripTyping("Stopped because the Google Doc is no longer the active focused tab.", "failed");
    return;
  }

  if (currentRun.index >= currentRun.text.length) {
    await stopDripTyping("Drip typing completed.", "completed");
    return;
  }

  const nextChar = currentRun.text[currentRun.index];

  try {
    await insertCharacterWithDebugger(currentRun.debuggerTarget, nextChar);
  } catch (error) {
    console.error("Debugger typing failed:", error);
    await stopDripTyping("Could not type into Google Docs. Close DevTools for that tab and try again.", "failed");
    return;
  }

  currentRun.index += 1;

  if (currentRun.index === 1 || currentRun.index % 25 === 0) {
    await sendToTab(currentRun.tabId, {
      type: "DOCS_RUN_STATUS",
      status: "typing",
      message: `Typing into Google Docs... ${currentRun.index}/${currentRun.text.length}`
    });
  }

  currentRun.timerId = setTimeout(() => {
    void scheduleNextCharacter();
  }, currentRun.delayMs);
}

async function startDripTyping(payload) {
  const text = String(payload?.text ?? "");
  const durationMs = Number(payload?.durationMs ?? 0);
  const activeTab = await getActiveTab();

  if (!text.trim()) {
    return { ok: false, message: "Paste some text before starting." };
  }

  if (!durationMs || durationMs <= 0) {
    return { ok: false, message: "Duration must be greater than zero." };
  }

  if (!activeTab?.id || !isGoogleDoc(activeTab)) {
    return { ok: false, message: "Open the target Google Doc in the active tab before starting." };
  }

  if (activeRun) {
    return { ok: false, message: "A drip typing run is already active. Stop it before starting a new one." };
  }

  activeRun = {
    id: crypto.randomUUID(),
    tabId: activeTab.id,
    text,
    index: 0,
    delayMs: Math.max(MIN_CHAR_DELAY_MS, Math.floor(durationMs / text.length)),
    totalCharacters: text.length,
    timerId: null,
    armedUntil: Date.now() + ARM_DELAY_MS,
    debuggerTarget: null
  };

  await sendToTab(activeTab.id, {
    type: "DOCS_RUN_STATUS",
    status: "ready",
    message: "Drip typing armed. Click back into the Google Doc. Typing will begin in 4 seconds."
  });

  activeRun.timerId = setTimeout(async () => {
    if (!activeRun) {
      return;
    }

    try {
      activeRun.debuggerTarget = await attachDebugger(activeTab.id);
    } catch (error) {
      console.error("Debugger attach failed:", error);
      await stopDripTyping("Could not attach to the Google Doc. Close DevTools for that tab and try again.", "failed");
      return;
    }

    await sendToTab(activeTab.id, {
      type: "DOCS_RUN_STATUS",
      status: "typing",
      message: "Drip typing started."
    });

    void scheduleNextCharacter();
  }, ARM_DELAY_MS);

  return {
    ok: true,
    message: `Armed drip typing for ${text.length} characters. Click into the Google Doc within 4 seconds.`
  };
}

async function analyzeVisibleTab() {
  const tab = await getActiveTab();

  if (!tab?.id || !tab.windowId) {
    return;
  }

  await showOverlay(tab.id, {
    type: "SHOW_ANALYSIS_STATUS",
    message: "Analyzing screenshot..."
  });

  try {
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png"
    });

    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        screenshot: screenshotDataUrl
      })
    });

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`);
    }

    const data = await response.json();
    const answer = typeof data.answer === "string" ? data.answer.trim() : "";

    if (!answer) {
      throw new Error("Backend returned an empty answer");
    }

    await showOverlay(tab.id, {
      type: "SHOW_ANALYSIS_RESULT",
      answer
    });
  } catch (error) {
    console.error("Screenshot analysis failed:", error);
    await showOverlay(tab.id, {
      type: "SHOW_ANALYSIS_ERROR",
      message: "Sorry, screenshot analysis failed. Please try again."
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_DRIP_TYPING") {
    void startDripTyping(message.payload).then(sendResponse);
    return true;
  }

  if (message?.type === "STOP_DRIP_TYPING") {
    void stopDripTyping("Drip typing stopped by the user.", "stopped").then(sendResponse);
    return true;
  }

  if (message?.type === "GET_RUN_STATUS") {
    sendResponse({
      ok: true,
      running: Boolean(activeRun),
      message: activeRun ? "Drip typing is active." : "Ready.",
      progressLabel: activeRun ? `${activeRun.index}/${activeRun.totalCharacters}` : "0/0"
    });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "analyze-visible-tab") {
    await analyzeVisibleTab();
    return;
  }

  if (command === "open-drip-typing-popup") {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
      return;
    }

    const tab = await getActiveTab();
    if (tab?.id) {
      await sendToTab(tab.id, {
        type: "DOCS_RUN_STATUS",
        status: "ready",
        message: "Open the extension popup to start Google Docs drip typing."
      });
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeRun?.tabId === tabId) {
    void stopDripTyping("Stopped because the Google Doc tab was closed.", "failed");
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (activeRun?.tabId === tabId && changeInfo.status === "loading") {
    void stopDripTyping("Stopped because the Google Doc reloaded.", "failed");
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (activeRun?.debuggerTarget?.tabId === source.tabId) {
    void stopDripTyping("Stopped because the debugger detached from the Google Doc tab.", "failed");
  }
});
