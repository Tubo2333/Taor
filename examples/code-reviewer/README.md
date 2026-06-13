# Code Reviewer Agent — Harness Engine Example

A real-world example agent that demonstrates the Harness Engine framework's core capabilities:
**tools**, **multi-turn conversations**, **HITL (Human-In-The-Loop) approval**, and **hooks**.

## What It Does

The agent reviews source code in a given directory:
1. Searches for common issues using `grep` (regex pattern search)
2. Reads relevant files using `read_file`
3. Proposes fixes using `write_file` — **requires human approval** before writing

A token budget hook monitors costs and aborts if estimated spend exceeds $5.

## Quick Start (3 Steps)

### Step 1: Install Dependencies

```bash
# From the project root:
npm install

# Set your API key (Anthropic or OpenAI):
export ANTHROPIC_API_KEY=sk-ant-...
# OR
export OPENAI_API_KEY=sk-...
```

### Step 2: Run the Agent

```bash
# Review the Harness Engine core:
npx tsx examples/code-reviewer/agent.ts --dir ./packages/core/src

# With a custom review prompt:
npx tsx examples/code-reviewer/agent.ts --dir ./packages/core/src --prompt "Find all places where errors are swallowed silently"

# Using OpenAI instead of Anthropic:
npx tsx examples/code-reviewer/agent.ts --dir ./packages/core/src --model gpt-5
```

### Step 3: Verify Output

The agent runs for at most **3 turns**. You should see:

1. **Turn 1**: Agent reads the directory structure and searches for patterns
2. **Turn 2**: Agent reads interesting files and identifies issues
3. **Turn 3**: Agent summarizes findings and optionally proposes fixes

Expected console output:
```
╔══════════════════════════════════════════════════════════╗
║  Code Reviewer Agent — Harness Engine v0.2.0            ║
╠══════════════════════════════════════════════════════════╣
║  Model:     claude-sonnet-4-6                            ║
║  Directory: ./packages/core/src                          ║
║  Max turns: 3                                            ║
║  Tools:     read_file, grep, write_file (HITL)           ║
╚══════════════════════════════════════════════════════════╝

Starting code review...

💭 I'll start by searching for common issues in the codebase...
🔧 Calling: grep
   ✅ Found 5 match(es) in 12 files: ...
💭 Let me read the relevant files to understand the context...
🔧 Calling: read_file
   ✅ File: packages/core/src/harness.ts (200 lines)
...
--- Turn 1/3 complete ---
...
============================================================
Review complete.
  Turns:      3
  Tool calls: 5 (grep, read_file, write_file)
  Token usage: input=1500, output=800
============================================================
```

## Architecture

```
examples/code-reviewer/
├── agent.ts           — Main entry point: createHarness + review loop
├── tools/
│   ├── read-file.ts   — Read file contents (fs-read, low risk)
│   ├── grep.ts        — Search with regex patterns (fs-read, low risk)
│   └── write-file.ts  — Write file contents (fs-write, HIGH risk, HITL)
├── hooks/
│   └── budget.ts      — Token budget monitor ($5 limit)
└── README.md          — This file
```

## Key Concepts Demonstrated

| Concept | How It's Shown |
|---------|---------------|
| **Tool system** | `read_file`, `grep`, `write_file` — defined with `tool()` from `@harness/tools` |
| **Multi-turn** | Agent reads → searches → proposes across multiple TAOR loop iterations |
| **HITL approval** | `write_file` has `requiresApproval: true` — harness pauses and asks for human confirmation |
| **Hooks** | `createBudgetHook()` monitors token usage on `onTurnEnd` and aborts if >$5 |
| **createHarness()** | One-line setup with model, tools, hooks, session, and permission config |
| **TAOR loop** | `for await (const event of harness)` — async iteration over agent events |

## Requirements

- Node.js ≥ 20
- npm ≥ 9
- TypeScript ≥ 5.7
- Anthropic API key OR OpenAI API key
