# Local Browser Agent

A browser-native, fully local agent for Chromium. The extension will load small open-weight models once into browser-managed storage, reduce the active page to a compact semantic observation, choose validated actions locally, and manipulate the page without a cloud API.

**Status:** architecture + extension shell. The shell can be loaded unpacked, opened with the toolbar button / shortcut, and produces a compact observation of interactive DOM elements. Laya and Qwen inference are specified but deliberately not faked in this first commit.

## Intended model split

- **Laya** — fast typed decisions: action, target, confidence, strategy and confirmation classification.
- **Qwen3-0.6B** — language: goal decomposition, short plans, text to type, summaries and explanations.
- Both remain behind provider interfaces so checkpoints/runtimes can be replaced.

## Development

Load `extensions/local-browser-agent` unpacked from `chrome://extensions`. Open any normal web page and click the extension action (or press Cmd+Shift+L on macOS). "Observe page" shows the exact compact representation that will be sent to the local decision provider.

No page text is executed as code. The action executor described in the spec accepts only a closed set of typed actions.

See [spec/README.md](spec/README.md) for the full design.
