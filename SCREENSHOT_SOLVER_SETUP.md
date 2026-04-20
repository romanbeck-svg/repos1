# Screenshot Problem Solver Setup

This implementation is split into two parts:

- `chrome-extension/` -> the Manifest V3 browser extension
- `backend/` -> the Node.js/Express backend that calls the OpenAI Responses API

## 1. Start the backend

From `backend/`:

```powershell
npm install
Copy-Item .env.example .env
```

Put your OpenAI API key into `.env`, then run:

```powershell
npm run dev
```

The backend will start on `http://localhost:3001`.

## 2. Load the extension

In Chrome:

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select the `chrome-extension` folder

In Brave:

1. Open `brave://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select the `chrome-extension` folder

## 3. Use the shortcut

Press `Ctrl+Shift+S`.

What happens:

1. The extension captures the visible tab using `chrome.tabs.captureVisibleTab`
2. The background service worker sends the screenshot to `POST /analyze-screenshot`
3. The backend calls the OpenAI Responses API with the screenshot and the troubleshooting instruction
4. The extension shows only the model's final answer in an on-page overlay

## 4. Change the backend URL

If your backend is not running at `http://localhost:3001`, update this line in `chrome-extension/background.js`:

```js
const BACKEND_URL = "http://localhost:3001/analyze-screenshot";
```

Then reload the extension.

## Notes

- The OpenAI API key stays only on the backend
- The extension never opens ChatGPT and never pastes anything into the browser
- The user only sees the final answer or a short failure message
