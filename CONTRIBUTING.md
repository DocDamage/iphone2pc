# Contributing

Thanks for helping make selective iPhone file recovery safer and easier.

## Development setup

1. Use Windows 10 or 11 with Python 3.13.
2. Install Apple Devices or Apple's iTunes package for the official USB driver stack.
3. Run `python -m pip install -r requirements-dev.txt`.
4. Start the app with `python app.py`.
5. Open `http://127.0.0.1:8765`.

Hardware-dependent features should degrade cleanly when an iPhone, WinFsp, administrator rights, or an optional AI backend is unavailable.

## Pull requests

- Keep source files at or below 300 lines; split by responsibility when needed.
- Preserve original source bytes and make destructive operations explicit.
- Validate every path that crosses the PC/iPhone boundary.
- Never commit device catalogs, recovered files, keys, pairing tokens, traces, or runtime databases.
- Add regression tests for fixes and user-visible behaviors.
- Run `python -m pytest -q` and validate every file in `static/js` with `node --check`.

For visual changes, test desktop and 390 px mobile layouts, keyboard navigation, visible focus, reduced motion, and both themes.
