#!/usr/bin/env bash
# bin/wakeup.sh — Cron entry point for headless persona wakeup
# Usage: wakeup.sh [persona-name]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PERSONA_NAME="${1:-example}"
PERSONA_DIR="$ROOT_DIR/personas/$PERSONA_NAME"

# Verify persona exists
if [ ! -f "$PERSONA_DIR/persona.yaml" ]; then
  echo "Error: persona '$PERSONA_NAME' not found at $PERSONA_DIR" >&2
  exit 1
fi

# Load credentials
source "$SCRIPT_DIR/load-credentials.sh"

# Sync latest
cd "$ROOT_DIR"
git pull --ff-only origin main 2>/dev/null || true

# Read config values (model, budget, max-turns)
MODEL=$(grep '^model:' "$PERSONA_DIR/persona.yaml" | awk '{print $2}' | tr -d '"')
BUDGET=$(grep 'max_budget_usd:' "$PERSONA_DIR/persona.yaml" | awk '{print $2}')
PROMPT_FILE=$(grep -A2 '^wakeup:' "$PERSONA_DIR/persona.yaml" | grep 'prompt:' | awk '{print $2}')

MODEL="${MODEL:-claude-sonnet-4-6}"
BUDGET="${BUDGET:-6}"
PROMPT_FILE="${PROMPT_FILE:-prompts/wakeup.md}"

# Assemble prompt
PROMPT=$("$SCRIPT_DIR/assemble-prompt" "$PERSONA_DIR" "$PROMPT_FILE")

# Create log directory
LOG_DIR="$ROOT_DIR/log"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${PERSONA_NAME}-$(date -u +%Y-%m-%d-%H%M).log"

# Run headless
echo "[$(date -u)] Waking up $PERSONA_NAME" | tee "$LOG_FILE"

claude -p "$PROMPT" \
  --model "$MODEL" \
  --max-turns 50 \
  --max-budget-usd "$BUDGET" \
  --allowedTools "Bash Read Write" \
  2>&1 | tee -a "$LOG_FILE"

echo "[$(date -u)] Session complete" | tee -a "$LOG_FILE"

# Push memory changes
cd "$ROOT_DIR"
if git diff --quiet "personas/$PERSONA_NAME/memory/" 2>/dev/null; then
  echo "No memory changes."
else
  git add "personas/$PERSONA_NAME/memory/"
  git commit -m "memory: $PERSONA_NAME session $(date -u +%Y-%m-%d-%H%M)"
  git push origin main
fi
