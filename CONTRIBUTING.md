# Contributing to lpb-memory

lpb-memory is a persistent memory extension for Pi. It originated from
[chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)
but has been extensively refactored and is now fully independent.

This document explains how to contribute — whether by improving lpb-memory
directly, forking for your own stack, or feeding experiences back to the
community.

## Architecture Overview

```
Pi Session
  └─ Every 10 turns → Background Review (subprocess: pi -p)
                          ├─ Extract facts → Memory (Markdown + SQLite)
                          ├─ Detect corrections → Failure Memory
                          ├─ Discover patterns → Procedural Skills
                          └─ Consolidate if full → Merge entries
```

Key components:
- **Subprocess reviews** — run in child processes for context isolation
- **SQLite FTS5** — full-text search across sessions and memories
- **Markdown storage** — human-readable, git-tracked memory files
- **Secret scanning** — blocks API keys, tokens, SSH keys from persistence
- **Two-tier storage** — global (`~/.pi/agent/`) + per-project

## Development

### Setup

```bash
git clone https://github.com/localpibox/lpb-memory.git
cd lpb-memory
npm install
npm run check
npm test
```

### Local testing

```bash
# Load as a development extension
pi -e /path/to/lpb-memory/src/index.ts

# Or symlink into extensions
ln -s /path/to/lpb-memory ~/.pi/agent/extensions/lpb-memory
```

### Making changes

1. Make your changes in a feature branch
2. Run `npm run check` and `npm test`
3. Test with `pi -e ./src/index.ts`
4. Push and open a PR against `main`

## Forking for Your Own Stack

If you want to customize the memory extension:

1. **Fork** `localpibox/lpb-memory` to your own GitHub account
2. **Customize** — adjust review frequency, storage paths, scanning rules,
   or add new memory categories
3. **Install** from your fork:
   ```bash
   pi install git:github.com/<you>/lpb-memory@<your-branch>
   ```
4. **Repoint** any existing installation:
   ```bash
   pi remove git:github.com/localpibox/lpb-memory
   pi install git:github.com/<you>/lpb-memory@<your-branch>
   ```

### Common customizations

- **Review transport** — switch to `"inline"` if subprocess mode doesn't work
  for your setup
- **Model override** — pin reviews to a specific model for consistent behavior
- **Memory categories** — add custom categories for your team's conventions
- **Secret scanning patterns** — extend the scanner for organization-specific
  token formats

## Feeding Back to the Community

If you discover patterns or improvements that would benefit other users:

1. **Document what works** — if a configuration or customization proves
   reliable, share it
2. **Open an issue** on `localpibox/lpb-memory` describing your use case and
   the improvement
3. **Submit a PR** with your changes — keep them focused and well-tested

### Reporting local experiences

The LocalPibox project values feedback about what works reliably in local LLM
setups. If you run the stack on different hardware, with different models, or
in different configurations, please share:

- **Hardware** — CPU, memory, GPU/NPU configuration
- **Models** — which models you tested, sizes, quantizations
- **Behavior** — what worked well, what broke, what you had to adjust
- **Configuration** — settings that made things reliable

You can share via:
- **GitHub Issues** — [localpibox/lpb-memory/issues](https://github.com/localpibox/lpb-memory/issues)
- **GitHub Discussions** — general stack: [localpibox/localpibox](https://github.com/localpibox/localpibox)

## Reporting Issues

- **Extension bugs** → [localpibox/lpb-memory/issues](https://github.com/localpibox/lpb-memory/issues)
- **Original Hermes Memory** → [chandra447/pi-hermes-memory/issues](https://github.com/chandra447/pi-hermes-memory/issues)
- **Stack configuration** → [localpibox/devstack/issues](https://github.com/localpibox/devstack/issues)

## Communication

- [Pi Discord](https://discord.com/invite/3cU7Bz4UPx) — upstream Pi community
- Issues and PRs on GitHub — preferred for technical discussions
