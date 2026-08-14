# Installation

The installer requires Git, Python 3 for Ultracode's runtime hooks, and the CLI for each selected harness.

## Quick local install

Install both harnesses:

```bash
curl -fsSL https://raw.githubusercontent.com/diepquynh/ultracode/main/install.sh | bash
```

Select one harness explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/diepquynh/ultracode/main/install.sh | bash -s -- claude
curl -fsSL https://raw.githubusercontent.com/diepquynh/ultracode/main/install.sh | bash -s -- codex
```

From a checkout, use `bash install.sh` for both or pass `claude`/`codex` for one. The script keeps an updatable
checkout under `${XDG_DATA_HOME:-$HOME/.local/share}/ultracode`; override it with `ULTRACODE_INSTALL_DIR`.
Pass `--dry-run` when running the local script to preview the workflow.

After a Claude Code install, restart Claude Code. After a Codex install, start a new session, open `/hooks`,
and trust Ultracode's hooks; start one more session so the `SessionStart` hook runs. Codex intentionally does
not trust plugin hooks automatically, so initialization reminders and profile model enforcement remain inactive
until then.

## Claude Code manual install

The generated Claude marketplace root is `dist/claude/ultracode`:

```bash
claude plugin marketplace add ./dist/claude/ultracode
claude plugin install ultracode@ultracode
```

Local marketplaces do not auto-update. After regenerating, run:

```bash
claude plugin marketplace update ultracode
claude plugin update ultracode@ultracode
```

For active development, bypass installation for one session:

```bash
claude --plugin-dir /absolute/path/to/ultracode/dist/claude/ultracode
```

Published marketplaces use the same `claude plugin marketplace add <owner/repo-or-url>` and
`claude plugin install ultracode@<marketplace>` flow.

## Codex manual install

Codex installs plugins from marketplaces and has no Claude-style `--plugin-dir` option. Stage
`dist/codex/ultracode` beneath a local marketplace, with this manifest at
`<marketplace>/.agents/plugins/marketplace.json`:

```json
{
  "name": "ultracode-local",
  "interface": {
    "displayName": "Ultracode Local"
  },
  "plugins": [
    {
      "name": "ultracode",
      "source": {
        "source": "local",
        "path": "./plugins/ultracode"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Then configure and install it:

```bash
codex plugin marketplace add <marketplace>
codex plugin add ultracode@ultracode-local
```

For a published marketplace, replace the local marketplace path and name with the publisher's values. Codex
plugins work in the CLI and the Codex surface in the ChatGPT desktop app; the Codex IDE extension does not
currently load plugins.
