# Token Usage Tracker (Modified)

![Extension Screenshot](1.png)

A SillyTavern extension that tracks and visualizes token usage and price for your chats. This is a modified version with additional features.

## Installation

1.  Open SillyTavern and navigate to the **Extensions** menu (blocks icon).
2.  Click on **Install Extension**.
3.  Paste the repository URL into the "Extension URL" field:
    ```
    https://github.com/bla6987/ST_Token_Modified
    ```
4.  Click **Install for all users** or **Install just for me**.

## Features

### Compact Miniview
- Floating panel with glassmorphism styling
- Toggle via `/tokenmini` slash command or header button
- Session, hourly, and daily data views
- Pin functionality to keep the panel visible
- **Drag-and-drop** positioning by dragging the header
- **Resizable** from bottom-left corner handle
- Position and size persistence in settings
- Supports mouse and touch events

### Token Tracking
- Real-time token usage tracking
- **Reasoning/thinking token tracking** with 🧠 indicator
- Per-chat usage statistics via `/tokenchat` command
- Cost calculation based on model pricing

### Charts & Visualization
- Daily and hourly usage charts
- Multiple time range options: **1D (Today)**, 7D, 30D, 90D
- Improved hourly chart readability

### Time Synchronization
- External time sync with worldtimeapi.org for Eastern timezone
- 5-minute auto-resync interval for time drift correction
- Timezone-aware date operations using Intl.DateTimeFormat

### Code Improvements
- Centralized `getCurrentChatId()` helper function
- Mini token counter in extension header

## Usage

Once installed, the extension will automatically start tracking token usage. The GUI will be in the extensions menu.

- Use `/tokenmini` to toggle the compact miniview
- Use `/tokenchat` to view current chat statistics

## Credits

Based on [Extension-TokenUsage](https://github.com/Vibecoder9000/Extension-TokenUsage) by Vibecoder9000.

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See the `LICENSE` file for details.
