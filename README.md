# MEXC Stop Bot

A Chrome extension that adds one-click stop-loss buttons to the MEXC futures page: **move stop to breakeven** or **lock in +10 / 15 / 25% ROI**. It reads your open position directly from the exchange's data stream, calculates the stop price and fills in the TP/SL form for you.

## Features

- **Breakeven (BE) button** — sets the stop at the entry price plus a small buffer to cover trading fees
- **+ROI buttons** (10%, 15%, 25% by default) — set the stop at a price that locks in the chosen profit, taking leverage into account
- **Automatic position detection** — no manual input of entry price, side or leverage
- **Auto-confirm** of the TP/SL form, including "price too close" warnings (can be disabled)
- **Hotkeys**: `Alt+B` — breakeven, `Alt+1` / `Alt+2` / `Alt+3` — ROI levels
- Draggable panel with saved position and toast notifications

## How it works

1. The content script runs in the page context and intercepts **WebSocket**, **fetch** and **XHR** traffic of the exchange.
2. Incoming JSON is scanned recursively for position objects; entry price, side, leverage and volume are extracted and kept up to date.
3. When a button is pressed, the stop price is calculated:
   - Breakeven: `entry × (1 ± fee buffer)`
   - ROI level: `entry × (1 ± ROI% / leverage)`

   (`+` for long positions, `−` for short)
4. The extension opens the TP/SL form, enters the price into the React-controlled input and confirms it.

## Tech stack

- JavaScript (ES6+): async/await, Promises, Map/Set
- Chrome Extensions API, **Manifest V3** (content script in the `MAIN` world)
- WebSocket / fetch / XMLHttpRequest interception, JSON parsing
- DOM automation: programmatic input into React forms, simulated pointer, mouse and keyboard events
- `localStorage` for saving panel position

## Installation

1. Download or clone this repository:
   ```bash
   git clone https://github.com/yukiiyome/mexc-stop-bot.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Open a futures pair on MEXC with an open position — the panel will appear on the page.

## Configuration

Settings are at the top of `content.js`:

```js
const CONFIG = {
  PROFIT_LEVELS: [10, 15, 25],   // ROI levels for the buttons, %
  BU_FEE_BUFFER: 0.0008,         // breakeven fee buffer (0.08%); 0 = exact entry
  DEFAULT_LEVERAGE: 10,          // fallback leverage if it can't be detected
  AUTO_CONFIRM: true,            // confirm the TP/SL form automatically
  AUTO_CONFIRM_WARNINGS: true,   // also confirm "price too close" warnings
  HOTKEYS: true,                 // Alt+B, Alt+1/2/3
};
```

## Disclaimer

Use at your own risk. This tool automates actions in your trading account; always check the stop price before relying on it. It does not send any data anywhere and does not require API keys.

## Author

Telegram: [@cellbaker](https://t.me/cellbaker)
